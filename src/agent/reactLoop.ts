/**
 * Core ReAct controller for one refactor task.
 */
import type { AgentToolCall, RefactorObjective, RefactorPatch } from "../types/agent.types.js";
import type { ParsedNode } from "../types/ast.types.js";
import { generateRefactorPatch, pickModelTier, type CallHooks, type ConversationTurn } from "./llmClient.js";
import { buildRetryFeedback } from "./prompts.js";

const SECRET_PATTERNS: RegExp[] = [
  /sk-(ant-)?[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{15,}/g,
  /(['"])[A-Za-z0-9+/]{32,}={0,2}\1/g,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[REDACTED]"), text);
}

export interface RunRefactorTaskOptions extends CallHooks {
  priorTurns?: ConversationTurn[];
}

export async function runRefactorTask(
  objective: RefactorObjective,
  node: Pick<ParsedNode, "complexity" | "smells">,
  options: RunRefactorTaskOptions = {},
): Promise<AgentToolCall> {
  const safeObjective: RefactorObjective = {
    ...objective,
    contextSlice: redactSecrets(objective.contextSlice),
  };
  const tier = pickModelTier(node);
  const toolCall = await generateRefactorPatch(safeObjective, tier, options.priorTurns ?? [], { onRetry: options.onRetry, onUsage: options.onUsage });
  if (toolCall.tool !== "propose_patch") return toolCall;
  // The model is asked to echo these ids but can't be trusted to: a real
  // Gemini reply used taskId "task-1" and targetNodeId "target". The
  // orchestrator knows the true values, so they're stamped on here — which
  // also keeps retry conversations from carrying wrong ids forward.
  return { tool: "propose_patch", payload: { ...toolCall.payload, taskId: objective.taskId, targetNodeId: objective.targetNodeId } };
}

export function buildRetryTurns(previousPatch: RefactorPatch, errors: string[]): ConversationTurn[] {
  return [
    { role: "assistant", content: JSON.stringify({ tool: "propose_patch", payload: previousPatch }) },
    { role: "user", content: buildRetryFeedback(previousPatch.explanation, errors) },
  ];
}