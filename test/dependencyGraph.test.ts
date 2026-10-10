import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseFiles } from "../src/parser/astEngine.js";
import {
  buildDependencyGraph,
  CircularDependencyError,
  createDependencyGraph,
  normalizePath,
  resolveImportSpecifier,
  topologicalSort,
} from "../src/planner/dependencyGraph.js";
import type { FileParseResult } from "../src/types/ast.types.js";

// normalizePath matters here specifically because path.resolve() returns
// backslash-separated paths on Windows, while the graph's keys (sourced from
// ts-morph) are always forward-slash. Without this, every lookup below would
// silently fail to match on Windows only — passing on Linux/Mac would hide it.
const targetPath = (name: string) => normalizePath(path.resolve("test-target/src", name));

describe("buildDependencyGraph + topologicalOrder (Stage 3)", () => {
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

  // ---- New Stage 3 Test Cases ----

  it("Case 1: correctly orders multi-tier chain (mathUtils -> userService -> userController)", () => {
    const parseResults: FileParseResult[] = [
      {
        filePath: "/proj/userController.ts",
        language: "ts",
        nodes: [],
        imports: ["./userService"],
        exports: [],
        fullText: "",
      },
      {
        filePath: "/proj/userService.ts",
        language: "ts",
        nodes: [],
        imports: ["./mathUtils"],
        exports: [],
        fullText: "",
      },
      {
        filePath: "/proj/mathUtils.ts",
        language: "ts",
        nodes: [],
        imports: [],
        exports: [],
        fullText: "",
      },
    ];

    const graph = buildDependencyGraph(parseResults);
    const queue = topologicalSort(graph);

    expect(queue.hasCycle).toBe(false);
    expect(queue.files).toEqual([
      "/proj/mathUtils.ts",
      "/proj/userService.ts",
      "/proj/userController.ts",
    ]);
  });

  it("Case 2: detects cycles and returns cycle path without crashing", () => {
    const parseResults: FileParseResult[] = [
      {
        filePath: "/proj/A.ts",
        language: "ts",
        nodes: [],
        imports: ["./B"],
        exports: [],
        fullText: "",
      },
      {
        filePath: "/proj/B.ts",
        language: "ts",
        nodes: [],
        imports: ["./A"],
        exports: [],
        fullText: "",
      },
    ];

    const graph = buildDependencyGraph(parseResults);
    const queue = topologicalSort(graph);

    expect(queue.hasCycle).toBe(true);
    expect(queue.cycle).toBeDefined();
    expect(queue.cycle).toContain("/proj/A.ts");
    expect(queue.cycle).toContain("/proj/B.ts");
  });

  it("Case 3: does NOT include external npm packages (like express) as project nodes", () => {
    const parseResults: FileParseResult[] = [
      {
        filePath: "/proj/server.ts",
        language: "ts",
        nodes: [],
        imports: ["express", "node:path", "@ai-sdk/openai"],
        exports: [],
        fullText: "",
      },
    ];

    const graph = buildDependencyGraph(parseResults);
    expect(graph.nodes.has("/proj/server.ts")).toBe(true);
    expect(graph.nodes.has("express")).toBe(false);
    expect(graph.nodes.has("node:path")).toBe(false);
    expect(graph.edges).toHaveLength(0);

    const queue = topologicalSort(graph);
    expect(queue.files).toEqual(["/proj/server.ts"]);
    expect(queue.hasCycle).toBe(false);
  });

  it("Case 4: resolves extensionless relative import './utils/mathUtils' to project file", () => {
    const knownPaths = new Set([
      "/proj/src/app.ts",
      "/proj/src/utils/mathUtils.ts",
    ]);

    const resolved = resolveImportSpecifier(
      "/proj/src/app.ts",
      "./utils/mathUtils",
      knownPaths,
    );

    expect(resolved).toBe("/proj/src/utils/mathUtils.ts");
  });

  it("Case 5: includes all independent files in the refactoring queue", () => {
    const parseResults: FileParseResult[] = [
      { filePath: "/proj/A.ts", language: "ts", nodes: [], imports: [], exports: [], fullText: "" },
      { filePath: "/proj/B.ts", language: "ts", nodes: [], imports: [], exports: [], fullText: "" },
      { filePath: "/proj/C.ts", language: "ts", nodes: [], imports: [], exports: [], fullText: "" },
    ];

    const graph = buildDependencyGraph(parseResults);
    const queue = topologicalSort(graph);

    expect(queue.hasCycle).toBe(false);
    expect(queue.files).toContain("/proj/A.ts");
    expect(queue.files).toContain("/proj/B.ts");
    expect(queue.files).toContain("/proj/C.ts");
    expect(queue.files).toHaveLength(3);
  });

  it("stores rich dependency edge metadata including importType", () => {
    const parseResults: FileParseResult[] = [
      {
        filePath: "/proj/consumer.ts",
        language: "ts",
        nodes: [],
        imports: ["./util"],
        exports: [],
        fullText: "",
        importDeclarations: [
          {
            moduleSpecifier: "./util",
            namedImports: ["helper"],
            isRequire: false,
            line: 1,
            column: 1,
          },
        ],
      },
      {
        filePath: "/proj/util.ts",
        language: "ts",
        nodes: [],
        imports: [],
        exports: ["helper"],
        fullText: "",
      },
    ];

    const graph = buildDependencyGraph(parseResults);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      from: "/proj/consumer.ts",
      to: "/proj/util.ts",
      importPath: "./util",
      importType: "named",
    });
  });
});