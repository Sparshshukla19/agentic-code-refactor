import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { lintFile } from "../src/sandbox/linterRunner.js";

describe("lintFile", () => {
  it("flags var usage as an error in the real mathUtils.js sample", async () => {
    const result = await lintFile(path.resolve("test-target/src/mathUtils.js"));
    expect(result.passed).toBe(false);
    expect(result.violations?.some((v) => v.ruleId === "no-var")).toBe(true);
    expect(result.violations?.every((v) => v.severity === "error" || v.ruleId !== "no-var")).toBe(true);
  });

  it("reports the correct line numbers for violations", async () => {
    const result = await lintFile(path.resolve("test-target/src/mathUtils.js"));
    const varViolations = result.violations?.filter((v) => v.ruleId === "no-var") ?? [];
    expect(varViolations.map((v) => v.line).sort((a, b) => a - b)).toEqual([9, 10]);
  });

  it("passes clean code with no violations", async () => {
    const result = await lintFile(path.resolve("test-target/src/legacyCallback.js"));
    // legacyCallback.js doesn't use var — may still have warnings, but no errors
    const errorViolations = result.violations?.filter((v) => v.severity === "error") ?? [];
    expect(errorViolations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("actually lints a file outside the process's working directory (ESLint 9 silently skipped these)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-outside-"));
    try {
      const file = path.join(dir, "a.js");
      fs.writeFileSync(file, "var x = 1;\n");
      const result = await lintFile(file);
      expect(result.skipped).toBeUndefined();
      expect(result.passed).toBe(false);
      expect(result.violations?.some((v) => v.ruleId === "no-var")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a file type it has no configuration for as SKIPPED, not as clean", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-ts-"));
    try {
      const file = path.join(dir, "a.ts");
      fs.writeFileSync(file, "const x: number = 1;\n");
      const result = await lintFile(file);
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(true); // doesn't block the task
      expect(result.rawOutput).toContain("Lint skipped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});