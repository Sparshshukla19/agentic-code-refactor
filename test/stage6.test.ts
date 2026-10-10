import { describe, expect, it, vi } from "vitest";
import {
  validateRefactoring,
  validateSyntax,
  validateTypes,
  reconcileTriviaWithAst,
  reconcileAst,
  reanalyzeSmells,
  calculateSmellMetrics,
} from "../src/validation/validator.js";
import { routeAndRefactor } from "../src/refactor/refactoringRouter.js";
import { buildOptimizedPayload } from "../src/planner/contextSlicer.js";
import { Project } from "ts-morph";
import type { CodeSmell, FileParseResult, ParsedNode } from "../src/types/ast.types.js";
import type { RefactoringResult } from "../src/types/refactor.types.js";
import type { OptimizedPayload } from "../src/types/slicer.types.js";
import type { WorkspaceResult } from "../src/types/workspace.types.js";

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

describe("Stage 6: Validation, Trivia Reconciliation & Re-analysis", () => {
  // 1. valid refactoring passes syntax validation
  it("1. valid refactoring passes syntax validation", () => {
    const code = "function add(a: number, b: number): number {\n  return a + b;\n}";
    const result = validateSyntax(code);

    expect(result.syntaxValid).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  // 2. invalid TypeScript is rejected
  it("2. invalid TypeScript is rejected by syntax validation", () => {
    const invalidCode = "function add(a: number, b: number): number {\n  return a +\n";
    const result = validateSyntax(invalidCode);

    expect(result.syntaxValid).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].category).toBe("error");
  });

  // 3. type errors are detected
  it("3. type errors are detected by type validation", () => {
    const typeErrorCode = "function add(a: number, b: number): number {\n  return 'not a number';\n}";
    const result = validateTypes(typeErrorCode);

    expect(result.typeSafe).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].message).toContain("Type 'string' is not assignable to type 'number'");
  });

  // 4. broken imports are detected
  it("4. broken imports are detected by type validation", () => {
    const brokenImportCode = "import { nonExistentSymbol } from './missingModule';\nnonExistentSymbol();";
    const result = validateTypes(brokenImportCode);

    expect(result.typeSafe).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(
      result.diagnostics.some(
        (d) => d.message.includes("Cannot find module") || d.message.includes("nonExistentSymbol"),
      ),
    ).toBe(true);
  });

  // 5. comments are preserved
  it("5. comments are preserved during trivia reconciliation", () => {
    const original = `function getUser(id: number) {\n  // Search the users\n  return id;\n}`;
    const proposed = `function getUser(id: number): number {\n  return id;\n}`;

    const reconciled = reconcileTriviaWithAst(proposed, original);

    expect(reconciled.reconciledCode).toContain("// Search the users");
    expect(reconciled.triviaPreserved).toBe(true);
  });

  // 6. JSDoc is preserved
  it("6. JSDoc documentation is preserved during trivia reconciliation", () => {
    const original = `/**\n * Retrieves a user.\n */\nfunction getUser(id: number) {\n  return id;\n}`;
    const proposed = `function getUser(id: number): number {\n  return id;\n}`;

    const reconciled = reconcileTriviaWithAst(proposed, original);

    expect(reconciled.reconciledCode).toContain("/**\n * Retrieves a user.\n */");
    expect(reconciled.triviaPreserved).toBe(true);
  });

  // 7. unrelated comments are not duplicated
  it("7. does not duplicate comments if already present in proposed code", () => {
    const original = `/**\n * Adds two values.\n */\nfunction add(a: number, b: number) {\n  // Add values\n  return a + b;\n}`;
    const proposed = `/**\n * Adds two values.\n */\nfunction add(a: number, b: number): number {\n  // Add values\n  return a + b;\n}`;

    const reconciled = reconcileTriviaWithAst(proposed, original);

    const jsDocMatches = (reconciled.reconciledCode.match(/Adds two values/g) || []).length;
    const commentMatches = (reconciled.reconciledCode.match(/\/\/ Add values/g) || []).length;

    expect(jsDocMatches).toBe(1);
    expect(commentMatches).toBe(1);
    expect(reconciled.triviaPreserved).toBe(true);
  });

  // 8. before/after smell analysis works
  it("8. executes in-memory Stage 2 AST re-analysis Before vs After", () => {
    const beforeCode = `var count = 0;\nfunction inc(n) {\n  return n + 1;\n}`;
    const afterCode = `const count = 0;\nfunction inc(n: number): number {\n  return n + 1;\n}`;

    const comparison = reanalyzeSmells(afterCode, beforeCode);

    expect(comparison.beforeSmellCount).toBeGreaterThan(0);
    expect(comparison.afterSmellCount).toBe(0);
    expect(comparison.fixedSmells.length).toBe(comparison.beforeSmellCount);
  });

  // 9. fixed smells are correctly identified
  it("9. accurately identifies smells that were fixed by re-analysis confirmation", () => {
    const beforeCode = `var count = 10;`;
    const afterCode = `const count = 10;`;

    const comparison = reanalyzeSmells(afterCode, beforeCode);

    expect(comparison.fixedSmells.some((s) => s.type === "var-usage")).toBe(true);
    expect(comparison.fixedSmellCount).toBe(1);
    expect(comparison.remainingSmellCount).toBe(0);
  });

  // 10. remaining smells are correctly identified
  it("10. accurately identifies remaining smells that were not addressed", () => {
    // Before has var-usage AND untyped-signature
    const beforeCode = `var total = 0;\nfunction sum(a, b) {\n  return a + b;\n}`;
    // After only fixes var-usage, leaves function untyped
    const afterCode = `const total = 0;\nfunction sum(a, b) {\n  return a + b;\n}`;

    const comparison = reanalyzeSmells(afterCode, beforeCode);

    expect(comparison.fixedSmells.some((s) => s.type === "var-usage")).toBe(true);
    expect(comparison.remainingSmells.some((s) => s.type === "untyped-signature")).toBe(true);
    expect(comparison.remainingSmells.some((s) => s.type === "missing-return-type")).toBe(true);
  });

  // 11. smell reduction percentage is correct
  it("11. calculates correct smell reduction percentage", () => {
    const beforeSmells: CodeSmell[] = [
      { type: "var-usage", message: "Use const", line: 1 },
      { type: "untyped-signature", message: "Add types", line: 2 },
    ];
    const afterSmells: CodeSmell[] = [
      { type: "untyped-signature", message: "Add types", line: 2 },
    ];

    const metrics = calculateSmellMetrics(beforeSmells, afterSmells);

    expect(metrics.beforeSmellCount).toBe(2);
    expect(metrics.afterSmellCount).toBe(1);
    expect(metrics.fixedSmellCount).toBe(1);
    expect(metrics.remainingSmellCount).toBe(1);
    expect(metrics.smellReductionPercentage).toBe(50);
  });

  // 12. failed validation does not modify original source
  it("12. ensures failed validation preserves original source without modification", async () => {
    const originalCode = `function compute(x) { return x * 2; }`;
    const invalidResult: RefactoringResult = {
      success: true,
      strategy: "llm",
      originalCode,
      refactoredCode: `function compute(x: number): number { return 'bad string'; }`, // type error
      explanation: "Broken refactoring",
      changes: [],
    };

    // Workspace simulation
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("src/calc.ts", originalCode);
    const mockWorkspace: WorkspaceResult = {
      projectRoot: ".",
      files: [{ absolutePath: "src/calc.ts", relativePath: "src/calc.ts", sourceText: originalCode }],
      fileCount: 1,
      totalCharacters: originalCode.length,
      project,
      excludedDirectories: [],
    };

    const validation = await validateRefactoring(originalCode, invalidResult, mockWorkspace, {
      targetFile: "src/calc.ts",
    });

    expect(validation.valid).toBe(false);
    expect(validation.typeSafe).toBe(false);
    // Original in workspace file is untouched
    expect(sf.getFullText()).toBe(originalCode);
    expect(validation.refactoredCode).toBe(originalCode);
  });

  // 13. successful validation produces validated source
  it("13. successful validation produces validated source with 100% smell reduction", async () => {
    const originalCode = `var max = 100;`;
    const validResult: RefactoringResult = {
      success: true,
      strategy: "mechanical",
      originalCode,
      refactoredCode: `const max = 100;`,
      explanation: "Replaced immutable var with const",
      changes: [{ smellType: "var-usage", description: "Converted to const" }],
      nodeName: "max",
      nodeKind: "variable",
    };

    const validation = await validateRefactoring(originalCode, validResult);

    expect(validation.valid).toBe(true);
    expect(validation.syntaxValid).toBe(true);
    expect(validation.typeSafe).toBe(true);
    expect(validation.triviaPreserved).toBe(true);
    expect(validation.refactoredCode).toBe("const max = 100;");
    expect(validation.smellReductionPercentage).toBe(100);
  });

  // 14. zero-smell files are handled safely
  it("14. handles zero-smell files without division by zero or errors", () => {
    const cleanCode = `const PI: number = 3.14159;`;
    const comparison = reanalyzeSmells(cleanCode, cleanCode);

    expect(comparison.beforeSmellCount).toBe(0);
    expect(comparison.afterSmellCount).toBe(0);
    expect(comparison.smellReductionPercentage).toBe(0);
  });

  // 15. mechanical refactoring validation
  it("15. end-to-end validates a mechanical refactoring from Stage 5", async () => {
    const originalCode = `var greeting = "Hello";`;
    const smells: CodeSmell[] = [{ type: "var-usage", message: "Use const", line: 1 }];
    const payload = makePayload(originalCode, smells, { name: "greeting", nodeKind: "variable" });

    const refactorResult = await routeAndRefactor(payload);
    expect(refactorResult.success).toBe(true);
    expect(refactorResult.strategy).toBe("mechanical");

    const validation = await validateRefactoring(payload, refactorResult);

    expect(validation.valid).toBe(true);
    expect(validation.strategy).toBe("mechanical");
    expect(validation.syntaxValid).toBe(true);
    expect(validation.typeSafe).toBe(true);
    expect(validation.beforeSmellCount).toBe(1);
    expect(validation.afterSmellCount).toBe(0);
    expect(validation.fixedSmellCount).toBe(1);
    expect(validation.smellReductionPercentage).toBe(100);
    expect(validation.researchMetrics?.strategy).toBe("mechanical");
    expect(validation.researchMetrics?.validationPassed).toBe(true);
  });

  // 16. LLM refactoring validation with mock response
  it("16. end-to-end validates an LLM refactoring from Stage 5 with mock response", async () => {
    const originalCode = `function multiply(a, b) {\n  return a * b;\n}`;
    const smells: CodeSmell[] = [
      { type: "untyped-signature", message: "Add types", line: 1 },
      { type: "missing-return-type", message: "Add return type", line: 1 },
    ];
    const payload = makePayload(originalCode, smells, { name: "multiply", nodeKind: "function" });

    const mockLlmResponse = {
      success: true,
      refactoredCode: `function multiply(a: number, b: number): number {\n  return a * b;\n}`,
      explanation: "Added TypeScript parameter and return types",
      changes: [
        { type: "untyped-signature", description: "Added parameter types" },
        { type: "missing-return-type", description: "Added return type" },
      ],
    };

    const refactorResult = await routeAndRefactor(payload, { mockLlmResponse });
    expect(refactorResult.success).toBe(true);
    expect(refactorResult.strategy).toBe("llm");

    const validation = await validateRefactoring(payload, refactorResult);

    expect(validation.valid).toBe(true);
    expect(validation.strategy).toBe("llm");
    expect(validation.syntaxValid).toBe(true);
    expect(validation.typeSafe).toBe(true);
    expect(validation.beforeSmellCount).toBe(2);
    expect(validation.afterSmellCount).toBe(0);
    expect(validation.fixedSmellCount).toBe(2);
    expect(validation.smellReductionPercentage).toBe(100);
    expect(validation.researchMetrics?.strategy).toBe("llm");
    expect(validation.researchMetrics?.validationPassed).toBe(true);
  });

  // 17. Section 12 Specification Example
  it("17. exactly matches the Section 12 example specification", async () => {
    const original = `/**\n * Adds two values.\n */\nfunction add(a, b) {\n  // Add values\n  return a + b;\n}`;
    const proposed = `/**\n * Adds two values.\n */\nfunction add(a: number, b: number): number {\n  // Add values\n  return a + b;\n}`;

    const refactorResult: RefactoringResult = {
      success: true,
      strategy: "llm",
      originalCode: original,
      refactoredCode: proposed,
      explanation: "Annotated types and preserved trivia",
      changes: [
        { smellType: "untyped-signature", description: "Typed parameters" },
        { smellType: "missing-return-type", description: "Typed return" },
      ],
      nodeName: "add",
      nodeKind: "function",
    };

    const validation = await validateRefactoring(original, refactorResult);

    expect(validation.syntaxValid).toBe(true);
    expect(validation.typeSafe).toBe(true);
    expect(validation.triviaPreserved).toBe(true);
    expect(validation.beforeSmellCount).toBe(2);
    expect(validation.afterSmellCount).toBe(0);
    expect(validation.fixedSmellCount).toBe(2);
    expect(validation.smellReductionPercentage).toBe(100);
    expect(validation.valid).toBe(true);
  });

  // 18. AST Reconciliation detects removed target or modified unrelated nodes
  it("18. AST reconciliation detects removed target or altered unrelated nodes", () => {
    const origCode = `function add(a: number, b: number) { return a + b; }`;
    const renamedCode = `function sum(a: number, b: number) { return a + b; }`;

    const astCheck = reconcileAst(origCode, renamedCode, { targetName: "add" });
    expect(astCheck.astReconciled).toBe(false);
    expect(astCheck.targetStillExists).toBe(false);
  });
});
