/**
 * Stage 5: Hybrid Refactoring Router
 * Inspects Stage 4 OptimizedPayload, decides whether to route to Mechanical AST
 * or LLM Semantic transformation, and produces a proposed RefactoringResult.
 *
 * Safety: NEVER modifies files on disk. Produces an in-memory proposed result for Stage 6.
 */
import { Project } from "ts-morph";
import type { CodeSmell } from "../types/ast.types.js";
import type { OptimizedPayload } from "../types/slicer.types.js";
import type {
  RefactorRouterOptions,
  RefactoringResult,
  RefactoringStrategy,
} from "../types/refactor.types.js";
import { applyMechanicalRefactoring } from "./mechanicalRefactor.js";
import { generateStructuredRefactor, pickModelTier } from "../agent/llmClient.js";
import { reconcileTrivia } from "../parser/triviaPreserver.js";

const MECHANICAL_SMELLS = new Set(["var-usage", "unused-import"]);

const SEMANTIC_SMELLS = new Set([
  "untyped-signature",
  "missing-return-type",
  "callback-hell",
  "implicit-any",
  "any-usage",
  "long-function",
  "deep-nesting",
  "no-error-handling",
  "duplicate-logic",
  "high-complexity",
]);

/**
 * Checks whether a given smell type is recognized and supported by the refactoring engine.
 */
export function isSupportedSmell(smellType: string): boolean {
  return MECHANICAL_SMELLS.has(smellType) || SEMANTIC_SMELLS.has(smellType);
}

/**
 * Determines whether a collection of code smells can be handled by deterministic mechanical rules
 * or requires semantic LLM reasoning.
 */
export function determineRefactoringStrategy(smells: CodeSmell[]): RefactoringStrategy {
  if (smells.length === 0) {
    return "mechanical";
  }

  // If any smell requires semantic reasoning, route to LLM
  const hasSemantic = smells.some((s) => SEMANTIC_SMELLS.has(s.type));
  if (hasSemantic) {
    return "llm";
  }

  // If all smells are mechanical
  return "mechanical";
}

/**
 * Validates that refactored code has valid TypeScript syntax.
 */
function validateTypeScriptSyntax(
  code: string,
  options: { nodeKind?: string; filePath?: string } = {},
): { isValid: boolean; error?: string } {
  try {
    const isJs = options.filePath?.endsWith(".js") || options.filePath?.endsWith(".jsx");
    const isMethod = options.nodeKind === "method" || options.nodeKind === "constructor";

    const createProj = () =>
      new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          skipLibCheck: true,
        },
      });

    if (isMethod) {
      const proj = createProj();
      const sf = proj.createSourceFile(
        isJs ? "validate.js" : "validate.ts",
        `class __SnippetContainer__ {\n${code}\n}`,
      );
      const syntacticDiagnostics = proj.getProgram().compilerObject.getSyntacticDiagnostics(sf.compilerNode);
      const syntaxErrors = syntacticDiagnostics.filter((d) => d.category === 1);
      if (syntaxErrors.length === 0) {
        return { isValid: true };
      }
    }

    const project = createProj();
    const sourceFile = project.createSourceFile(
      isJs ? "validate.js" : "validate.ts",
      code,
    );
    const program = project.getProgram().compilerObject;
    const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile.compilerNode);
    const syntaxErrors = syntacticDiagnostics.filter((d) => d.category === 1); // DiagnosticCategory.Error

    if (syntaxErrors.length > 0) {
      // Check if wrapping inside a class container resolves class member syntax
      const wrapProj = createProj();
      const wrapSf = wrapProj.createSourceFile(
        isJs ? "validate.js" : "validate.ts",
        `class __SnippetContainer__ {\n${code}\n}`,
      );
      const wrapDiag = wrapProj.getProgram().compilerObject.getSyntacticDiagnostics(wrapSf.compilerNode);
      const wrapErrors = wrapDiag.filter((d) => d.category === 1);
      if (wrapErrors.length === 0) {
        return { isValid: true };
      }

      const messages = syntaxErrors
        .map((d) => (typeof d.messageText === "string" ? d.messageText : d.messageText.messageText))
        .join("; ");
      return { isValid: false, error: messages };
    }

    return { isValid: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isValid: false, error: msg };
  }
}

/**
 * Main Stage 5 Entrypoint:
 * Routes and transforms the target code from a Stage 4 OptimizedPayload.
 */
export async function routeAndRefactor(
  payload: OptimizedPayload,
  options: RefactorRouterOptions = {},
): Promise<RefactoringResult> {
  const originalCode = payload.context.targetCode;
  const smells = payload.context.smells;

  // 1. Check for unsupported smells
  const unsupported = smells.filter((s) => !isSupportedSmell(s.type));
  if (unsupported.length > 0) {
    return {
      success: false,
      strategy: "mechanical",
      originalCode,
      refactoredCode: originalCode,
      explanation: `Unsupported code smell(s) cannot be safely transformed: ${unsupported.map((s) => s.type).join(", ")}`,
      changes: [],
      error: `Unsupported smell: ${unsupported[0].type}`,
    };
  }

  // 2. Decide Strategy
  const strategy: RefactoringStrategy =
    options.forceStrategy ?? determineRefactoringStrategy(smells);

  // 3. Mechanical Transformation Path (Zero LLM calls)
  if (strategy === "mechanical") {
    const mechanicalResult = applyMechanicalRefactoring(
      originalCode,
      smells,
      payload.context.trivia,
    );

    return {
      ...mechanicalResult,
      targetFile: payload.context.targetFile,
      nodeKind: payload.context.nodeKind,
      nodeName: payload.context.name,
      startLine: payload.context.startLine,
      endLine: payload.context.endLine,
    };
  }

  // 4. LLM Semantic Transformation Path
  try {
    const tier = pickModelTier({
      complexity: smells.some((s) => s.type === "high-complexity") ? 15 : 1,
      smells,
    });

    const llmResponse = await generateStructuredRefactor(payload, tier, {
      mockResponse: options.mockLlmResponse,
    });

    if (!llmResponse || typeof llmResponse !== "object") {
      return {
        success: false,
        strategy: "llm",
        originalCode,
        refactoredCode: originalCode,
        explanation: "LLM returned an empty or invalid response object.",
        changes: [],
        error: "Empty or malformed LLM response",
      };
    }

    if (!llmResponse.success) {
      return {
        success: false,
        strategy: "llm",
        originalCode,
        refactoredCode: originalCode,
        explanation: llmResponse.explanation || "LLM failed to refactor target code.",
        changes: [],
        error: "LLM reported failure",
      };
    }

    if (!llmResponse.refactoredCode || llmResponse.refactoredCode.trim().length === 0) {
      return {
        success: false,
        strategy: "llm",
        originalCode,
        refactoredCode: originalCode,
        explanation: "LLM returned an empty refactored code body.",
        changes: [],
        error: "Empty refactored code from LLM",
      };
    }

    // Validate TypeScript syntax of proposed refactored code
    if (!options.skipSyntaxValidation) {
      const syntaxCheck = validateTypeScriptSyntax(llmResponse.refactoredCode, {
        nodeKind: payload.context.nodeKind,
        filePath: payload.context.targetFile,
      });
      if (!syntaxCheck.isValid) {
        return {
          success: false,
          strategy: "llm",
          originalCode,
          refactoredCode: originalCode,
          explanation: `LLM proposed code failed TypeScript syntax validation: ${syntaxCheck.error}`,
          changes: [],
          error: syntaxCheck.error,
          targetFile: payload.context.targetFile,
          nodeKind: payload.context.nodeKind,
          nodeName: payload.context.name,
          startLine: payload.context.startLine,
          endLine: payload.context.endLine,
        };
      }
    }

    // Reconcile trivia to guarantee comments are preserved
    let finalCode = llmResponse.refactoredCode;
    if (payload.context.trivia) {
      finalCode = reconcileTrivia(finalCode, payload.context.trivia);
    }

    return {
      success: true,
      strategy: "llm",
      originalCode,
      refactoredCode: finalCode,
      explanation: llmResponse.explanation,
      changes: llmResponse.changes.map((c) => ({
        smellType: c.type,
        description: c.description,
      })),
      targetFile: payload.context.targetFile,
      nodeKind: payload.context.nodeKind,
      nodeName: payload.context.name,
      startLine: payload.context.startLine,
      endLine: payload.context.endLine,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      strategy: "llm",
      originalCode,
      refactoredCode: originalCode,
      explanation: `LLM transformation failed: ${msg}`,
      changes: [],
      error: msg,
      targetFile: payload.context.targetFile,
      nodeKind: payload.context.nodeKind,
      nodeName: payload.context.name,
      startLine: payload.context.startLine,
      endLine: payload.context.endLine,
    };
  }
}
