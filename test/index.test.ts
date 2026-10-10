import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

vi.mock("../src/agent/reactLoop.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/reactLoop.js")>("../src/agent/reactLoop.js");
  return { ...actual, runRefactorTask: vi.fn() };
});

const { runRefactorTask } = await import("../src/agent/reactLoop.js");
const { runPipeline } = await import("../src/index.js");

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-e2e-"));
  execSync("git init -q", { cwd: tmpDir });
  execSync("git config user.email test@test.com", { cwd: tmpDir });
  execSync("git config user.name Test", { cwd: tmpDir });

  filePath = path.join(tmpDir, "sample.js");
  // One deliberately small, single-smell function, low enough LOC that it
  // needs minRefactorScore: 0 to get scheduled at all under the default
  // threshold — intentional, since this test is about wiring, not scoring.
  fs.writeFileSync(filePath, "function add(a, b) {\n  return a + b;\n}\n");
  execSync("git add . && git commit -q -m initial", { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runPipeline — end to end (LLM call mocked, everything else real)", () => {
  it("applies a verified patch to the real file, commits it, and returns a diff report", async () => {
    vi.mocked(runRefactorTask).mockResolvedValue({
      tool: "propose_patch",
      payload: {
        taskId: "task-0",
        targetNodeId: `${filePath}::add`,
        newSourceText: "function add(a, b) {\n  return a + b; // patched by test\n}",
        explanation: "Added a comment (stand-in for a real fix).",
      },
    });

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0 });

    expect(result.taskOutcomes).toHaveLength(1);
    expect(result.taskOutcomes[0].passed).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toContain("patched by test");
    expect(result.branchName).toMatch(/^agent\/refactor-/);
    expect(result.diffReport).toContain("patched by test");
    expect(result.diffReport).toContain("Token Efficiency");
  });

  it("retries with real verification error feedback when the first patch is invalid TypeScript, then succeeds", async () => {
    vi.mocked(runRefactorTask)
      .mockResolvedValueOnce({
        tool: "propose_patch",
        payload: {
          taskId: "task-0",
          targetNodeId: `${filePath}::add`,
          // deliberately broken: references an undefined variable
          newSourceText: "function add(a, b) {\n  return a + b + thisVariableDoesNotExist;\n}",
          explanation: "First attempt (deliberately broken).",
        },
      })
      .mockResolvedValueOnce({
        tool: "propose_patch",
        payload: {
          taskId: "task-0",
          targetNodeId: `${filePath}::add`,
          newSourceText: "function add(a, b) {\n  return a + b;\n}",
          explanation: "Corrected attempt.",
        },
      });

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, maxRetries: 3 });

    expect(runRefactorTask).toHaveBeenCalledTimes(2);
    expect(result.taskOutcomes[0].passed).toBe(true);
    // The second call's priorTurns should contain real error feedback from
    // the FIRST attempt's actual typecheck failure — proving real
    // verification output reached the retry, not a stub.
    const secondCallArgs = vi.mocked(runRefactorTask).mock.calls[1];
    const priorTurns = secondCallArgs[2]?.priorTurns ?? [];
    expect(priorTurns.length).toBeGreaterThan(0);
    expect(priorTurns.some((t) => t.content.includes("thisVariableDoesNotExist"))).toBe(true);
  });

  it("marks a task failed (not thrown) once retries are exhausted on a persistently broken patch", async () => {
    vi.mocked(runRefactorTask).mockResolvedValue({
      tool: "propose_patch",
      payload: {
        taskId: "task-0",
        targetNodeId: `${filePath}::add`,
        newSourceText: "function add(a, b) {\n  return a + alwaysBroken;\n}",
        explanation: "Always broken.",
      },
    });

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, maxRetries: 2 });

    expect(runRefactorTask).toHaveBeenCalledTimes(2); // 1 initial + 1 retry, then exhausted
    expect(result.taskOutcomes[0].passed).toBe(false);
  });

  it("skips all git operations when skipGit is true, but still applies the patch", async () => {
    vi.mocked(runRefactorTask).mockResolvedValue({
      tool: "propose_patch",
      payload: {
        taskId: "task-0",
        targetNodeId: `${filePath}::add`,
        newSourceText: "function add(a, b) {\n  return a + b; // no git\n}",
        explanation: "x",
      },
    });

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, skipGit: true });

    expect(result.branchName).toBeUndefined();
    expect(result.diffReport).toBeUndefined();
    expect(fs.readFileSync(filePath, "utf-8")).toContain("no git");
  });

  it("schedules zero tasks and makes zero LLM calls when minRefactorScore is left at its strict default", async () => {
    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath] }); // no override — tiny function won't clear 15
    expect(runRefactorTask).not.toHaveBeenCalled();
    expect(result.taskOutcomes).toHaveLength(0);
  });

  it("restores the file and leaves the git tree clean when a task ends unverified", async () => {
    const original = fs.readFileSync(filePath, "utf-8");
    vi.mocked(runRefactorTask).mockResolvedValue({
      tool: "propose_patch",
      payload: { taskId: "task-0", targetNodeId: `${filePath}::add`, newSourceText: "function add(a, b) {\n  return a + alwaysBroken;\n}", explanation: "x" },
    });

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, maxRetries: 2 });

    expect(result.taskOutcomes[0].passed).toBe(false);
    expect(result.taskOutcomes[0].note).toContain("verification failed after 2 attempt(s)");
    expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
    expect(execSync("git status --porcelain", { cwd: tmpDir }).toString().trim()).toBe("");
  });

  it("applies every retry to the ORIGINAL file, so a failed attempt that renamed the function can't strand the retry", async () => {
    vi.mocked(runRefactorTask)
      .mockResolvedValueOnce({
        tool: "propose_patch",
        payload: { taskId: "task-0", targetNodeId: `${filePath}::add`, newSourceText: "function addRenamed(a, b) {\n  return a + b + undefinedThing;\n}", explanation: "renamed + broken" },
      })
      .mockResolvedValueOnce({
        tool: "propose_patch",
        payload: { taskId: "task-0", targetNodeId: `${filePath}::add`, newSourceText: "function add(a, b) {\n  return a + b; // fixed\n}", explanation: "fixed" },
      });

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, skipGit: true });

    expect(result.taskOutcomes[0].passed).toBe(true);
    const finalText = fs.readFileSync(filePath, "utf-8");
    expect(finalText).toContain("// fixed");
    expect(finalText).not.toContain("addRenamed");
  });

  it("records the agent's reason and leaves the file untouched when it aborts", async () => {
    const original = fs.readFileSync(filePath, "utf-8");
    vi.mocked(runRefactorTask).mockResolvedValue({ tool: "abort_task", payload: { reason: "unsafe to change" } });

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, skipGit: true });

    expect(runRefactorTask).toHaveBeenCalledTimes(1);
    expect(result.taskOutcomes[0].passed).toBe(false);
    expect(result.taskOutcomes[0].note).toContain("aborted: unsafe to change");
    expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("restores the file if the LLM call itself throws mid-task, then rethrows", async () => {
    const original = fs.readFileSync(filePath, "utf-8");
    vi.mocked(runRefactorTask)
      .mockResolvedValueOnce({
        tool: "propose_patch",
        payload: { taskId: "task-0", targetNodeId: `${filePath}::add`, newSourceText: "function add(a, b) {\n  return a + brokenRef;\n}", explanation: "x" },
      })
      .mockRejectedValueOnce(new Error("API unavailable"));

    await expect(
      runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, skipGit: true, maxRetries: 3 }),
    ).rejects.toThrow("API unavailable");

    expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("builds a later task's context from the file as already fixed by an earlier task", async () => {
    fs.writeFileSync(
      filePath,
      "function helperA(x) {\n  var y = x + 1;\n  var z = y * 2;\n  return z;\n}\n\nfunction useA(x) {\n  return helperA(x);\n}\n",
    );
    vi.mocked(runRefactorTask).mockImplementation(async (objective) =>
      objective.targetNodeId.endsWith("::helperA")
        ? {
            tool: "propose_patch",
            payload: { taskId: objective.taskId, targetNodeId: objective.targetNodeId, newSourceText: "function helperA(x) {\n  const y = x + 1; // patched A\n  return y * 2;\n}", explanation: "x" },
          }
        : {
            tool: "propose_patch",
            payload: { taskId: objective.taskId, targetNodeId: objective.targetNodeId, newSourceText: "function useA(x) {\n  return helperA(x);\n}", explanation: "x" },
          },
    );

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, skipGit: true });

    expect(result.taskOutcomes.every((t) => t.passed)).toBe(true);
    const calls = vi.mocked(runRefactorTask).mock.calls;
    expect(calls[0][0].targetNodeId.endsWith("::helperA")).toBe(true);
    expect(calls[1][0].contextSlice).toContain("// patched A");
  });

  it("reports progress through onProgress", async () => {
    vi.mocked(runRefactorTask).mockResolvedValue({
      tool: "propose_patch",
      payload: { taskId: "task-0", targetNodeId: `${filePath}::add`, newSourceText: "function add(a, b) {\n  return a + b; // p\n}", explanation: "x" },
    });
    const messages: string[] = [];

    await runPipeline({ targetDir: tmpDir, filePaths: [filePath], minRefactorScore: 0, onProgress: (m) => messages.push(m) });

    expect(messages.some((m) => m.includes("Created branch"))).toBe(true);
    expect(messages.some((m) => m.includes("verified"))).toBe(true);
  });
});