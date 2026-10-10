import { describe, expect, it } from "vitest";
import {
  validateSyntax,
  validateTypes,
  reconcileTriviaWithAst,
  validateRefactoring,
  applyRefactoringInMemory,
} from "../src/validation/validator.js";
import { generateReport } from "../src/reporting/reportGenerator.js";
import type { CodeSmell } from "../src/types/ast.types.js";
import type { RefactoringResult } from "../src/types/refactor.types.js";
import type { OptimizedPayload } from "../src/types/slicer.types.js";

describe("Validation & Trivia Regressions", () => {
  describe("1. Syntax Validation: Node Kind and Snippet Wrapping", () => {
    it("successfully validates class method snippets when nodeKind is method", () => {
      const methodSnippet = `calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}`;
      const result = validateSyntax(methodSnippet, {
        filePath: "ShoppingCart.ts",
        nodeKind: "method",
      });

      expect(result.syntaxValid).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("rejects genuinely malformed method snippets even when wrapped", () => {
      const malformedMethod = `calculateTotal(items: number[]): number {
  return items.reduce((sum, item => sum + item, 0);`;
      const result = validateSyntax(malformedMethod, {
        filePath: "ShoppingCart.ts",
        nodeKind: "method",
      });

      expect(result.syntaxValid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it("successfully validates standard function declarations without wrapping", () => {
      const functionSnippet = `function computeAverage(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}`;
      const result = validateSyntax(functionSnippet, {
        filePath: "mathUtils.ts",
        nodeKind: "function",
      });

      expect(result.syntaxValid).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe("2. Trivia Preservation: CRLF and Inline Comment Placement", () => {
    it("handles Windows CRLF line endings without duplicating JSDoc comments", () => {
      const crlfCode = "/**\r\n * Multiplies a value.\r\n */\r\nfunction multiply(a: number, b: number): number {\r\n  return a * b;\r\n}";
      const trivia = {
        leadingComments: [],
        trailingComments: [],
        jsDoc: ["/**\r\n * Multiplies a value.\r\n */"],
      };

      // Proposed code with LF ending but containing the same JSDoc
      const proposedCode = "/**\n * Multiplies a value.\n */\nfunction multiply(a: number, b: number): number {\n  return a * b;\n}";
      const result = reconcileTriviaWithAst(proposedCode, trivia);

      expect(result.triviaPreserved).toBe(true);
      // Ensure the JSDoc was NOT duplicated
      const matches = result.reconciledCode.match(/Multiplies a value/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });

    it("attaches inline comments inside the function body when parameters use destructuring", () => {
      const funcWithDestructuring = `function processUser({ id, name }: { id: string; name: string }): string {
  return "user: " + name;
}`;
      const trivia = {
        leadingComments: [],
        trailingComments: [],
        jsDoc: [],
        inlineComments: ["// Note: validated input"],
      };

      const result = reconcileTriviaWithAst(funcWithDestructuring, trivia);

      expect(result.triviaPreserved).toBe(true);
      // The inline comment must be inside the body, AFTER the parameters
      const commentIndex = result.reconciledCode.indexOf("// Note: validated input");
      const paramEndIndex = result.reconciledCode.indexOf("): string {");

      expect(commentIndex).toBeGreaterThan(paramEndIndex);
      // Ensure the function remains syntactically valid TypeScript
      const syntax = validateSyntax(result.reconciledCode);
      expect(syntax.syntaxValid).toBe(true);
    });
  });

  describe("3. In-Memory Slicing and File Replacement", () => {
    it("safely replaces target snippet in full file even when comments contain special regex characters", () => {
      const fullFile = `// Header [A-Z]+ $1
function originalTarget(x) {
  return x + 1;
}
// Footer $&`;
      const originalCode = `function originalTarget(x) {
  return x + 1;
}`;
      const refactoredCode = `function originalTarget(x: number): number {
  return x + 1;
}`;

      const updated = applyRefactoringInMemory(fullFile, originalCode, refactoredCode);

      expect(updated).toContain("function originalTarget(x: number): number");
      expect(updated).toContain("// Header [A-Z]+ $1");
      expect(updated).toContain("// Footer $&");
    });
  });

  describe("4. Type Validation: Ambient Signatures and Baseline Diagnostics", () => {
    it("validates cross-file calls using provided dependencySignatures", () => {
      const codeUsingDependency = `function fetchScore(userId: string): Promise<UserScore> {
  return calculateScore(userId);
}`;
      const result = validateTypes(codeUsingDependency, {
        targetFile: "service.ts",
        dependencySignatures: [
          {
            filePath: "types.ts",
            signatures: ["interface UserScore { score: number; }"],
          },
          {
            filePath: "scoring.ts",
            signatures: ["function calculateScore(id: string): Promise<UserScore>;"],
          },
        ],
      });

      expect(result.typeSafe).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("filters out pre-existing baseline type errors in untyped original code", () => {
      const untypedOriginal = `function legacy(a, b) {
  return a + b;
}`;
      const typedRefactored = `function legacy(a: number, b: number): number {
  return a + b;
}`;

      const result = validateTypes(typedRefactored, {
        originalCode: untypedOriginal,
        targetFile: "legacy.ts",
      });

      expect(result.typeSafe).toBe(true);
    });
  });

  describe("5. Validation Result Metadata Preservation on Failure", () => {
    it("preserves targetNodeId, nodeName, nodeKind, and beforeSmells when Stage 5 refactoring fails", async () => {
      const smell: CodeSmell = {
        type: "untyped-signature",
        message: "Missing parameter types",
        filePath: "src/legacy.js",
        line: 1,
      };

      const payload: OptimizedPayload = {
        context: {
          targetCode: "function add(a, b) { return a + b; }",
          targetFile: "src/legacy.js",
          nodeKind: "function",
          name: "add",
          startLine: 1,
          endLine: 3,
          smells: [smell],
          trivia: { leadingComments: [], trailingComments: [], jsDoc: [] },
          dependencies: [],
          imports: [],
        },
        metrics: {
          originalCharacters: 100,
          optimizedCharacters: 50,
          estimatedOriginalTokens: 25,
          estimatedOptimizedTokens: 12,
          estimatedTokenSavings: 13,
          tokenReductionPercentage: 52,
        },
      };

      const failedResult: RefactoringResult = {
        success: false,
        strategy: "llm",
        originalCode: payload.context.targetCode,
        refactoredCode: "",
        explanation: "",
        changes: [],
        targetFile: "src/legacy.js",
        targetNodeId: "src/legacy.js::add",
        nodeName: "add",
        nodeKind: "function",
        error: "LLM transformation failed: ANTHROPIC_API_KEY is not set",
      };

      const validation = await validateRefactoring(payload, failedResult);

      expect(validation.valid).toBe(false);
      expect(validation.targetFile).toBe("src/legacy.js");
      expect(validation.nodeName).toBe("add");
      expect(validation.nodeKind).toBe("function");
      expect(validation.beforeSmellCount).toBe(1);
      expect(validation.beforeSmells).toHaveLength(1);
      expect(validation.beforeSmells[0].type).toBe("untyped-signature");
      expect(validation.afterSmellCount).toBe(1);
      expect(validation.error).toContain("ANTHROPIC_API_KEY is not set");
    });
  });

  describe("6. Reporting: Accurate Target Identifiers and Before/After Smells", () => {
    it("reports actual target function names and non-zero before smells for rejected transformations", () => {
      const smell: CodeSmell = {
        type: "callback-hell",
        message: "Deeply nested callback",
        filePath: "src/callbacks.js",
        line: 10,
      };

      const report = generateReport({
        projectRoot: "C:/test-project",
        validationResults: [
          {
            valid: false,
            syntaxValid: false,
            typeSafe: false,
            triviaPreserved: false,
            astReconciled: false,
            diagnostics: [
              {
                file: "src/callbacks.js",
                filePath: "src/callbacks.js",
                line: 10,
                column: 1,
                code: "STAGE5_REFACTORING_FAILED",
                message: "Missing API key",
                category: "error",
              },
            ],
            beforeSmells: [smell],
            afterSmells: [smell],
            fixedSmells: [],
            remainingSmells: [smell],
            beforeSmellCount: 1,
            afterSmellCount: 1,
            fixedSmellCount: 0,
            remainingSmellCount: 1,
            smellReductionPercentage: 0,
            refactoredCode: "function getUser() {}",
            originalCode: "function getUser() {}",
            strategy: "llm",
            targetFile: "src/callbacks.js",
            nodeName: "getUser",
            nodeKind: "function",
            targetNodeId: "src/callbacks.js::getUser",
            error: "Missing API key",
          },
        ],
      });

      expect(report.refactoringActivity.rejectedTransformations).toBe(1);
      expect(report.individualResults).toHaveLength(1);
      const item = report.individualResults[0];
      expect(item.target).toBe("src/callbacks.js::getUser");
      expect(item.nodeName).toBe("getUser");
      expect(item.beforeSmells).toEqual(["callback-hell"]);
      expect(item.status).toBe("rejected");
      expect(item.reason).toBe("Missing API key");
      expect(report.validation.rejectedReasons[0].target).toBe("src/callbacks.js::getUser");
    });
  });
});
