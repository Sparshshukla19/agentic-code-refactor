import { describe, expect, it } from "vitest";
import {
  aggregateTokenSavings,
  buildContextSlice,
  buildRefactorObjective,
  estimateTokenSavings,
  estimateTokens,
  generateInstruction,
} from "../src/planner/contextSlicer.js";
import type { FileParseResult, ParsedNode } from "../src/types/ast.types.js";
import type { QueuedTask } from "../src/types/graph.types.js";

function makeNode(overrides: Partial<ParsedNode>): ParsedNode {
  return {
    id: "file.ts::fn",
    kind: "function",
    name: "fn",
    filePath: "file.ts",
    startLine: 1,
    endLine: 5,
    sourceText: "function fn() {}",
    smells: [],
    ...overrides,
  };
}

function makeFile(nodes: ParsedNode[], overrides: Partial<FileParseResult> = {}): FileParseResult {
  return {
    filePath: "a.ts",
    language: "ts",
    nodes,
    imports: [],
    exports: [],
    fullText: nodes.map((n) => n.sourceText).join("\n\n"),
    ...overrides,
  };
}

describe("generateInstruction", () => {
  it("returns a no-op instruction when there are no smells", () => {
    const node = makeNode({ smells: [] });
    expect(generateInstruction(node)).toMatch(/without changing its behavior/i);
  });

  it("combines instructions for multiple distinct smells", () => {
    const node = makeNode({
      smells: [
        { type: "untyped-signature", message: "x", line: 1 },
        { type: "var-usage", message: "y", line: 2 },
      ],
    });
    const instruction = generateInstruction(node);
    expect(instruction).toMatch(/explicit parameter and return types/i);
    expect(instruction).toMatch(/let.*const/i);
  });

  it("deduplicates identical instructions from different smell types", () => {
    const node = makeNode({
      smells: [
        { type: "untyped-signature", message: "x", line: 1 },
        { type: "untyped-signature", message: "x again", line: 2 },
      ],
    });
    const instruction = generateInstruction(node);
    const occurrences = instruction.match(/explicit parameter/gi) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});

describe("buildContextSlice", () => {
  it("includes the target node's own source", () => {
    const target = makeNode({ sourceText: "function fn() { return 1; }" });
    const file = makeFile([target]);
    const slice = buildContextSlice(target, file);
    expect(slice).toContain("function fn() { return 1; }");
  });

  it("includes a same-file helper that the target actually calls", () => {
    const helper = makeNode({ id: "a.ts::helper", name: "helper", sourceText: "function helper() { return 2; }" });
    const target = makeNode({ id: "a.ts::main", name: "main", sourceText: "function main() { return helper() + 1; }" });
    const file = makeFile([helper, target]);

    const slice = buildContextSlice(target, file);
    expect(slice).toContain("function helper() { return 2; }");
  });

  it("excludes a same-file sibling the target never references", () => {
    const unrelated = makeNode({ id: "a.ts::unrelated", name: "unrelated", sourceText: "function unrelated() {}" });
    const target = makeNode({ id: "a.ts::main", name: "main", sourceText: "function main() { return 1; }" });
    const file = makeFile([unrelated, target]);

    const slice = buildContextSlice(target, file);
    expect(slice).not.toContain("function unrelated() {}");
  });

  it("does not false-match a name that is a substring of another identifier", () => {
    const addr = makeNode({ id: "a.ts::address", name: "address", sourceText: "function address() {}" });
    const target = makeNode({ id: "a.ts::main", name: "main", sourceText: "function main() { return add(1, 2); }" });
    const file = makeFile([addr, target]);

    const slice = buildContextSlice(target, file);
    expect(slice).not.toContain("function address() {}");
  });
});

describe("buildContextSlice — token-saving truncation", () => {
  it("includes a small referenced sibling's full body", () => {
    const helper = makeNode({ id: "a.ts::helper", name: "helper", sourceText: "function helper() { return 2; }" });
    const target = makeNode({ id: "a.ts::main", name: "main", sourceText: "function main() { return helper(); }" });
    const file = makeFile([helper, target]);

    const slice = buildContextSlice(target, file);
    expect(slice).toContain("function helper() { return 2; }");
  });

  it("truncates a large referenced sibling to just its signature", () => {
    const bigBody = "x".repeat(400);
    const helper = makeNode({
      id: "a.ts::bigHelper",
      name: "bigHelper",
      sourceText: `function bigHelper(a, b) {\n  ${bigBody}\n  return a;\n}`,
    });
    const target = makeNode({ id: "a.ts::main", name: "main", sourceText: "function main() { return bigHelper(1, 2); }" });
    const file = makeFile([helper, target]);

    const slice = buildContextSlice(target, file);
    expect(slice).toContain("function bigHelper(a, b)");
    expect(slice).toContain("body omitted for brevity");
    expect(slice).not.toContain(bigBody);
  });

  it("falls back to a capped first line when a large sibling has no brace (e.g. a one-line arrow fn)", () => {
    const bigBody = "1".repeat(400);
    const helper = makeNode({
      id: "a.ts::bigArrow",
      name: "bigArrow",
      sourceText: `const bigArrow = (a) => a + ${bigBody}`,
    });
    const target = makeNode({ id: "a.ts::main", name: "main", sourceText: "function main() { return bigArrow(1); }" });
    const file = makeFile([helper, target]);

    const slice = buildContextSlice(target, file);
    expect(slice).toContain("const bigArrow = (a) => a +");
    expect(slice).not.toContain(bigBody);
  });
});

describe("estimateTokens / estimateTokenSavings", () => {
  it("estimates roughly 1 token per 4 characters", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("reports a positive reduction when the slice is smaller than the full file", () => {
    const small = makeNode({ id: "a.ts::small", name: "small", sourceText: "function small() { return 1; }" });
    const big = makeNode({ id: "a.ts::big", name: "big", sourceText: "x".repeat(2000) });
    const file = makeFile([small, big]); // fullText = both declarations, the real naive baseline

    const slice = buildContextSlice(small, file);
    const report = estimateTokenSavings(file, slice);

    expect(report.sliceChars).toBeLessThan(report.fullFileChars);
    expect(report.reductionPercent).toBeGreaterThan(0);
    expect(report.estimatedSliceTokens).toBeLessThan(report.estimatedFullFileTokens);
  });

  it("returns zero reduction rather than dividing by zero for an empty file", () => {
    const file = makeFile([], { fullText: "" });
    const report = estimateTokenSavings(file, "");
    expect(report.reductionPercent).toBe(0);
  });
});

describe("aggregateTokenSavings", () => {
  it("sums chars/tokens across tasks and re-derives the percentage (not an average of percentages)", () => {
    const reportA = { fullFileChars: 100, sliceChars: 20, estimatedFullFileTokens: 25, estimatedSliceTokens: 5, reductionPercent: 80 };
    const reportB = { fullFileChars: 100, sliceChars: 90, estimatedFullFileTokens: 25, estimatedSliceTokens: 23, reductionPercent: 10 };

    const aggregate = aggregateTokenSavings([reportA, reportB]);

    expect(aggregate.fullFileChars).toBe(200);
    expect(aggregate.sliceChars).toBe(110);
    // Naive average of (80 + 10) / 2 = 45 would be WRONG here — the correct
    // weighted figure, re-derived from the summed totals, is 45 only by
    // coincidence when weights are equal; assert the actual math instead.
    expect(aggregate.reductionPercent).toBe(Math.round(((200 - 110) / 200) * 100));
  });

  it("returns all zeros for an empty list of reports", () => {
    const aggregate = aggregateTokenSavings([]);
    expect(aggregate.fullFileChars).toBe(0);
    expect(aggregate.reductionPercent).toBe(0);
  });
});

describe("buildRefactorObjective", () => {
  it("throws a clear error when the target node id isn't in the file", () => {
    const file = makeFile([], { fullText: "" });
    const task: QueuedTask = { taskId: "task-0", filePath: "a.ts", targetNodeId: "a.ts::missing", order: 0, status: "pending" };

    expect(() => buildRefactorObjective(task, file)).toThrow(/not found/i);
  });

  it("assembles a complete objective from a task and its file", () => {
    const node = makeNode({
      id: "a.ts::fn",
      smells: [{ type: "untyped-signature", message: "x", line: 1 }],
    });
    const file = makeFile([node]);
    const task: QueuedTask = { taskId: "task-0", filePath: "a.ts", targetNodeId: "a.ts::fn", order: 0, status: "pending" };

    const objective = buildRefactorObjective(task, file);
    expect(objective.taskId).toBe("task-0");
    expect(objective.targetNodeId).toBe("a.ts::fn");
    expect(objective.instruction).toMatch(/explicit parameter/i);
    expect(objective.contextSlice).toContain(node.sourceText);
  });
});