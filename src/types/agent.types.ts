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

export interface AgentToolCall {
  tool: AgentToolName;
  payload: RefactorPatch | { reason: string };
}

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
