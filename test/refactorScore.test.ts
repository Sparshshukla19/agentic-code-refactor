import { describe, expect, it } from "vitest";
import {
  calculateRefactoringScore,
  DEFAULT_REFACTOR_THRESHOLD,
  getFileFanIn,
  prioritizeTasks,
  shouldRefactor,
} from "../src/planner/refactorScore.js";
import { createDependencyGraph } from "../src/parser/dependencyGraph.js";
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
    complexity: 1,
    smells: [],
    ...overrides,
  };
}

describe("calculateRefactoringScore", () => {
  it("does not zero out the score for a complex function with zero callers (fan-in 0)", () => {
    const node = makeNode({
      complexity: 15,
      startLine: 1,
      endLine: 20,
      smells: [{ type: "high-complexity", message: "x", line: 1 }],
    });
    const score = calculateRefactoringScore(node, 0);
    expect(score).toBeGreaterThan(0);
  });

  it("does not let raw line count alone make a large-but-simple function outscore a small-but-complex one", () => {
    const large = makeNode({ complexity: 2, startLine: 1, endLine: 200, smells: [{ type: "var-usage", message: "x", line: 1 }] });
    const small = makeNode({
      complexity: 15,
      startLine: 1,
      endLine: 20,
      smells: [
        { type: "high-complexity", message: "x", line: 1 },
        { type: "no-error-handling", message: "y", line: 1 },
      ],
    });
    // Same fan-in for both — the small, genuinely complex function should
    // still win despite being 10x shorter.
    expect(calculateRefactoringScore(small, 2)).toBeGreaterThan(calculateRefactoringScore(large, 2));
  });

  it("increases monotonically with fan-in, complexity, and smell count", () => {
    const base = makeNode({ complexity: 5, startLine: 1, endLine: 10, smells: [{ type: "var-usage", message: "x", line: 1 }] });
    const moreFanIn = calculateRefactoringScore(base, 5);
    const lessFanIn = calculateRefactoringScore(base, 0);
    expect(moreFanIn).toBeGreaterThan(lessFanIn);

    const moreComplex = makeNode({ ...base, complexity: 20 });
    expect(calculateRefactoringScore(moreComplex, 0)).toBeGreaterThan(calculateRefactoringScore(base, 0));
  });
});

describe("shouldRefactor", () => {
  it("rejects a clean node regardless of score", () => {
    const cleanButBig = makeNode({ complexity: 20, startLine: 1, endLine: 500, smells: [] });
    expect(shouldRefactor(cleanButBig, 10)).toBe(false);
  });

  it("accepts a node once its score clears the threshold", () => {
    const nasty = makeNode({
      complexity: 20,
      startLine: 1,
      endLine: 50,
      smells: [
        { type: "high-complexity", message: "x", line: 1 },
        { type: "callback-hell", message: "y", line: 1 },
      ],
    });
    expect(shouldRefactor(nasty, 5, DEFAULT_REFACTOR_THRESHOLD)).toBe(true);
  });

  it("rejects a trivially smelly node that doesn't clear the bar", () => {
    const trivial = makeNode({
      complexity: 1,
      startLine: 1,
      endLine: 3,
      smells: [{ type: "var-usage", message: "x", line: 1 }],
    });
    expect(shouldRefactor(trivial, 0, DEFAULT_REFACTOR_THRESHOLD)).toBe(false);
  });
});

describe("getFileFanIn", () => {
  it("reads fan-in directly from the dependency graph", () => {
    const graph = createDependencyGraph();
    graph.addEdge("consumer.ts", "util.ts");
    expect(getFileFanIn("util.ts", graph)).toBe(1);
    expect(getFileFanIn("consumer.ts", graph)).toBe(0);
  });

  it("returns 0 for a file not present in the graph", () => {
    const graph = createDependencyGraph();
    expect(getFileFanIn("unknown.ts", graph)).toBe(0);
  });
});

describe("prioritizeTasks", () => {
  it("never reorders tasks across files, even when a later file scores higher", () => {
    const utilNode = makeNode({
      id: "util.ts::helper",
      name: "helper",
      filePath: "util.ts",
      complexity: 2,
      endLine: 3,
      smells: [{ type: "var-usage", message: "x", line: 1 }],
    });
    const consumerNode = makeNode({
      id: "consumer.ts::main",
      name: "main",
      filePath: "consumer.ts",
      complexity: 20,
      endLine: 50,
      smells: [
        { type: "high-complexity", message: "x", line: 1 },
        { type: "callback-hell", message: "y", line: 1 },
      ],
    });
    const utilFile: FileParseResult = { filePath: "util.ts", language: "ts", nodes: [utilNode], imports: [], exports: [], fullText: "" };
    const consumerFile: FileParseResult = { filePath: "consumer.ts", language: "ts", nodes: [consumerNode], imports: [], exports: [], fullText: "" };

    const graph = createDependencyGraph();
    graph.addEdge("consumer.ts", "util.ts");

    // Deliberately give consumer's task a LOWER threshold pass and higher
    // score than util's — if prioritizeTasks reordered globally by score,
    // consumer would jump ahead of util here. It must not.
    const tasks: QueuedTask[] = [
      { taskId: "task-0", filePath: "util.ts", targetNodeId: "util.ts::helper", order: 0, status: "pending" },
      { taskId: "task-1", filePath: "consumer.ts", targetNodeId: "consumer.ts::main", order: 1, status: "pending" },
    ];

    const result = prioritizeTasks(tasks, [utilFile, consumerFile], graph, 1);
    const utilIdx = result.findIndex((t) => t.filePath === "util.ts");
    const consumerIdx = result.findIndex((t) => t.filePath === "consumer.ts");

    expect(utilIdx).toBeLessThan(consumerIdx);
  });

  it("drops tasks that don't clear the threshold", () => {
    const trivialNode = makeNode({
      id: "a.ts::trivial",
      name: "trivial",
      filePath: "a.ts",
      complexity: 1,
      endLine: 3,
      smells: [{ type: "var-usage", message: "x", line: 1 }],
    });
    const file: FileParseResult = { filePath: "a.ts", language: "ts", nodes: [trivialNode], imports: [], exports: [], fullText: "" };
    const graph = createDependencyGraph();
    graph.addNode("a.ts");

    const tasks: QueuedTask[] = [{ taskId: "task-0", filePath: "a.ts", targetNodeId: "a.ts::trivial", order: 0, status: "pending" }];
    const result = prioritizeTasks(tasks, [file], graph, DEFAULT_REFACTOR_THRESHOLD);

    expect(result).toHaveLength(0);
  });

  it("re-numbers surviving tasks with fresh sequential order values", () => {
    const nodeA = makeNode({ id: "a.ts::fnA", name: "fnA", filePath: "a.ts", complexity: 15, endLine: 30, smells: [{ type: "high-complexity", message: "x", line: 1 }] });
    const nodeB = makeNode({ id: "a.ts::fnB", name: "fnB", filePath: "a.ts", complexity: 20, endLine: 40, smells: [{ type: "callback-hell", message: "x", line: 1 }] });
    const file: FileParseResult = { filePath: "a.ts", language: "ts", nodes: [nodeA, nodeB], imports: [], exports: [], fullText: "" };
    const graph = createDependencyGraph();
    graph.addNode("a.ts");

    const tasks: QueuedTask[] = [
      { taskId: "task-0", filePath: "a.ts", targetNodeId: "a.ts::fnA", order: 0, status: "pending" },
      { taskId: "task-1", filePath: "a.ts", targetNodeId: "a.ts::fnB", order: 1, status: "pending" },
    ];

    const result = prioritizeTasks(tasks, [file], graph, 1);
    expect(result.map((t) => t.order)).toEqual([0, 1]);
    expect(new Set(result.map((t) => t.taskId)).size).toBe(result.length);
  });
});