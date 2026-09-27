import { describe, expect, it } from "vitest";
import { buildRetryFeedback, buildUserMessage, SYSTEM_PROMPT } from "../src/agent/prompts.js";
import type { RefactorObjective } from "../src/types/agent.types.js";

describe("SYSTEM_PROMPT", () => {
  it("names all three tools the model is allowed to call", () => {
    expect(SYSTEM_PROMPT).toContain("propose_patch");
    expect(SYSTEM_PROMPT).toContain("request_more_context");
    expect(SYSTEM_PROMPT).toContain("abort_task");
  });

  it("instructs the model to preserve behavior, not just change syntax", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("preserve");
  });
});

describe("buildUserMessage", () => {
  it("includes both the instruction and the context slice", () => {
    const objective: RefactorObjective = {
      taskId: "task-0",
      targetNodeId: "a.ts::fn",
      instruction: "Add explicit parameter and return types.",
      contextSlice: "// Target\nfunction fn(a) { return a; }",
    };
    const message = buildUserMessage(objective);
    expect(message).toContain(objective.instruction);
    expect(message).toContain(objective.contextSlice);
  });
});

describe("buildRetryFeedback", () => {
  it("lists every verification error as its own bullet", () => {
    const feedback = buildRetryFeedback("Added types to fn.", ["TS2345: bad arg type", "TS2322: bad return type"]);
    expect(feedback).toContain("TS2345: bad arg type");
    expect(feedback).toContain("TS2322: bad return type");
  });

  it("includes what the previous patch claimed to have done", () => {
    const feedback = buildRetryFeedback("Converted callback to async/await.", ["some error"]);
    expect(feedback).toContain("Converted callback to async/await.");
  });
});