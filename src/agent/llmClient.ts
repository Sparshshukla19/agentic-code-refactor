/**
 * LLM client configuration, provider-agnostic. Supports Anthropic (Claude),
 * OpenAI (GPT), and Google (Gemini) — the Vercel AI SDK gives every
 * provider the same generateObject() interface, so swapping providers is
 * a config change, not a rewrite. Two token/cost-optimization techniques
 * are wired in regardless of provider:
 *
 * 1. Model routing — a function only gets routed to the CAPABLE (pricier)
 *    tier when it actually needs the extra reasoning: deep branching/
 *    nested callbacks, or more than one distinct issue at once. Everything
 *    else — the common case — goes to the CHEAP tier.
 * 2. Prompt caching — ANTHROPIC ONLY. Anthropic requires explicit
 *    cache_control markers to cache a prompt prefix; OpenAI and Google
 *    cache automatically server-side with no markers needed, so this SDK
 *    call only attaches cacheControl when the active provider is
 *    Anthropic. Attaching it for the other providers would do nothing
 *    (they'd just ignore an option meant for a different provider) but
 *    it's cleaner not to claim a behavior that isn't actually happening.
 *
 * MODEL NAMES: Anthropic's two tiers default to real, verified model IDs.
 * OpenAI and Google's do NOT have defaults — model naming across both
 * providers changes too often, and recent web search on this came back
 * with visibly unreliable/contradictory results, so guessing a "current"
 * name here would risk silently shipping a wrong or nonexistent model ID.
 * Set LLM_MODEL_CHEAP / LLM_MODEL_CAPABLE yourself for those providers —
 * check the provider's own current model list, not this comment.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { AgentToolCall, RefactorObjective } from "../types/agent.types.js";
import type { ParsedNode } from "../types/ast.types.js";
import { AgentToolCallSchema } from "./toolSchemas.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompts.js";

export type LlmProvider = "anthropic" | "openai" | "google";
export type ModelTier = "cheap" | "capable";

const PROVIDER = (process.env.LLM_PROVIDER as LlmProvider | undefined) ?? "anthropic";

const ANTHROPIC_DEFAULTS: Record<ModelTier, string> = {
  cheap: "claude-haiku-4-5-20251001",
  capable: "claude-sonnet-5",
};

function resolveModelId(tier: ModelTier): string {
  const envVar = tier === "cheap" ? "LLM_MODEL_CHEAP" : "LLM_MODEL_CAPABLE";
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  if (PROVIDER === "anthropic") return ANTHROPIC_DEFAULTS[tier];

  throw new Error(
    `${envVar} is not set. There is no default model ID for provider "${PROVIDER}" — ` +
      `model naming changes too often to guess reliably. Check ${PROVIDER}'s current model ` +
      `list and set ${envVar} in your .env file.`,
  );
}

function getModel(tier: ModelTier): LanguageModel {
  const modelId = resolveModelId(tier);
  switch (PROVIDER) {
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    case "anthropic":
    default:
      return anthropic(modelId);
  }
}

function requiredApiKeyEnvVar(): string {
  switch (PROVIDER) {
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    case "anthropic":
    default:
      return "ANTHROPIC_API_KEY";
  }
}

// A node needs the CAPABLE tier if it's flagged as structurally complex on
// its own (high-complexity or callback-hell), OR if it has enough distinct
// issues at once that juggling them correctly benefits from stronger
// reasoning — even if no single issue is individually hard.
const MULTI_ISSUE_THRESHOLD = 2;

export function pickModelTier(node: Pick<ParsedNode, "complexity" | "smells">): ModelTier {
  const needsDeepReasoning = node.smells.some((s) => s.type === "high-complexity" || s.type === "callback-hell");
  const isMultiIssue = node.smells.length >= MULTI_ISSUE_THRESHOLD;
  return needsDeepReasoning || isMultiIssue ? "capable" : "cheap";
}

/** One extra turn in a retried conversation — see reactLoop.buildRetryTurns(). */
export interface ConversationTurn {
  role: "assistant" | "user";
  content: string;
}

/**
 * Calls the configured LLM provider with the objective for one refactor
 * task and returns a schema-validated AgentToolCall. `priorTurns` lets a
 * retry CONTINUE the same conversation (the previous patch + what broke)
 * instead of rebuilding the prompt from scratch — see reactLoop.ts.
 */
export async function generateRefactorPatch(
  objective: RefactorObjective,
  tier: ModelTier,
  priorTurns: ConversationTurn[] = [],
): Promise<AgentToolCall> {
  const apiKeyVar = requiredApiKeyEnvVar();
  if (!process.env[apiKeyVar]) {
    throw new Error(`${apiKeyVar} is not set — required for LLM_PROVIDER="${PROVIDER}". See .env.example.`);
  }

  const systemMessage =
    PROVIDER === "anthropic"
      ? { role: "system" as const, content: SYSTEM_PROMPT, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
      : { role: "system" as const, content: SYSTEM_PROMPT };

  const userMessage =
    PROVIDER === "anthropic"
      ? { role: "user" as const, content: buildUserMessage(objective), providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
      : { role: "user" as const, content: buildUserMessage(objective) };

  const { object } = await generateObject({
    model: getModel(tier),
    schema: AgentToolCallSchema,
    messages: [systemMessage, userMessage, ...priorTurns],
  });

  return object;
}