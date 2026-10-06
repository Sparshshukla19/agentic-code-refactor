import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { runTests } from "../src/sandbox/testRunner.js";

const mathUtilsPath = path.resolve("test-target/src/mathUtils.js");
const originalMathUtils = fs.readFileSync(mathUtilsPath, "utf-8");

describe("runTests", () => {
  afterEach(() => {
    fs.writeFileSync(mathUtilsPath, originalMathUtils);
  });

  it("reports success for the real, currently-passing test suite", async () => {
    const result = await runTests({ cwd: path.resolve("test-target") });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  }, 20000);

  it("catches a real failing test with the correct test name and error message", async () => {
    const broken = originalMathUtils.replace(
      "return total / numbers.length;",
      "return total / numbers.length + 999; // deliberate bug for testing",
    );
    fs.writeFileSync(mathUtilsPath, broken);

    const result = await runTests({ cwd: path.resolve("test-target") });
    expect(result.passed).toBe(false);
    expect(result.failures?.length).toBeGreaterThan(0);
    expect(result.failures?.[0].testName).toContain("computes average");
    expect(result.failures?.[0].errorMessage).toContain("toBeCloseTo");
  }, 20000);

  it("marks timedOut runs as failed rather than hanging", async () => {
    const result = await runTests({ cwd: path.resolve("test-target"), timeoutMs: 1 });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(-1);
  }, 10000);
});