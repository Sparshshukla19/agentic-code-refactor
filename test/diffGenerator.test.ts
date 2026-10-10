import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createRefactorBranch, commitFile, getCurrentBranch } from "../src/vcs/gitManager.js";
import { formatDiffReport, getUnifiedDiff } from "../src/vcs/diffGenerator.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diffgen-test-"));
  execSync("git init -q", { cwd: tmpDir });
  execSync("git config user.email test@test.com", { cwd: tmpDir });
  execSync("git config user.name Test", { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, "file.js"), "function add(a, b) { return a + b; }\n");
  execSync("git add . && git commit -q -m initial", { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getUnifiedDiff", () => {
  it("produces a real unified diff between the refactor branch and its base", async () => {
    const baseBranch = await getCurrentBranch(tmpDir);
    await createRefactorBranch(tmpDir, "task-0");
    fs.writeFileSync(path.join(tmpDir, "file.js"), "function add(a: number, b: number): number { return a + b; }\n");
    await commitFile(tmpDir, "file.js", "Add types");

    const diff = await getUnifiedDiff(tmpDir, baseBranch);
    expect(diff).toContain("-function add(a, b)");
    expect(diff).toContain("+function add(a: number, b: number): number");
  });

  it("is empty when the branch has no changes relative to base", async () => {
    const baseBranch = await getCurrentBranch(tmpDir);
    await createRefactorBranch(tmpDir, "task-0");
    const diff = await getUnifiedDiff(tmpDir, baseBranch);
    expect(diff.trim()).toBe("");
  });
});

describe("formatDiffReport", () => {
  it("includes the branch name, task outcomes, and the diff", () => {
    const report = formatDiffReport({
      branchName: "agent/refactor-123",
      baseBranch: "main",
      diff: "diff --git a/file.js b/file.js\n+added line",
      tasksSummary: [
        { taskId: "task-0", filePath: "a.js", passed: true },
        { taskId: "task-1", filePath: "b.js", passed: false },
      ],
    });
    expect(report).toContain("agent/refactor-123");
    expect(report).toContain("1/2 verified");
    expect(report).toContain("✅ `task-0`");
    expect(report).toContain("❌ `task-1`");
    expect(report).toContain("+added line");
  });

  it("includes a Token Efficiency section only when tokenSavings is provided", () => {
    const withSavings = formatDiffReport({
      branchName: "b", baseBranch: "main", diff: "", tasksSummary: [],
      tokenSavings: { fullFileChars: 100, sliceChars: 40, estimatedFullFileTokens: 25, estimatedSliceTokens: 10, reductionPercent: 60 },
    });
    expect(withSavings).toContain("Token Efficiency");
    expect(withSavings).toContain("60% smaller");

    const withoutSavings = formatDiffReport({ branchName: "b", baseBranch: "main", diff: "", tasksSummary: [] });
    expect(withoutSavings).not.toContain("Token Efficiency");
  });

  it("shows a placeholder when there is no diff content", () => {
    const report = formatDiffReport({ branchName: "b", baseBranch: "main", diff: "   ", tasksSummary: [] });
    expect(report).toContain("(no changes)");
  });

  it("shows a failed task's note next to it", () => {
    const report = formatDiffReport({
      branchName: "b", baseBranch: "main", diff: "",
      tasksSummary: [{ taskId: "task-0", filePath: "a.js", passed: false, note: "verification failed after 3 attempt(s)" }],
    });
    expect(report).toContain("verification failed after 3 attempt(s)");
  });
});