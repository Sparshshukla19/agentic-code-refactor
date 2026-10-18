/**
 * LLM client configuration, provider-agnostic (Anthropic/OpenAI/Google).
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

/**
 * Checks the LLM configuration WITHOUT making a call, returning a
 * human-readable problem or undefined if everything needed is present. The
 * CLI runs this first so a missing key is reported before any git branch is
 * created or file touched, rather than failing on the first task.
 */
export function getLlmConfigProblem(): string | undefined {
  const validProviders: string[] = ["anthropic", "openai", "google"];
  if (!validProviders.includes(PROVIDER)) {
    return `LLM_PROVIDER must be one of ${validProviders.join(", ")} (got "${PROVIDER}").`;
  }
  const keyVar = requiredApiKeyEnvVar();
  if (!process.env[keyVar]) {
    return `${keyVar} is not set (LLM_PROVIDER="${PROVIDER}"). Add it to your .env file — see .env.example.`;
  }
  if (PROVIDER !== "anthropic") {
    for (const modelVar of ["LLM_MODEL_CHEAP", "LLM_MODEL_CAPABLE"]) {
      if (!process.env[modelVar]) {
        return `${modelVar} is not set. ${PROVIDER} has no built-in default model — set it in your .env file.`;
      }
    }
  }
  return undefined;
}

/**
 * How many times the SDK retries a failed API call (with exponential
 * backoff) before giving up. The SDK's own default is 2, which is too few
 * for a free tier: this pipeline calls the model every few seconds, which
 * is faster than free-tier per-minute quotas allow, so rate-limit (429)
 * errors are expected and must be waited out, not treated as task failures.
 * A blank or invalid LLM_API_RETRIES falls back to the default of 5.
 */
function apiRetries(): number {
  const raw = process.env.LLM_API_RETRIES;
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 5;
}

/** Human-readable "provider/model" for a tier, for progress output. Never throws. */
export function describeModel(tier: ModelTier): string {
  try {
    return `${PROVIDER}/${resolveModelId(tier)}`;
  } catch {
    return PROVIDER;
  }
}

/**
 * Upper bound on ONE call, including all SDK retries/backoff. Without it, a
 * rate-limited free tier can leave the pipeline waiting silently for a very
 * long time. Blank or invalid LLM_TIMEOUT_MS falls back to 180 seconds.
 */
function timeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (!raw) return 180_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
}

/** Base delay for our own retry backoff (doubles each retry, capped at 60s). */
function retryBaseMs(): number {
  const n = Number(process.env.LLM_RETRY_BASE_MS);
  return process.env.LLM_RETRY_BASE_MS && Number.isFinite(n) && n >= 0 ? n : 2000;
}

export interface RetryInfo {
  attempt: number; // which retry this is (1-based)
  maxRetries: number;
  waitMs: number;
  reason: string;
}

/** Tokens the API actually billed for one successful call (not an estimate). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CallHooks {
  /** Called after each successful call with the provider-reported token counts. */
  onUsage?: (usage: TokenUsage) => void;
  /** Called just before waiting to retry, so the caller can tell the user WHY it is waiting. */
  onRetry?: (info: RetryInfo) => void;
}

interface ApiFailure {
  retryable: boolean;
  reason: string;
  waitMs?: number;
  /** Set when retrying cannot help; the message to fail with immediately. */
  fatalMessage?: string;
}

/**
 * Decides what to do about a failed API call. Duck-typed rather than using
 * the SDK's APICallError class so it works regardless of SDK version (and
 * under test mocks). Why we do our own retries instead of the SDK's: the
 * SDK waits silently, so a rate-limited run looked frozen with no clue why.
 * Doing it here lets us print the reason and, more importantly, stop at
 * once on errors that waiting can never fix.
 */
function classifyApiError(err: unknown): ApiFailure {
  const e = err as { statusCode?: number; isRetryable?: boolean; responseBody?: string; responseHeaders?: Record<string, string>; message?: string };
  const status = e.statusCode;
  const body = e.responseBody ?? "";
  const detail = (e.message ?? "unknown error").slice(0, 200);
  const retryable = e.isRetryable === true || (status !== undefined && [408, 409, 429, 500, 502, 503, 504].includes(status));
  if (!retryable) return { retryable: false, reason: detail };

  if (status === 429 && /limit:\s*0\b/.test(body)) {
    return {
      retryable: false,
      reason: detail,
      fatalMessage: `has no free-tier quota (the API reports a quota limit of 0). Choose a different model in LLM_MODEL_CHEAP / LLM_MODEL_CAPABLE. API said: ${detail}`,
    };
  }
  if (status === 429 && /PerDay/i.test(body)) {
    return {
      retryable: false,
      reason: detail,
      fatalMessage: `daily quota is used up, so waiting won't help. Wait for it to reset, or switch model/provider. API said: ${detail}`,
    };
  }

  // Prefer the server's own instruction about how long to wait.
  let waitMs: number | undefined;
  const retryAfter = Number(e.responseHeaders?.["retry-after"]);
  if (e.responseHeaders?.["retry-after"] !== undefined && Number.isFinite(retryAfter)) waitMs = retryAfter * 1000;
  const delayMatch = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (waitMs === undefined && delayMatch) waitMs = Number(delayMatch[1]) * 1000;
  if (waitMs !== undefined) waitMs = Math.min(waitMs, 120_000);

  const label = status === 429 ? "rate limited (429)" : `server error (${status ?? "network"})`;
  return { retryable: true, reason: `${label}: ${detail}`, waitMs };
}

/** A sleep that ends early, by rejecting, if the call's overall time limit passes. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const MULTI_ISSUE_THRESHOLD = 2;

export function pickModelTier(node: Pick<ParsedNode, "complexity" | "smells">): ModelTier {
  const needsDeepReasoning = node.smells.some((s) => s.type === "high-complexity" || s.type === "callback-hell");
  const isMultiIssue = node.smells.length >= MULTI_ISSUE_THRESHOLD;
  return needsDeepReasoning || isMultiIssue ? "capable" : "cheap";
}

export interface ConversationTurn {
  role: "assistant" | "user";
  content: string;
}

export async function generateRefactorPatch(
  objective: RefactorObjective,
  tier: ModelTier,
  priorTurns: ConversationTurn[] = [],
  hooks: CallHooks = {},
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

  const limitMs = timeoutMs();
  const signal = AbortSignal.timeout(limitMs); // one clock for the whole call, retries and waits included
  const maxRetries = apiRetries();
  try {
    for (let retry = 0; ; retry++) {
      try {
        const { object, usage } = await generateObject({
          model: getModel(tier),
          schema: AgentToolCallSchema,
          maxRetries: 0, // retries are handled below, where they can be reported
          abortSignal: signal,
          messages: [systemMessage, userMessage, ...priorTurns],
        });
        // Providers that don't report usage give NaN or nothing — skip rather than count garbage.
        if (usage && Number.isFinite(usage.promptTokens) && Number.isFinite(usage.completionTokens)) {
          hooks.onUsage?.({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens });
        }
        return object;
      } catch (err) {
        const failure = classifyApiError(err);
        if (failure.fatalMessage) throw new Error(`${describeModel(tier)} ${failure.fatalMessage}`);
        if (!failure.retryable || retry >= maxRetries) throw err;

        const waitMs = failure.waitMs ?? Math.min(2 ** retry * retryBaseMs(), 60_000);
        hooks.onRetry?.({ attempt: retry + 1, maxRetries, waitMs, reason: failure.reason });
        await sleep(waitMs, signal);
      }
    }
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(
        `The ${describeModel(tier)} call timed out after ${Math.round(limitMs / 1000)}s. On a free tier this is usually ` +
          `rate limiting — wait a minute and retry, or raise LLM_TIMEOUT_MS in your .env file.`,
      );
    }
    throw err;
  }
}