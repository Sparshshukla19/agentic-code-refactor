/**
 * Zod schemas enforcing structured JSON output from the LLM. Claude is
 * forced to respond with EXACTLY one of these three shapes — never free
 * prose — which is what keeps output tokens minimal and makes the
 * response mechanically parseable instead of something we have to
 * interpret. Mirrors the AgentToolCall/RefactorPatch types in
 * types/agent.types.ts exactly, so the validated result can be used as
 * that type with no further mapping.
 */
import { z } from "zod";

export const RefactorPatchSchema = z.object({
  taskId: z.string(),
  targetNodeId: z.string(),
  newSourceText: z.string().min(1, "newSourceText cannot be empty — the model must return complete replacement code"),
  explanation: z.string(),
});

const ProposePatchCallSchema = z.object({
  tool: z.literal("propose_patch"),
  payload: RefactorPatchSchema,
});

const RequestMoreContextCallSchema = z.object({
  tool: z.literal("request_more_context"),
  payload: z.object({ reason: z.string() }),
});

const AbortTaskCallSchema = z.object({
  tool: z.literal("abort_task"),
  payload: z.object({ reason: z.string() }),
});

/**
 * A discriminated union on the `tool` field — this is what forces the
 * model into exactly one of the three valid shapes. generateObject (see
 * llmClient.ts) uses this directly as its schema, so a malformed or
 * incomplete response is rejected before it ever reaches the rest of the
 * pipeline, rather than causing a confusing failure two stages later.
 */
export const AgentToolCallSchema = z.discriminatedUnion("tool", [
  ProposePatchCallSchema,
  RequestMoreContextCallSchema,
  AbortTaskCallSchema,
]);