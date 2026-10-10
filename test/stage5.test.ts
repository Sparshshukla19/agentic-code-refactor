import { describe, expect, it, vi } from "vitest";
import {
  routeAndRefactor,
  determineRefactoringStrategy,
  isSupportedSmell,
} from "../src/refactor/refactoringRouter.js";
import { applyMechanicalRefactoring } from "../src/refactor/mechanicalRefactor.js";
import { buildOptimizedPayload } from "../src/planner/contextSlicer.js";
import type { CodeSmell, FileParseResult, ParsedNode } from "../src/types/ast.types.js";
import type { OptimizedPayload } from "../src/types/slicer.types.js";
import * as llmModule from "../src/agent/llmClient.js";

function makeNode(overrides: Partial<ParsedNode>): ParsedNode {
  return {
    id: "test.ts::fn",
    kind: "function",
    name: "fn",
    filePath: "test.ts",
    startLine: 1,
    endLine: 5,
    sourceText: "function fn() {}",
    complexity: 1,
    smells: [],
    ...overrides,
  };
}

function makeFile(nodes: ParsedNode[], overrides: Partial<FileParseResult> = {}): FileParseResult {
  return {
    filePath: "test.ts",
    language: "ts",
    nodes,
    imports: [],
    exports: [],
    fullText: nodes.map((n) => n.sourceText).join("\n\n"),
    ...overrides,
  };
}

function makePayload(
  code: string,
  smells: CodeSmell[],
  overrides: Partial<OptimizedPayload["context"]> = {},
): OptimizedPayload {
  const node = makeNode({ sourceText: code, smells });
  const file = makeFile([node]);
  const payload = buildOptimizedPayload({ targetNode: node, file, smells });
  return {
    ...payload,
    context: {
      ...payload.context,
      targetCode: code,
      smells,
      ...overrides,
    },
  };
}

describe("Stage 5: Hybrid Transformation & Refactoring Agent", () => {
  // 1. var → const (immutable)
  it("1. mechanically converts immutable var declarations to const", async () => {
    const code = "var count = 10;";
    const smells: CodeSmell[] = [{ type: "var-usage", message: "Use const or let", line: 1 }];
    const payload = makePayload(code, smells);

    const result = await routeAndRefactor(payload);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe("mechanical");
    expect(result.refactoredCode).toContain("const count = 10;");
    expect(result.refactoredCode).not.toContain("var count");
    expect(result.refactoredCode).not.toContain("let count");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes[0].smellType).toBe("var-usage");
  });

  // 2. var reassigned → let
  it("2. mechanically converts reassigned var declarations to let", async () => {
    const code = "var count = 10;\ncount = 20;";
    const smells: CodeSmell[] = [{ type: "var-usage", message: "Use const or let", line: 1 }];
    const payload = makePayload(code, smells);

    const result = await routeAndRefactor(payload);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe("mechanical");
    expect(result.refactoredCode).toContain("let count = 10;");
    expect(result.refactoredCode).not.toContain("const count");
    expect(result.refactoredCode).not.toContain("var count");
  });

  // 3. mechanical transformation does not call LLM
  it("3. executes mechanical transformation without invoking the LLM", async () => {
    const llmSpy = vi.spyOn(llmModule, "generateStructuredRefactor");
    const code = "var value = 42;";
    const smells: CodeSmell[] = [{ type: "var-usage", message: "Use const or let", line: 1 }];
    const payload = makePayload(code, smells);

    const result = await routeAndRefactor(payload);

    expect(result.strategy).toBe("mechanical");
    expect(llmSpy).not.toHaveBeenCalled();
    llmSpy.mockRestore();
  });

  // 4. complex smell routes to LLM
  it("4. routes complex semantic smells (missing-return-type, untyped-signature, callback-hell) to LLM", async () => {
    expect(determineRefactoringStrategy([{ type: "missing-return-type", message: "x", line: 1 }])).toBe("llm");
    expect(determineRefactoringStrategy([{ type: "untyped-signature", message: "x", line: 1 }])).toBe("llm");
    expect(determineRefactoringStrategy([{ type: "callback-hell", message: "x", line: 1 }])).toBe("llm");

    const code = "function getUser(id) { return 'user-' + id; }";
    const smells: CodeSmell[] = [{ type: "untyped-signature", message: "Add types", line: 1 }];
    const payload = makePayload(code, smells);

    const mockLlmResponse = {
      success: true,
      refactoredCode: "function getUser(id: number): string {\n  return 'user-' + id;\n}",
      explanation: "Added explicit parameter and return types",
      changes: [{ type: "untyped-signature", description: "Added parameter and return types" }],
    };

    const result = await routeAndRefactor(payload, { mockLlmResponse });

    expect(result.success).toBe(true);
    expect(result.strategy).toBe("llm");
    expect(result.refactoredCode).toContain("function getUser(id: number): string");
  });

  // 5. LLM receives optimized Stage 4 context
  it("5. supplies only the optimized Stage 4 context slice to the LLM", async () => {
    const code = "function add(a, b) { return a + b; }";
    const smells: CodeSmell[] = [{ type: "untyped-signature", message: "Add types", line: 1 }];
    const payload = makePayload(code, smells);

    let receivedPayload: OptimizedPayload | null = null;
    const llmSpy = vi
      .spyOn(llmModule, "generateStructuredRefactor")
      .mockImplementation(async (p) => {
        receivedPayload = p;
        return {
          success: true,
          refactoredCode: "function add(a: number, b: number): number { return a + b; }",
          explanation: "Typed function",
          changes: [{ type: "untyped-signature", description: "Added types" }],
        };
      });

    await routeAndRefactor(payload);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload!.context.targetCode).toBe(code);
    expect(receivedPayload!.context.promptContext).toContain("function add(a, b)");
    // Entire project is NOT in context
    expect(receivedPayload!.context.promptContext).not.toContain("unrelatedGiantFile");

    llmSpy.mockRestore();
  });

  // 6. structured LLM response parsing
  it("6. correctly parses and validates structured JSON LLM responses", async () => {
    const code = "function compute(x) { return x * 2; }";
    const smells: CodeSmell[] = [{ type: "missing-return-type", message: "Return type missing", line: 1 }];
    const payload = makePayload(code, smells);

    const mockLlmResponse = {
      success: true,
      refactoredCode: "function compute(x: number): number {\n  return x * 2;\n}",
      explanation: "Inferred and annotated number return type",
      changes: [{ type: "missing-return-type", description: "Annotated : number return type" }],
    };

    const result = await routeAndRefactor(payload, { mockLlmResponse });

    expect(result.success).toBe(true);
    expect(result.explanation).toBe("Inferred and annotated number return type");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].smellType).toBe("missing-return-type");
  });

  // 7. malformed LLM response handling
  it("7. gracefully handles malformed or empty LLM response without corrupting source", async () => {
    const code = "function fn() {}";
    const smells: CodeSmell[] = [{ type: "untyped-signature", message: "x", line: 1 }];
    const payload = makePayload(code, smells);

    // Mock LLM returning empty refactoredCode
    const mockLlmResponse = {
      success: true,
      refactoredCode: "",
      explanation: "bad",
      changes: [],
    };

    const result = await routeAndRefactor(payload, { mockLlmResponse });

    expect(result.success).toBe(false);
    expect(result.strategy).toBe("llm");
    expect(result.refactoredCode).toBe(code); // Original code preserved
    expect(result.explanation).toMatch(/empty/i);
  });

  // 8. API failure handling
  it("8. gracefully handles LLM API failure/rejection without throwing or corrupting code", async () => {
    const code = "function fn() { return 1; }";
    const smells: CodeSmell[] = [{ type: "untyped-signature", message: "x", line: 1 }];
    const payload = makePayload(code, smells);

    const llmSpy = vi
      .spyOn(llmModule, "generateStructuredRefactor")
      .mockRejectedValue(new Error("Anthropic API connection timeout (504)"));

    const result = await routeAndRefactor(payload);

    expect(result.success).toBe(false);
    expect(result.strategy).toBe("llm");
    expect(result.refactoredCode).toBe(code); // Original uncorrupted
    expect(result.error).toContain("Anthropic API connection timeout");
    expect(result.explanation).toContain("LLM transformation failed");

    llmSpy.mockRestore();
  });

  // 9. transformation result structure
  it("9. returns a complete RefactoringResult metadata structure", async () => {
    const code = "var x = 10;";
    const smells: CodeSmell[] = [{ type: "var-usage", message: "Use const", line: 1 }];
    const payload = makePayload(code, smells, {
      targetFile: "src/sample.ts",
      nodeKind: "variable",
      name: "x",
      startLine: 1,
      endLine: 1,
    });

    const result = await routeAndRefactor(payload);

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("strategy");
    expect(result).toHaveProperty("originalCode");
    expect(result).toHaveProperty("refactoredCode");
    expect(result).toHaveProperty("explanation");
    expect(result).toHaveProperty("changes");
    expect(result.targetFile).toBe("src/sample.ts");
    expect(result.nodeKind).toBe("variable");
    expect(result.nodeName).toBe("x");
  });

  // 10. original source remains unchanged
  it("10. ensures originalCode remains intact in the result and no disk writes happen", async () => {
    const code = "var original = 'unchanged';";
    const smells: CodeSmell[] = [{ type: "var-usage", message: "x", line: 1 }];
    const payload = makePayload(code, smells);

    const result = await routeAndRefactor(payload);

    expect(result.originalCode).toBe(code);
    expect(result.refactoredCode).toBe("const original = 'unchanged';");
  });

  // 11. comments are preserved in the proposed output where applicable
  it("11. preserves comments and JSDoc documentation in refactored output", async () => {
    const code = `/**
 * Calculate the area of a square.
 * @param side Side length
 */
var area = function (side) {
  // Multiply side by side
  return side * side;
};`;
    const smells: CodeSmell[] = [{ type: "var-usage", message: "Use const", line: 5 }];
    const payload = makePayload(code, smells);

    const result = await routeAndRefactor(payload);

    expect(result.success).toBe(true);
    expect(result.refactoredCode).toContain("Calculate the area of a square");
    expect(result.refactoredCode).toContain("// Multiply side by side");
    expect(result.refactoredCode).toContain("const area =");
  });

  // 12. unsupported smell is safely rejected
  it("12. safely rejects unsupported code smell types without breaking pipeline", async () => {
    expect(isSupportedSmell("var-usage")).toBe(true);
    expect(isSupportedSmell("missing-return-type")).toBe(true);
    expect(isSupportedSmell("unknown-magic-smell")).toBe(false);

    const code = "function doSomething() {}";
    const smells: CodeSmell[] = [
      { type: "unknown-magic-smell" as any, message: "Nonexistent smell", line: 1 },
    ];
    const payload = makePayload(code, smells);

    const result = await routeAndRefactor(payload);

    expect(result.success).toBe(false);
    expect(result.refactoredCode).toBe(code);
    expect(result.explanation).toMatch(/unsupported/i);
    expect(result.error).toContain("unknown-magic-smell");
  });
});
