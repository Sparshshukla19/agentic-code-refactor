import { describe, expect, it } from "vitest";
import { AgentToolCallSchema, RefactorPatchSchema } from "../src/agent/toolSchemas.js";

describe("RefactorPatchSchema", () => {
  it("accepts a complete, valid patch", () => {
    const result = RefactorPatchSchema.safeParse({
      taskId: "task-0",
      targetNodeId: "a.ts::fn",
      newSourceText: "function fn(a: number): number { return a; }",
      explanation: "Added explicit types.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty newSourceText — a patch must contain actual replacement code", () => {
    const result = RefactorPatchSchema.safeParse({
      taskId: "task-0",
      targetNodeId: "a.ts::fn",
      newSourceText: "",
      explanation: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a patch missing a required field", () => {
    const result = RefactorPatchSchema.safeParse({
      taskId: "task-0",
      newSourceText: "function fn() {}",
      explanation: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("AgentToolCallSchema — the discriminated union", () => {
  it("accepts a valid propose_patch call", () => {
    const result = AgentToolCallSchema.safeParse({
      tool: "propose_patch",
      payload: {
        taskId: "task-0",
        targetNodeId: "a.ts::fn",
        newSourceText: "function fn() {}",
        explanation: "x",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid request_more_context call, with the SHORTER payload shape", () => {
    const result = AgentToolCallSchema.safeParse({
      tool: "request_more_context",
      payload: { reason: "Need to see the Order type definition." },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid abort_task call", () => {
    const result = AgentToolCallSchema.safeParse({
      tool: "abort_task",
      payload: { reason: "Cannot safely refactor without breaking the public API." },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tool name outside the three allowed literals", () => {
    const result = AgentToolCallSchema.safeParse({
      tool: "do_something_else",
      payload: { reason: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a propose_patch call whose payload matches the WRONG tool's shape", () => {
    // payload here is a `{ reason }` shape, not a full RefactorPatch —
    // this is exactly the kind of mismatch a model could produce if it
    // confuses which tool it's calling, and the schema must catch it.
    const result = AgentToolCallSchema.safeParse({
      tool: "propose_patch",
      payload: { reason: "x" },
    });
    expect(result.success).toBe(false);
  });
});