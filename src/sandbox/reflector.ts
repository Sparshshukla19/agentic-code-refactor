/**
 * Combines the three verification stages into one VerificationResult, and
 * turns a failure into the plain-string error feedback reactLoop.ts's
 * buildRetryTurns() already expects — the bridge between "the patch is
 * broken" and "here's what to tell the LLM about it."
 */
import type { StageResult, VerificationResult } from "../types/verification.types.js";
import type { ReflectionAttempt, ReflectionState, RefactorPatch } from "../types/agent.types.js";

/** Combines typecheck/lint/test stage results into one overall verdict for a task. */
export function combineStageResults(taskId: string, stages: StageResult[]): VerificationResult {
  return {
    taskId,
    stages,
    overallPassed: stages.every((s) => s.passed),
  };
}

/**
 * Flattens every failing stage's diagnostics/violations/failures into
 * plain strings — this is specifically the shape buildRetryTurns() in
 * reactLoop.ts feeds back to the LLM as "here's what broke." Only FAILED
 * stages contribute; a passing lint stage has nothing worth mentioning.
 */
export function extractErrorMessages(result: VerificationResult): string[] {
  const messages: string[] = [];

  for (const stage of result.stages) {
    if (stage.passed) continue;

    if (stage.diagnostics?.length) {
      messages.push(...stage.diagnostics.map((d) => `[typecheck] ${d.code} (line ${d.line}): ${d.message}`));
    }
    if (stage.violations?.length) {
      messages.push(
        ...stage.violations.filter((v) => v.severity === "error").map((v) => `[lint] ${v.ruleId} (line ${v.line}): ${v.message}`),
      );
    }
    if (stage.failures?.length) {
      messages.push(...stage.failures.map((f) => `[test] ${f.testName}: ${f.errorMessage}`));
    }
    // A stage can fail without any structured diagnostics (e.g. a timeout
    // or a tool crash) — fall back to its raw output so nothing is silently lost.
    if (!stage.diagnostics?.length && !stage.violations?.length && !stage.failures?.length) {
      messages.push(`[${stage.stage}] ${stage.rawOutput}`);
    }
  }

  return messages;
}

/** Starts a fresh ReflectionState for a task about to attempt its first patch. */
export function startReflection(taskId: string, maxRetries: number): ReflectionState {
  return { taskId, attempts: [], maxRetries, finalStatus: "verified" };
}

/**
 * Records one attempt's outcome. Returns a NEW state rather than mutating
 * — callers hold onto the previous state's attempt history for building
 * retry turns. NOTE: finalStatus here is only meaningful once
 * shouldRetry() says to stop — while retries remain, it's left as
 * whatever it was before and should be ignored by callers; it exists on
 * every state only because the type has no separate "in progress" value.
 * (abort_task — the LLM explicitly refusing — is a separate path the
 * orchestrator sets directly to "aborted"; there's no patch to record
 * for that case, so it doesn't go through this function.)
 */
export function recordAttempt(
  state: ReflectionState,
  patch: RefactorPatch,
  verificationErrors: string[],
  succeeded: boolean,
): ReflectionState {
  const attempt: ReflectionAttempt = {
    attemptNumber: state.attempts.length + 1,
    patch,
    verificationErrors,
    succeeded,
  };
  const attempts = [...state.attempts, attempt];

  const finalStatus: ReflectionState["finalStatus"] = succeeded
    ? "verified"
    : attempts.length >= state.maxRetries
      ? "exhausted"
      : state.finalStatus;

  return { ...state, attempts, finalStatus };
}

/** Whether another attempt should be made: not succeeded yet, and retries remain. */
export function shouldRetry(state: ReflectionState): boolean {
  const lastAttempt = state.attempts[state.attempts.length - 1];
  if (!lastAttempt || lastAttempt.succeeded) return false;
  return state.attempts.length < state.maxRetries;
}