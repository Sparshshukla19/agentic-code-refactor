import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseFiles } from "../src/parser/astEngine.js";
import { buildDependencyGraph, createDependencyGraph } from "../src/parser/dependencyGraph.js";
import { scheduleTasks } from "../src/planner/taskScheduler.js";
import type { FileParseResult, ParsedNode } from "../src/types/ast.types.js";

const targetPath = (name: string) => path.resolve("test-target/src", name);

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

function makeFile(filePath: string, nodes: ParsedNode[]): FileParseResult {
  return { filePath, language: "ts", nodes, imports: [], exports: [] };
}

describe("scheduleTasks", () => {
  it("skips nodes with zero detected smells", () => {
    const clean = makeNode({ id: "a::clean", name: "clean", filePath: "a.ts", smells: [] });
    const dirty = makeNode({
      id: "a::dirty",
      name: "dirty",
      filePath: "a.ts",
      startLine: 10,
      smells: [{ type: "untyped-signature", message: "x", line: 10 }],
    });
    const file = makeFile("a.ts", [clean, dirty]);

    const graph = createDependencyGraph();
    graph.addNode("a.ts");

    const tasks = scheduleTasks([file], graph);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].targetNodeId).toBe("a::dirty");
  });

  it("orders tasks by the DAG's topological order across files", () => {
    const utilNode = makeNode({
      id: "util.ts::helper",
      name: "helper",
      filePath: "util.ts",
      smells: [{ type: "untyped-signature", message: "x", line: 1 }],
    });
    const consumerNode = makeNode({
      id: "consumer.ts::main",
      name: "main",
      filePath: "consumer.ts",
      smells: [{ type: "untyped-signature", message: "x", line: 1 }],
    });
    const utilFile = makeFile("util.ts", [utilNode]);
    const consumerFile = makeFile("consumer.ts", [consumerNode]);

    const graph = createDependencyGraph();
    graph.addEdge("consumer.ts", "util.ts"); // consumer depends on util

    const tasks = scheduleTasks([consumerFile, utilFile], graph);
    const utilTask = tasks.find((t) => t.filePath === "util.ts")!;
    const consumerTask = tasks.find((t) => t.filePath === "consumer.ts")!;

    expect(utilTask.order).toBeLessThan(consumerTask.order);
  });

  it("orders same-file tasks by source line, top to bottom", () => {
    const second = makeNode({
      id: "a.ts::second",
      name: "second",
      filePath: "a.ts",
      startLine: 20,
      smells: [{ type: "untyped-signature", message: "x", line: 20 }],
    });
    const first = makeNode({
      id: "a.ts::first",
      name: "first",
      filePath: "a.ts",
      startLine: 5,
      smells: [{ type: "untyped-signature", message: "x", line: 5 }],
    });
    const file = makeFile("a.ts", [second, first]); // deliberately out of line order

    const graph = createDependencyGraph();
    graph.addNode("a.ts");

    const tasks = scheduleTasks([file], graph);
    expect(tasks.map((t) => t.targetNodeId)).toEqual(["a.ts::first", "a.ts::second"]);
  });

  it("assigns unique, ascending order values and starts every task as pending", () => {
    const files = parseFiles([
      targetPath("mathUtils.js"),
      targetPath("userController.js"),
      targetPath("legacyCallback.js"),
    ]);
    const graph = buildDependencyGraph(files);
    const tasks = scheduleTasks(files, graph);

    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.status === "pending")).toBe(true);
    const orders = tasks.map((t) => t.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});