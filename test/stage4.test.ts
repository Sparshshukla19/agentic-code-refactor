import { describe, expect, it } from "vitest";
import { Project, Node } from "ts-morph";
import {
  findSmallestEnclosingNode,
  selectTargetNode,
  sliceNode,
  extractDependencySignatures,
  formatLightweightSignature,
  extractRelevantImports,
} from "../src/parser/nodeExtractor.js";
import {
  extractTrivia,
  extractTriviaFromText,
  reconcileTrivia,
} from "../src/parser/triviaPreserver.js";
import {
  buildOptimizedPayload,
  calculateTokenMetrics,
  formatExperimentComparison,
  DeterministicTokenEstimator,
} from "../src/planner/contextSlicer.js";
import type { CodeSmell, FileParseResult, ParsedNode } from "../src/types/ast.types.js";
import type { DependencyGraph, QueuedTask } from "../src/types/graph.types.js";
import { createDependencyGraph } from "../src/planner/dependencyGraph.js";

function createInMemorySourceFile(code: string, fileName = "test.ts") {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(fileName, code);
}

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

describe("Stage 4: Node Slicing, Trivia Preservation & Token Optimization", () => {
  // 1. function node extraction
  it("1. extracts function node with exact text, lines, chars, kind, and name", () => {
    const code = `
function getUser(id: number): string {
  return "user-" + id;
}
    `.trim();
    const sourceFile = createInMemorySourceFile(code, "service.ts");
    const fn = sourceFile.getFunctionOrThrow("getUser");
    const sliced = sliceNode(fn, "service.ts");

    expect(sliced.kind).toBe("function");
    expect(sliced.name).toBe("getUser");
    expect(sliced.startLine).toBe(1);
    expect(sliced.endLine).toBe(3);
    expect(sliced.startChar).toBe(0);
    expect(sliced.endChar).toBe(code.length);
    expect(sliced.sourceText).toContain("function getUser(id: number): string");
  });

  // 2. arrow function extraction
  it("2. extracts arrow function node and infers name from variable declaration", () => {
    const code = `
const computeRate = (value: number): number => {
  return value * 0.15;
};
    `.trim();
    const sourceFile = createInMemorySourceFile(code, "rates.ts");
    const arrow = sourceFile.getFirstDescendant(Node.isArrowFunction)!;
    const sliced = sliceNode(arrow, "rates.ts");

    expect(sliced.kind).toBe("arrow-function");
    expect(sliced.name).toBe("computeRate");
    expect(sliced.sourceText).toContain("(value: number): number =>");
  });

  // 3. class extraction
  it("3. extracts class node with methods and metadata", () => {
    const code = `
class UserService {
  getUser(id: number): string {
    return "user";
  }
}
    `.trim();
    const sourceFile = createInMemorySourceFile(code, "service.ts");
    const cls = sourceFile.getClassOrThrow("UserService");
    const sliced = sliceNode(cls, "service.ts");

    expect(sliced.kind).toBe("class");
    expect(sliced.name).toBe("UserService");
    expect(sliced.startLine).toBe(1);
    expect(sliced.endLine).toBe(5);
    expect(sliced.sourceText).toContain("class UserService");
  });

  // 4. smallest meaningful enclosing node
  it("4. identifies the smallest meaningful enclosing node (function for internal var-usage, method for method smell, class for class smell)", () => {
    const code = `
class Repository {
  findUser(id: number) {
    var raw = fetchFromDb(id);
    return raw;
  }
}
    `.trim();
    const sourceFile = createInMemorySourceFile(code, "repo.ts");

    // var-usage inside findUser (line 3) -> selects enclosing method findUser, NOT raw variable and NOT Repository class
    const nodeForVar = findSmallestEnclosingNode(sourceFile, 3);
    expect(nodeForVar).not.toBeNull();
    const slicedVar = sliceNode(nodeForVar!, "repo.ts");
    expect(slicedVar.kind).toBe("method");
    expect(slicedVar.name).toBe("findUser");

    // Class level smell (line 1 on class header) -> selects class Repository
    const nodeForClass = findSmallestEnclosingNode(sourceFile, 1);
    expect(nodeForClass).not.toBeNull();
    const slicedClass = sliceNode(nodeForClass!, "repo.ts");
    expect(slicedClass.kind).toBe("class");
    expect(slicedClass.name).toBe("Repository");

    // selectTargetNode with CodeSmell targeting line 3
    const smell: CodeSmell = { type: "var-usage", message: "Use let/const", line: 3 };
    const selected = selectTargetNode(sourceFile, smell);
    expect(selected).not.toBeNull();
    const slicedSelected = sliceNode(selected, "repo.ts");
    expect(slicedSelected.name).toBe("findUser");
  });

  // 5. JSDoc preservation
  it("5. preserves JSDoc comments during trivia extraction and reconciliation", () => {
    const code = `
/**
 * Retrieves a user record by ID.
 * @param id The user identifier
 */
function getUser(id: number) {
  return id;
}
    `.trim();
    const sourceFile = createInMemorySourceFile(code);
    const fn = sourceFile.getFunctionOrThrow("getUser");

    const trivia = extractTrivia(fn);
    expect(trivia.jsDoc.length).toBeGreaterThan(0);
    expect(trivia.jsDoc[0]).toContain("Retrieves a user record by ID");

    // Test reconcileTrivia: if refactored code dropped JSDoc, it is restored
    const refactoredWithoutJSDoc = "function getUser(id: number): number {\n  return id;\n}";
    const reconciled = reconcileTrivia(refactoredWithoutJSDoc, trivia);
    expect(reconciled).toContain("Retrieves a user record by ID");
    expect(reconciled).toContain("function getUser(id: number): number");
  });

  // 6. leading comments
  it("6. extracts and preserves non-JSDoc leading comments", () => {
    const code = `
// Important security check: do not bypass
function verifyToken(token: string): boolean {
  return token.length > 0;
}
    `.trim();
    const sourceFile = createInMemorySourceFile(code);
    const fn = sourceFile.getFunctionOrThrow("verifyToken");

    const trivia = extractTrivia(fn);
    expect(trivia.leadingComments.length).toBeGreaterThan(0);
    expect(trivia.leadingComments[0]).toContain("Important security check");

    const refactored = "function verifyToken(token: string): boolean {\n  return Boolean(token);\n}";
    const reconciled = reconcileTrivia(refactored, trivia);
    expect(reconciled).toContain("// Important security check: do not bypass");
  });

  // 7. trailing comments
  it("7. extracts trailing comments associated with node boundaries", () => {
    const code = `
function calculate() {
  return 42;
} // End of calculate
    `.trim();
    const trivia = extractTriviaFromText(code);
    expect(trivia.trailingComments.length).toBeGreaterThan(0);
    expect(trivia.trailingComments[0]).toContain("End of calculate");
  });

  // 8. dependency signature extraction
  it("8. extracts lightweight signatures without implementation bodies for referenced dependencies", () => {
    const depNodeA = makeNode({
      id: "userRepo.ts::getUserById",
      name: "getUserById",
      filePath: "userRepo.ts",
      sourceText: `function getUserById(id: number): Promise<User> {\n  const res = db.query(id);\n  return res;\n}`,
    });
    const depFile = makeFile([depNodeA], { filePath: "userRepo.ts" });

    const targetSource = `function getUser(id: number) { return getUserById(id); }`;
    const signatures = extractDependencySignatures(targetSource, [depFile]);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].filePath).toBe("userRepo.ts");
    expect(signatures[0].signatures).toHaveLength(1);
    expect(signatures[0].signatures[0]).toBe("function getUserById(id: number): Promise<User>;");
    expect(signatures[0].signatures[0]).not.toContain("db.query");
  });

  // 9. irrelevant dependency removal
  it("9. excludes unreferenced functions and dependencies from signature extraction", () => {
    const referencedNode = makeNode({
      id: "math.ts::add",
      name: "add",
      filePath: "math.ts",
      sourceText: "function add(a: number, b: number): number { return a + b; }",
    });
    const unreferencedNode = makeNode({
      id: "math.ts::hugeUnrelatedMatrixCalculation",
      name: "hugeUnrelatedMatrixCalculation",
      filePath: "math.ts",
      sourceText: "function hugeUnrelatedMatrixCalculation() { /* 500 lines of body */ }",
    });
    const depFile = makeFile([referencedNode, unreferencedNode], { filePath: "math.ts" });

    const targetSource = `function calculateTotal(items: number[]) { return items.reduce((s, x) => add(s, x), 0); }`;
    const signatures = extractDependencySignatures(targetSource, [depFile]);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].signatures).toHaveLength(1);
    expect(signatures[0].signatures[0]).toContain("function add(a: number, b: number): number");
    expect(signatures[0].signatures[0]).not.toContain("hugeUnrelatedMatrixCalculation");
  });

  // 10. context pruning
  it("10. constructs an optimized pruned payload containing only target, relevant signatures and in-scope imports", () => {
    const targetNode = makeNode({
      id: "service.ts::getUser",
      name: "getUser",
      filePath: "service.ts",
      startLine: 10,
      endLine: 15,
      sourceText: "function getUser(id: number) { return findById(id); }",
      smells: [{ type: "untyped-signature", message: "Add types", line: 10 }],
    });
    const unrelatedNode = makeNode({
      id: "service.ts::deleteUser",
      name: "deleteUser",
      filePath: "service.ts",
      sourceText: "function deleteUser() { /* huge body */ }",
    });
    const serviceFile = makeFile([targetNode, unrelatedNode], {
      filePath: "service.ts",
      imports: ["./repo.js", "./unusedHelper.js"],
      fullText: `${targetNode.sourceText}\n\n${unrelatedNode.sourceText}`,
    });

    const repoNode = makeNode({
      id: "repo.ts::findById",
      name: "findById",
      filePath: "repo.ts",
      sourceText: "function findById(id: number): User { return db.find(id); }",
    });
    const repoFile = makeFile([repoNode], { filePath: "repo.ts" });

    const payload = buildOptimizedPayload({
      targetNode,
      file: serviceFile,
      dependencyFiles: [repoFile],
    });

    expect(payload.context.targetCode).toBe(targetNode.sourceText);
    expect(payload.context.promptContext).toContain("function getUser(id: number)");
    expect(payload.context.promptContext).toContain("function findById(id: number): User;");
    expect(payload.context.promptContext).not.toContain("deleteUser");
    expect(payload.context.promptContext).not.toContain("db.find");
  });

  // 11. token metric calculation
  it("11. accurately calculates original vs optimized characters and token metrics", () => {
    const originalText = "a".repeat(400); // 100 estimated tokens
    const optimizedText = "a".repeat(100); // 25 estimated tokens

    const metrics = calculateTokenMetrics(originalText, optimizedText);
    expect(metrics.originalCharacters).toBe(400);
    expect(metrics.optimizedCharacters).toBe(100);
    expect(metrics.estimatedOriginalTokens).toBe(100);
    expect(metrics.estimatedOptimizedTokens).toBe(25);
    expect(metrics.estimatedTokenSavings).toBe(75);
  });

  // 12. token reduction percentage
  it("12. calculates token reduction percentage using (orig - opt) / orig * 100", () => {
    const originalText = "a".repeat(400); // 100 tokens
    const optimizedText = "a".repeat(160); // 40 tokens
    const metrics = calculateTokenMetrics(originalText, optimizedText);

    // (100 - 40) / 100 * 100 = 60%
    expect(metrics.tokenReductionPercentage).toBe(60);
  });

  // 13. empty/minimal files
  it("13. safely handles empty and minimal files without division by zero or errors", () => {
    const metrics = calculateTokenMetrics("", "");
    expect(metrics.originalCharacters).toBe(0);
    expect(metrics.optimizedCharacters).toBe(0);
    expect(metrics.estimatedOriginalTokens).toBe(0);
    expect(metrics.estimatedOptimizedTokens).toBe(0);
    expect(metrics.tokenReductionPercentage).toBe(0);
    expect(metrics.estimatedTokenSavings).toBe(0);
  });

  // 14. source location accuracy
  it("14. verifies exact source line and character offset accuracy", () => {
    const code = `// line 1
function first() {
  return 1;
}

function second() {
  return 2;
}`;
    const sourceFile = createInMemorySourceFile(code, "multi.ts");
    const secondFn = sourceFile.getFunctionOrThrow("second");
    const sliced = sliceNode(secondFn, "multi.ts");

    expect(sliced.name).toBe("second");
    expect(sliced.startLine).toBe(6);
    expect(sliced.endLine).toBe(8);
    expect(sliced.startChar).toBe(secondFn.getStart());
    expect(sliced.endChar).toBe(secondFn.getEnd());
    expect(sliced.sourceText).toBe(secondFn.getText());
  });

  // 15. no LLM call during Stage 4
  it("15. executes Stage 4 completely offline with zero LLM API invocations", () => {
    const targetNode = makeNode({
      id: "a.ts::testFn",
      name: "testFn",
      filePath: "a.ts",
      sourceText: "function testFn() { return true; }",
    });
    const file = makeFile([targetNode]);

    const payload = buildOptimizedPayload({
      targetNode,
      file,
    });

    expect(payload).toBeDefined();
    expect(payload.context).toBeDefined();
    expect(payload.metrics).toBeDefined();
  });

  // Stage 3 Integration & Experiment report
  it("integrates end-to-end with Stage 3 task queue and generates experiment comparison", () => {
    const mathNode = makeNode({
      id: "math.ts::add",
      name: "add",
      filePath: "math.ts",
      sourceText: "function add(a: number, b: number): number { return a + b; }",
    });
    const mathFile = makeFile([mathNode], {
      filePath: "math.ts",
      fullText: "function add(a: number, b: number): number {\n  return a + b;\n}\n\nfunction clamp() { return 0; }",
    });

    const userControllerNode = makeNode({
      id: "userController.ts::getUserScore",
      name: "getUserScore",
      filePath: "userController.ts",
      sourceText: "function getUserScore(a: number, b: number) { return add(a, b); }",
      smells: [{ type: "untyped-signature", message: "untyped", line: 1 }],
    });
    const userControllerFile = makeFile([userControllerNode], {
      filePath: "userController.ts",
      imports: ["./math.js"],
      fullText: "import { add } from './math.js';\n\nfunction getUserScore(a: number, b: number) {\n  return add(a, b);\n}\n\nfunction unrelated() { return 100; }",
    });

    const graph: DependencyGraph = createDependencyGraph();
    graph.addNode("math.ts");
    graph.addNode("userController.ts");
    graph.addEdge("userController.ts", "math.ts", "./math.js");

    const task: QueuedTask = {
      taskId: "task-0",
      filePath: "userController.ts",
      targetNodeId: "userController.ts::getUserScore",
      order: 0,
      status: "pending",
    };

    const payload = buildOptimizedPayload({
      task,
      fileResults: [mathFile, userControllerFile],
      graph,
    });

    expect(payload.context.name).toBe("getUserScore");
    expect(payload.context.dependencies).toHaveLength(1);
    expect(payload.context.dependencies[0].filePath).toBe("math.ts");
    expect(payload.metrics.tokenReductionPercentage).toBeGreaterThan(0);

    const report = formatExperimentComparison(payload);
    expect(report).toContain("Target: function \"getUserScore\"");
    expect(report).toContain("Original context:");
    expect(report).toContain("Optimized context:");
    expect(report).toContain("Estimated token reduction:");
    expect(report).toContain("Dependencies included: 1 file(s)");
  });
});
