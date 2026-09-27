/**
 * Core ReAct controller for one refactor task: redact anything secret-
 * looking from the context slice, pick the right model tier, call Claude,
 * and return a validated tool call. Retry support (buildRetryTurns) is
 * ready for the sandbox/reflector stage to drive once it's built — a
 * retry continues the SAME conversation rather than rebuilding the
 * prompt, so the cached prefix (system prompt + original context) is
 * reused instead of paid for again on every attempt.
 */
import type { AgentToolCall, RefactorObjective, RefactorPatch } from "../types/agent.types.js";
import type { ParsedNode } from "../types/ast.types.js";
import { generateRefactorPatch, pickModelTier, type ConversationTurn } from "./llmClient.js";
import { buildRetryFeedback } from "./prompts.js";

/**
 * Patterns for things that shouldn't leave the machine. Deliberately
 * over-inclusive: the cost of a false positive (redacting something that
 * wasn't actually secret, slightly reducing the LLM's context) is minor;
 * the cost of a false negative (a real key reaching a third-party API) is
 * not. When in doubt, these redact.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-(ant-)?[A-Za-z0-9_-]{20,}/g, // Anthropic/OpenAI-style API keys
  /AKIA[0-9A-Z]{16}/g, // AWS access key ID
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /Bearer\s+[A-Za-z0-9._-]{15,}/g, // Bearer auth headers
  /(['"])[A-Za-z0-9+/]{32,}={0,2}\1/g, // long base64-shaped quoted string literals
];

/** Strips anything secret-shaped from a piece of text before it leaves this machine. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[REDACTED]"), text);
}

export interface RunRefactorTaskOptions {
  priorTurns?: ConversationTurn[];
}

/** Runs one refactor task end-to-end: redact, route to a model tier, call, return the result. */
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
  return generateRefactorPatch(safeObjective, tier, options.priorTurns ?? []);
}

/** Builds the extra conversation turns a retry needs to append after a failed verification attempt. */
export function buildRetryTurns(previousPatch: RefactorPatch, errors: string[]): ConversationTurn[] {
  return [
    { role: "assistant", content: JSON.stringify({ tool: "propose_patch", payload: previousPatch }) },
    { role: "user", content: buildRetryFeedback(previousPatch.explanation, errors) },
  ];
}