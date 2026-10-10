/**
 * Types for the neurosymbolic generation layer: the ReAct loop,
 * its tool-call contract, and reflection retry state.
 */

export interface RefactorObjective {
  taskId: string;
  targetNodeId: string;
  instruction: string; // e.g. "Add strict types and replace callback with async/await"
  contextSlice: string; // minimal source scope from planner/contextSlicer.ts
}

export interface RefactorPatch {
  taskId: string;
  targetNodeId: string;
  newSourceText: string;
  explanation: string;
}

export type AgentToolName = "propose_patch" | "request_more_context" | "abort_task";

/**
 * A proper discriminated union on `tool` — this matters, not just style:
 * without it, TypeScript can't narrow `payload`'s type after checking
 * `tool`, even though toolSchemas.ts's Zod schema (which this mirrors)
 * enforces exactly this relationship at runtime. index.ts's orchestrator
 * needs the narrowing to safely access `payload.newSourceText` only once
 * `tool === "propose_patch"` is confirmed.
 */
export type AgentToolCall =
  | { tool: "propose_patch"; payload: RefactorPatch }
  | { tool: "request_more_context"; payload: { reason: string } }
  | { tool: "abort_task"; payload: { reason: string } };

export interface ReflectionAttempt {
  attemptNumber: number;
  patch: RefactorPatch;
  verificationErrors: string[]; // raw diagnostics fed back into the next prompt
  succeeded: boolean;
}

export interface ReflectionState {
  taskId: string;
  attempts: ReflectionAttempt[];
  maxRetries: number;
  finalStatus: "verified" | "exhausted" | "aborted";
}