import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseFiles } from "../src/parser/astEngine.js";
import { buildDependencyGraph, CircularDependencyError, createDependencyGraph } from "../src/parser/dependencyGraph.js";

const targetPath = (name: string) => path.resolve("test-target/src", name);

describe("buildDependencyGraph + topologicalOrder", () => {
  it("orders mathUtils before userController, since userController requires it", () => {
    const files = parseFiles([
      targetPath("mathUtils.js"),
      targetPath("userController.js"),
      targetPath("legacyCallback.js"),
    ]);
    const graph = buildDependencyGraph(files);
    const order = graph.topologicalOrder();

    const mathIdx = order.indexOf(targetPath("mathUtils.js"));
    const controllerIdx = order.indexOf(targetPath("userController.js"));

    expect(mathIdx).toBeGreaterThanOrEqual(0);
    expect(controllerIdx).toBeGreaterThanOrEqual(0);
    expect(mathIdx).toBeLessThan(controllerIdx);
  });

  it("records the edge direction: userController dependsOn mathUtils", () => {
    const files = parseFiles([targetPath("mathUtils.js"), targetPath("userController.js")]);
    const graph = buildDependencyGraph(files);

    const controllerNode = graph.nodes.get(targetPath("userController.js"))!;
    const mathNode = graph.nodes.get(targetPath("mathUtils.js"))!;

    expect(controllerNode.dependsOn).toContain(targetPath("mathUtils.js"));
    expect(mathNode.dependedOnBy).toContain(targetPath("userController.js"));
  });

  it("ignores external package specifiers (not part of the internal DAG)", () => {
    const files = parseFiles([targetPath("legacyCallback.js")]);
    const graph = buildDependencyGraph(files);
    const node = graph.nodes.get(targetPath("legacyCallback.js"))!;
    expect(node.dependsOn).toEqual([]);
  });

  it("throws CircularDependencyError when two files import each other", () => {
    const graph = createDependencyGraph();
    graph.addNode("/proj/a.ts");
    graph.addNode("/proj/b.ts");
    graph.addEdge("/proj/a.ts", "/proj/b.ts"); // a depends on b
    graph.addEdge("/proj/b.ts", "/proj/a.ts"); // b depends on a — cycle

    expect(() => graph.topologicalOrder()).toThrow(CircularDependencyError);
  });

  it("handles a diamond dependency (two files sharing one common dependency)", () => {
    const graph = createDependencyGraph();
    graph.addNode("/proj/base.ts");
    graph.addEdge("/proj/left.ts", "/proj/base.ts");
    graph.addEdge("/proj/right.ts", "/proj/base.ts");
    graph.addEdge("/proj/top.ts", "/proj/left.ts");
    graph.addEdge("/proj/top.ts", "/proj/right.ts");

    const order = graph.topologicalOrder();
    expect(order.indexOf("/proj/base.ts")).toBeLessThan(order.indexOf("/proj/left.ts"));
    expect(order.indexOf("/proj/base.ts")).toBeLessThan(order.indexOf("/proj/right.ts"));
    expect(order.indexOf("/proj/left.ts")).toBeLessThan(order.indexOf("/proj/top.ts"));
    expect(order.indexOf("/proj/right.ts")).toBeLessThan(order.indexOf("/proj/top.ts"));
  });
});