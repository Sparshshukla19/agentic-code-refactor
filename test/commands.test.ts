import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { buildProgram, formatAnalysis } from "../src/cli/commands.js";

describe("formatAnalysis", () => {
  const output = formatAnalysis(path.resolve("test-target/src"));

  it("lists the production files but not the test files", () => {
    expect(output).toContain("mathUtils.js");
    expect(output).toContain("userController.js");
    expect(output).not.toContain("userController.test.js");
  });

  it("orders mathUtils before userController", () => {
    const orderSection = output.split("Findings")[0];
    expect(orderSection.indexOf("mathUtils.js")).toBeLessThan(orderSection.indexOf("userController.js"));
  });

  it("shows smells, scores, and whether each finding clears the threshold", () => {
    expect(output).toContain("callback-hell");
    expect(output).toContain("[will refactor]");
    expect(output).toContain("[below threshold]");
  });

  it("reports how many tasks would run and a token estimate", () => {
    expect(output).toMatch(/\d+ task\(s\) would run/);
    expect(output).toContain("tokens sent vs");
  });

  it("with a threshold of 0, schedules more tasks than the default", () => {
    const count = (text: string) => Number(/(\d+) task\(s\) would run/.exec(text)![1]);
    expect(count(formatAnalysis(path.resolve("test-target/src"), 0))).toBeGreaterThan(count(output));
  });
});

describe("buildProgram", () => {
  it("registers the analyze and run commands", () => {
    expect(buildProgram().commands.map((c) => c.name()).sort()).toEqual(["analyze", "run"]);
  });

  it("gives run the expected options", () => {
    const run = buildProgram().commands.find((c) => c.name() === "run")!;
    const flags = run.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(["--no-git", "--run-tests", "--max-retries", "--min-score"]));
  });
});

describe("run command safety checks", () => {
  let tmpDir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run-"));
    fs.writeFileSync(path.join(tmpDir, "a.js"), "function add(a, b) {\n  return a + b;\n}\n");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = undefined; // a failing command sets this; don't let it fail the test run itself
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const run = (...args: string[]) => buildProgram().parseAsync(["node", "autorefactor", "run", tmpDir, ...args]);
  const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join("\n");

  it("fails with a clear message, before touching anything, when no API key is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await run("--no-git");
    expect(errors()).toContain("ANTHROPIC_API_KEY");
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "a.js"), "utf-8")).toBe("function add(a, b) {\n  return a + b;\n}\n");
  });

  it("fails when the target directory has no analyzable files", async () => {
    fs.rmSync(path.join(tmpDir, "a.js"));
    process.env.ANTHROPIC_API_KEY = "test-key";
    await run("--no-git");
    expect(errors()).toContain("No analyzable");
    expect(process.exitCode).toBe(1);
  });

  it("refuses to run with git on when the target isn't a git repository", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    await run();
    expect(errors()).toContain("not inside a git repository");
    expect(process.exitCode).toBe(1);
  });

  it("refuses to branch off a working tree with uncommitted changes", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    execSync("git init -q", { cwd: tmpDir });
    execSync("git config user.email t@t.com && git config user.name T", { cwd: tmpDir });
    execSync("git add . && git commit -q -m init", { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "a.js"), "function add(a, b) {\n  return a + b + 1;\n}\n");
    await run();
    expect(errors()).toContain("uncommitted changes");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a non-numeric --max-retries", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    await run("--no-git", "--max-retries", "abc");
    expect(errors()).toContain("--max-retries");
    expect(process.exitCode).toBe(1);
  });
});