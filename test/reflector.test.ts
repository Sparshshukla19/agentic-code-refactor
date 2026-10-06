import { describe, expect, it } from "vitest";
import { combineStageResults, extractErrorMessages, recordAttempt, shouldRetry, startReflection } from "../src/sandbox/reflector.js";
import type { StageResult } from "../src/types/verification.types.js";
import type { RefactorPatch } from "../src/types/agent.types.js";

const passingTypecheck: StageResult = { stage: "typecheck", passed: true, exitCode: 0, rawOutput: "No type errors." };
const failingTypecheck: StageResult = {
  stage: "typecheck",
  passed: false,
  exitCode: 1,
  diagnostics: [{ code: "TS2345", message: "bad arg type", filePath: "a.ts", line: 4 }],
  rawOutput: "a.ts:4 — TS2345: bad arg type",
};
const failingLint: StageResult = {
  stage: "lint",
  passed: false,
  exitCode: 1,
  violations: [{ ruleId: "no-var", message: "Unexpected var", filePath: "a.ts", line: 2, severity: "error" }],
  rawOutput: "a.ts:2 — [error] no-var: Unexpected var",
};
const failingTest: StageResult = {
  stage: "test",
  passed: false,
  exitCode: 1,
  failures: [{ testName: "adds numbers", filePath: "a.test.ts", errorMessage: "expected 3, got 4", stackTrace: "..." }],
  rawOutput: "adds numbers failed",
};

describe("combineStageResults", () => {
  it("is overallPassed when every stage passes", () => {
    const result = combineStageResults("task-0", [passingTypecheck]);
    expect(result.overallPassed).toBe(true);
  });

  it("is NOT overallPassed if any one stage fails", () => {
    const result = combineStageResults("task-0", [passingTypecheck, failingLint]);
    expect(result.overallPassed).toBe(false);
  });
});

describe("extractErrorMessages", () => {
  it("includes typecheck diagnostics from a failed stage", () => {
    const messages = extractErrorMessages(combineStageResults("t", [failingTypecheck]));
    expect(messages.some((m) => m.includes("TS2345") && m.includes("bad arg type"))).toBe(true);
  });

  it("includes lint violations from a failed stage", () => {
    const messages = extractErrorMessages(combineStageResults("t", [failingLint]));
    expect(messages.some((m) => m.includes("no-var"))).toBe(true);
  });

  it("includes test failures from a failed stage", () => {
    const messages = extractErrorMessages(combineStageResults("t", [failingTest]));
    expect(messages.some((m) => m.includes("adds numbers") && m.includes("expected 3, got 4"))).toBe(true);
  });

  it("excludes a passing stage's content entirely", () => {
    const messages = extractErrorMessages(combineStageResults("t", [passingTypecheck, failingLint]));
    expect(messages.every((m) => !m.includes("No type errors"))).toBe(true);
  });

  it("combines messages from multiple failing stages in one list", () => {
    const messages = extractErrorMessages(combineStageResults("t", [failingTypecheck, failingLint, failingTest]));
    expect(messages).toHaveLength(3);
  });
});

describe("reflection state machine", () => {
  const patch: RefactorPatch = { taskId: "t", targetNodeId: "n", newSourceText: "function f() {}", explanation: "fixed" };

  it("starts with zero attempts", () => {
    const state = startReflection("t", 3);
    expect(state.attempts).toHaveLength(0);
    expect(state.maxRetries).toBe(3);
  });

  it("shouldRetry is false before any attempt has been made", () => {
    expect(shouldRetry(startReflection("t", 3))).toBe(false);
  });

  it("shouldRetry is true after a failed attempt with retries remaining", () => {
    const state = recordAttempt(startReflection("t", 3), patch, ["some error"], false);
    expect(shouldRetry(state)).toBe(true);
  });

  it("shouldRetry is false once a succeeded attempt is recorded", () => {
    const state = recordAttempt(startReflection("t", 3), patch, [], true);
    expect(shouldRetry(state)).toBe(false);
    expect(state.finalStatus).toBe("verified");
  });

  it("shouldRetry is false once maxRetries failed attempts are recorded, and finalStatus becomes exhausted", () => {
    let state = startReflection("t", 2);
    state = recordAttempt(state, patch, ["err1"], false);
    expect(shouldRetry(state)).toBe(true);
    state = recordAttempt(state, patch, ["err2"], false);
    expect(shouldRetry(state)).toBe(false);
    expect(state.finalStatus).toBe("exhausted");
  });

  it("accumulates attempt history across multiple recordAttempt calls", () => {
    let state = startReflection("t", 3);
    state = recordAttempt(state, patch, ["err1"], false);
    state = recordAttempt(state, patch, ["err2"], false);
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts[0].attemptNumber).toBe(1);
    expect(state.attempts[1].attemptNumber).toBe(2);
  });
});