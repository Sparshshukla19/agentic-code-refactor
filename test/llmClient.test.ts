import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedNode } from "../src/types/ast.types.js";

// Mock every provider SDK BEFORE importing llmClient, so no real network
// call or API key is ever needed. We're testing "did we call the right
// provider's SDK correctly", not "does the provider's API work".
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn((id: string) => ({ provider: "anthropic", modelId: id })) }));
vi.mock("@ai-sdk/openai", () => ({ openai: vi.fn((id: string) => ({ provider: "openai", modelId: id })) }));
vi.mock("@ai-sdk/google", () => ({ google: vi.fn((id: string) => ({ provider: "google", modelId: id })) }));

const { generateObject } = await import("ai");
const { anthropic } = await import("@ai-sdk/anthropic");
const { openai } = await import("@ai-sdk/openai");
const { google } = await import("@ai-sdk/google");

function makeNode(overrides: Partial<Pick<ParsedNode, "complexity" | "smells">>): Pick<ParsedNode, "complexity" | "smells"> {
  return { complexity: 1, smells: [], ...overrides };
}

const ORIGINAL_ENV = { ...process.env };

describe("pickModelTier", () => {
  it("routes a single ordinary smell to the cheap tier", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    const node = makeNode({ complexity: 1, smells: [{ type: "untyped-signature", message: "x", line: 1 }] });
    expect(pickModelTier(node)).toBe("cheap");
  });

  it("routes high-complexity to the capable tier, even with only one smell", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    const node = makeNode({ complexity: 15, smells: [{ type: "high-complexity", message: "x", line: 1 }] });
    expect(pickModelTier(node)).toBe("capable");
  });

  it("routes callback-hell to the capable tier, even with only one smell", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    const node = makeNode({ complexity: 4, smells: [{ type: "callback-hell", message: "x", line: 1 }] });
    expect(pickModelTier(node)).toBe("capable");
  });

  it("routes to capable once smell count reaches the multi-issue threshold", async () => {
    const { pickModelTier } = await import("../src/agent/llmClient.js");
    const node = makeNode({
      complexity: 1,
      smells: [
        { type: "untyped-signature", message: "x", line: 1 },
        { type: "var-usage", message: "y", line: 1 },
      ],
    });
    expect(pickModelTier(node)).toBe("capable");
  });
});

describe("generateRefactorPatch — default provider (anthropic)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LLM_PROVIDER; // defaults to anthropic
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws a clear error when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("uses Anthropic's built-in default model ids without needing env vars set", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "Add types.", contextSlice: "function f() {}" };

    await generateRefactorPatch(objective, "capable");
    expect(anthropic).toHaveBeenCalledWith(expect.stringContaining("claude"));
    expect(openai).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });

  it("marks the system and initial user messages as cacheable (Anthropic-specific)", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "Add types.", contextSlice: "function f() {}" };

    await generateRefactorPatch(objective, "cheap");

    const call = vi.mocked(generateObject).mock.calls[0][0] as any;
    const [systemMsg, userMsg] = call.messages;
    expect(systemMsg.providerOptions.anthropic.cacheControl.type).toBe("ephemeral");
    expect(userMsg.providerOptions.anthropic.cacheControl.type).toBe("ephemeral");
  });

  it("appends priorTurns after the cached messages, for conversational retries", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "Add types.", contextSlice: "function f() {}" };
    const priorTurns = [{ role: "assistant" as const, content: "previous attempt" }, { role: "user" as const, content: "it failed: TS2345" }];

    await generateRefactorPatch(objective, "cheap", priorTurns);

    const call = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(call.messages).toHaveLength(4);
    expect(call.messages[2].content).toBe("previous attempt");
    expect(call.messages[3].content).toBe("it failed: TS2345");
  });

  it("returns the schema-validated object from the SDK response", async () => {
    const fakeResponse = { tool: "abort_task", payload: { reason: "unsafe" } };
    vi.mocked(generateObject).mockResolvedValue({ object: fakeResponse } as any);
    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };

    const result = await generateRefactorPatch(objective, "cheap");
    expect(result).toEqual(fakeResponse);
  });
});

describe("generateRefactorPatch — switching providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("routes to OpenAI's SDK when LLM_PROVIDER=openai, using the configured model ids", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_MODEL_CHEAP = "gpt-test-cheap";
    process.env.LLM_MODEL_CAPABLE = "gpt-test-capable";
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);

    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    await generateRefactorPatch(objective, "cheap");

    expect(openai).toHaveBeenCalledWith("gpt-test-cheap");
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("routes to Google's SDK when LLM_PROVIDER=google, using the configured model ids", async () => {
    process.env.LLM_PROVIDER = "google";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    process.env.LLM_MODEL_CHEAP = "gemini-test-cheap";
    process.env.LLM_MODEL_CAPABLE = "gemini-test-capable";
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);

    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    await generateRefactorPatch(objective, "capable");

    expect(google).toHaveBeenCalledWith("gemini-test-capable");
  });

  it("throws a clear error for a non-Anthropic provider with no model id configured — refuses to guess", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    // LLM_MODEL_CHEAP deliberately left unset

    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow(/LLM_MODEL_CHEAP/);
  });

  it("requires OPENAI_API_KEY specifically when provider is openai, not ANTHROPIC_API_KEY", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL_CHEAP = "gpt-test-cheap";
    process.env.ANTHROPIC_API_KEY = "irrelevant-should-not-satisfy-this";
    // OPENAI_API_KEY deliberately left unset

    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    await expect(generateRefactorPatch(objective, "cheap")).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("does NOT attach Anthropic-specific cacheControl when using a different provider", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_MODEL_CHEAP = "gpt-test-cheap";
    vi.mocked(generateObject).mockResolvedValue({ object: { tool: "propose_patch", payload: {} } } as any);

    const { generateRefactorPatch } = await import("../src/agent/llmClient.js");
    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    await generateRefactorPatch(objective, "cheap");

    const call = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(call.messages[0].providerOptions).toBeUndefined();
  });
});