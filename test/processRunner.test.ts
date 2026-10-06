import { describe, expect, it } from "vitest";
import { runCommand } from "../src/sandbox/processRunner.js";

describe("runCommand", () => {
  it("captures stdout and a zero exit code for a successful command", async () => {
    const result = await runCommand("echo", ["hello world"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
    expect(result.timedOut).toBe(false);
  });

  it("captures a non-zero exit code", async () => {
    const result = await runCommand("node", ["-e", "process.exit(7)"]);
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr output", async () => {
    const result = await runCommand("node", ["-e", "console.error('boom')"]);
    expect(result.stderr).toContain("boom");
  });

  it("kills a process that exceeds the timeout and marks timedOut", async () => {
    const result = await runCommand("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  }, 10000);

  it("resolves (does not throw) when the command itself doesn't exist", async () => {
    const result = await runCommand("this-command-does-not-exist-xyz", []);
    expect(result.exitCode).toBe(-1);
  });
});