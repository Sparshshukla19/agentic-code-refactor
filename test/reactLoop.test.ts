import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";

vi.mock("../src/agent/llmClient.js", () => ({
  generateRefactorPatch: vi.fn(),
  pickModelTier: vi.fn(),
}));

const { generateRefactorPatch, pickModelTier } = await import("../src/agent/llmClient.js");
const { redactSecrets, runRefactorTask, buildRetryTurns } = await import("../src/agent/reactLoop.js");

describe("redactSecrets", () => {
  it("redacts an Anthropic-style API key", () => {
    const text = 'const key = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";';
    expect(redactSecrets(text)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redactSecrets(text)).toContain("[REDACTED]");
  });

  it("redacts an AWS access key ID", () => {
    const text = "AWS_KEY=AKIAIOSFODNN7EXAMPLE";
    expect(redactSecrets(text)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts a GitHub personal access token", () => {
    const text = 'const token = "ghp_1234567890abcdefghijklmnopqrstuvwx";';
    expect(redactSecrets(text)).not.toContain("1234567890abcdefghijklmnopqrstuvwx");
  });

  it("redacts a Bearer auth header", () => {
    const text = 'headers: { Authorization: "Bearer abc123.def456.ghi789xyz" }';
    expect(redactSecrets(text)).not.toContain("abc123.def456.ghi789xyz");
  });

  it("does NOT alter ordinary code with no secrets in it", () => {
    const mathUtilsPath = path.resolve("test-target/src/mathUtils.js");
    const original = fs.readFileSync(mathUtilsPath, "utf-8");
    expect(redactSecrets(original)).toBe(original);
  });
});

describe("runRefactorTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redacts secrets from the context slice BEFORE sending it to the LLM", async () => {
    vi.mocked(pickModelTier).mockReturnValue("cheap");
    vi.mocked(generateRefactorPatch).mockResolvedValue({ tool: "abort_task", payload: { reason: "x" } });

    const objective = {
      taskId: "t",
      targetNodeId: "n",
      instruction: "Add types.",
      contextSlice: 'const key = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";',
    };

    await runRefactorTask(objective, { complexity: 1, smells: [] });

    const sentObjective = vi.mocked(generateRefactorPatch).mock.calls[0][0];
    expect(sentObjective.contextSlice).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(sentObjective.contextSlice).toContain("[REDACTED]");
  });

  it("passes the model tier chosen by pickModelTier through to generateRefactorPatch", async () => {
    vi.mocked(pickModelTier).mockReturnValue("capable");
    vi.mocked(generateRefactorPatch).mockResolvedValue({ tool: "abort_task", payload: { reason: "x" } });

    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    await runRefactorTask(objective, { complexity: 15, smells: [{ type: "high-complexity", message: "x", line: 1 }] });

    expect(vi.mocked(generateRefactorPatch).mock.calls[0][1]).toBe("capable");
  });

  it("forwards priorTurns through for a retry", async () => {
    vi.mocked(pickModelTier).mockReturnValue("cheap");
    vi.mocked(generateRefactorPatch).mockResolvedValue({ tool: "abort_task", payload: { reason: "x" } });

    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    const priorTurns = [{ role: "assistant" as const, content: "prev" }];

    await runRefactorTask(objective, { complexity: 1, smells: [] }, { priorTurns });

    expect(vi.mocked(generateRefactorPatch).mock.calls[0][2]).toBe(priorTurns);
  });

  it("returns whatever generateRefactorPatch resolves to", async () => {
    vi.mocked(pickModelTier).mockReturnValue("cheap");
    const fakeResult = { tool: "propose_patch" as const, payload: { taskId: "t", targetNodeId: "n", newSourceText: "x", explanation: "y" } };
    vi.mocked(generateRefactorPatch).mockResolvedValue(fakeResult);

    const objective = { taskId: "t", targetNodeId: "n", instruction: "x", contextSlice: "y" };
    const result = await runRefactorTask(objective, { complexity: 1, smells: [] });

    expect(result).toEqual(fakeResult);
  });
});

describe("buildRetryTurns", () => {
  it("produces an assistant turn (the failed patch) followed by a user turn (the errors)", () => {
    const patch = { taskId: "t", targetNodeId: "n", newSourceText: "function f() {}", explanation: "Fixed types." };
    const turns = buildRetryTurns(patch, ["TS2345: bad arg"]);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("assistant");
    expect(turns[0].content).toContain("f()");
    expect(turns[1].role).toBe("user");
    expect(turns[1].content).toContain("TS2345: bad arg");
  });
});