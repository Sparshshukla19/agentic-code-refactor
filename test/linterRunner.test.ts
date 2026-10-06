import { describe, expect, it } from "vitest";
import path from "node:path";
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
});