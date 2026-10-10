/**
 * Stage 6: Validation, Trivia Reconciliation & Re-analysis Engine
 *
 * Verifies that proposed refactorings from Stage 5 are safe, syntactically valid,
 * type-safe, trivia-preserving, and truly reduce code smells BEFORE any changes are written.
 *
 * Safety: ALWAYS operates in-memory. NEVER writes changes to disk unless fully validated.
 */
import {
  Project,
  ScriptTarget,
  ModuleKind,
  ModuleResolutionKind,
  Node,
  SourceFile,
  ts,
} from "ts-morph";
import type { CodeSmell, AstEngineOptions } from "../types/ast.types.js";
import type {
  RefactoringResult,
  RefactoringStrategy,
} from "../types/refactor.types.js";
import type {
  TokenMetrics,
  TriviaMetadata,
  OptimizedPayload,
  DependencySignature,
} from "../types/slicer.types.js";
import type { WorkspaceResult } from "../types/workspace.types.js";
import type {
  ValidationDiagnostic,
  SyntaxValidationResult,
  TypeValidationResult,
  TriviaReconciliationResult,
  AstReconciliationResult,
  SmellComparisonResult,
  ValidationMetrics,
  ValidationResearchMetrics,
  ValidationResult,
  ValidationOptions,
} from "../types/validation.types.js";
import { parseSourceFile } from "../parser/astEngine.js";
import { extractTriviaFromText, reconcileTrivia } from "../parser/triviaPreserver.js";
import { normalizePath } from "../planner/dependencyGraph.js";

/**
 * Converts a TypeScript compiler diagnostic into a structured ValidationDiagnostic.
 */
function toValidationDiagnostic(
  diagnostic: ts.Diagnostic,
  sourceFile?: SourceFile,
  fallbackFile = "unknown.ts",
): ValidationDiagnostic {
  let file = fallbackFile;
  let line = 1;
  let column = 1;

  if (sourceFile) {
    file = sourceFile.getFilePath();
    if (diagnostic.start !== undefined) {
      const pos = sourceFile.getLineAndColumnAtPos(diagnostic.start);
      line = pos.line;
      column = pos.column;
    }
  } else if (diagnostic.file && diagnostic.start !== undefined) {
    file = diagnostic.file.fileName;
    const lc = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    line = lc.line + 1;
    column = lc.character + 1;
  }

  let message = "";
  if (typeof diagnostic.messageText === "string") {
    message = diagnostic.messageText;
  } else if (diagnostic.messageText) {
    message = diagnostic.messageText.messageText;
  }

  let category: "error" | "warning" | "suggestion" | "message" = "error";
  if (diagnostic.category === ts.DiagnosticCategory.Warning) category = "warning";
  else if (diagnostic.category === ts.DiagnosticCategory.Suggestion) category = "suggestion";
  else if (diagnostic.category === ts.DiagnosticCategory.Message) category = "message";

  return {
    file,
    filePath: file,
    line,
    column,
    code: diagnostic.code,
    message,
    category,
  };
}

/**
 * 2. SYNTAX VALIDATION
 * Parses the proposed source using ts-morph and detects syntax errors,
 * malformed TypeScript, invalid AST, and incomplete generated code.
 */
export function validateSyntax(
  code: string,
  options: { filePath?: string; nodeKind?: string } = {},
): SyntaxValidationResult {
  const filePath = options.filePath ?? "validate.ts";

  if (!code || code.trim().length === 0) {
    return {
      syntaxValid: false,
      diagnostics: [
        {
          file: filePath,
          filePath,
          line: 1,
          column: 1,
          code: "SYNTAX_INCOMPLETE",
          message: "Proposed refactored code is empty or incomplete.",
          category: "error",
        },
      ],
      error: "Proposed refactored code is empty or incomplete.",
    };
  }

  try {
    const isJs = filePath.endsWith(".js") || filePath.endsWith(".jsx");
    const isMethod = options.nodeKind === "method" || options.nodeKind === "constructor";

    const createProj = () =>
      new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
          target: ScriptTarget.ES2022,
          module: ModuleKind.NodeNext,
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
      const syntaxErrors = syntacticDiagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (syntaxErrors.length === 0) {
        return {
          syntaxValid: true,
          diagnostics: [],
        };
      }
    }

    const project = createProj();
    const sourceFile = project.createSourceFile(
      isJs ? "validate.js" : "validate.ts",
      code,
    );

    const program = project.getProgram().compilerObject;
    const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile.compilerNode);
    const syntaxErrors = syntacticDiagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );

    if (syntaxErrors.length > 0) {
      // Check if wrapping inside a class container resolves class member syntax
      const wrapProj = createProj();
      const wrapSf = wrapProj.createSourceFile(
        isJs ? "validate.js" : "validate.ts",
        `class __SnippetContainer__ {\n${code}\n}`,
      );
      const wrapDiag = wrapProj.getProgram().compilerObject.getSyntacticDiagnostics(wrapSf.compilerNode);
      const wrapErrors = wrapDiag.filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (wrapErrors.length === 0) {
        return {
          syntaxValid: true,
          diagnostics: [],
        };
      }

      const diagnostics = syntaxErrors.map((d) =>
        toValidationDiagnostic(d, sourceFile, filePath),
      );
      return {
        syntaxValid: false,
        diagnostics,
        error: diagnostics.map((d) => d.message).join("; "),
      };
    }

    return {
      syntaxValid: true,
      diagnostics: [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      syntaxValid: false,
      diagnostics: [
        {
          file: filePath,
          filePath,
          line: 1,
          column: 1,
          code: "SYNTAX_PARSE_ERROR",
          message: msg,
          category: "error",
        },
      ],
      error: msg,
    };
  }
}

/**
 * 3. TYPE VALIDATION
 * Checks whether the proposed transformation introduces:
 * - type errors
 * - unresolved symbols
 * - invalid assignments
 * - invalid return types
 * - broken imports
 * - incompatible function signatures
 */
export function validateTypes(
  code: string,
  options: {
    originalCode?: string;
    targetFile?: string;
    workspace?: WorkspaceResult | Project;
    fullFileCode?: string;
    strictTypeCheck?: boolean;
    dependencySignatures?: DependencySignature[];
    tsConfigFilePath?: string;
  } = {},
): TypeValidationResult {
  const filePath = options.targetFile ?? "validate.ts";
  const projectOrWorkspace = options.workspace;

  // Workspace-aware validation: check within workspace project context
  if (projectOrWorkspace) {
    const project = "project" in projectOrWorkspace ? projectOrWorkspace.project : projectOrWorkspace;
    const normalizedTarget = options.targetFile ? normalizePath(options.targetFile) : undefined;
    const existingFile = options.targetFile
      ? project.getSourceFile(options.targetFile) ?? (normalizedTarget ? project.getSourceFile(normalizedTarget) : undefined)
      : undefined;

    if (existingFile) {
      const originalFileContent = existingFile.getFullText();
      let proposedContent = options.fullFileCode ?? code;

      // If fullFileCode was not passed, apply slice replacement in memory
      if (!options.fullFileCode && options.originalCode && options.originalCode !== originalFileContent) {
        proposedContent = applyRefactoringInMemory(originalFileContent, options.originalCode, code);
      }

      try {
        const progBefore = project.getProgram().compilerObject;
        const baselineDiagnostics = progBefore.getSemanticDiagnostics(existingFile.compilerNode)
          .filter((d) => d.category === ts.DiagnosticCategory.Error);
        const baselineErrorKeys = new Set(
          baselineDiagnostics.map((d) => {
            const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
            return `${d.code}:${msg}`;
          }),
        );

        existingFile.replaceWithText(proposedContent);
        const prog = project.getProgram().compilerObject;
        const semDiagnostics = prog.getSemanticDiagnostics(existingFile.compilerNode);
        const typeErrors = semDiagnostics.filter(
          (d) => d.category === ts.DiagnosticCategory.Error,
        );

        const newErrors = options.strictTypeCheck
          ? typeErrors
          : typeErrors.filter((d) => {
              const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
              return !baselineErrorKeys.has(`${d.code}:${msg}`);
            });

        const diagnostics = newErrors.map((d) =>
          toValidationDiagnostic(d, existingFile, existingFile.getFilePath()),
        );

        return {
          typeSafe: diagnostics.length === 0,
          diagnostics,
          error: diagnostics.length > 0 ? diagnostics.map((d) => d.message).join("; ") : undefined,
        };
      } finally {
        // ALWAYS restore original source file text to preserve workspace integrity
        existingFile.replaceWithText(originalFileContent);
      }
    }
  }

  // Standalone / In-memory validation
  try {
    const isJs = filePath.endsWith(".js") || filePath.endsWith(".jsx");
    const activeCode = options.fullFileCode ?? code;

    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: ScriptTarget.ES2022,
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        strict: options.strictTypeCheck !== false,
        noImplicitAny: options.strictTypeCheck !== false,
        allowJs: true,
        checkJs: isJs ? false : true,
        skipLibCheck: true,
      },
    });

    // Provide ambient signatures for cross-file symbols so dependencies are resolved
    if (options.dependencySignatures && options.dependencySignatures.length > 0) {
      const declLines: string[] = [];
      for (const dep of options.dependencySignatures) {
        declLines.push(...dep.signatures);
      }
      if (declLines.length > 0) {
        project.createSourceFile("ambient_dependencies.d.ts", declLines.join("\n"));
      }
    }

    // Baseline diagnostics check on original code (if provided) to isolate newly introduced errors
    let baselineErrorKeys = new Set<string>();
    if (options.originalCode && !options.strictTypeCheck) {
      try {
        const origSf = project.createSourceFile(
          isJs ? "orig_validate.js" : "orig_validate.ts",
          options.originalCode,
        );
        const origSem = project.getProgram().compilerObject.getSemanticDiagnostics(origSf.compilerNode);
        const origErrors = origSem.filter((d) => d.category === ts.DiagnosticCategory.Error);
        baselineErrorKeys = new Set(
          origErrors.map((d) => {
            const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
            return `${d.code}:${msg}`;
          }),
        );
        project.removeSourceFile(origSf);
      } catch {
        // Ignore baseline setup errors
      }
    }

    const sourceFile = project.createSourceFile(
      isJs ? "validate.js" : "validate.ts",
      activeCode,
    );

    const program = project.getProgram().compilerObject;
    const semanticDiagnostics = program.getSemanticDiagnostics(sourceFile.compilerNode);
    const typeErrors = semanticDiagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );

    const newErrors = options.strictTypeCheck
      ? typeErrors
      : typeErrors.filter((d) => {
          const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
          return !baselineErrorKeys.has(`${d.code}:${msg}`);
        });

    if (newErrors.length > 0) {
      const diagnostics = newErrors.map((d) =>
        toValidationDiagnostic(d, sourceFile, filePath),
      );
      return {
        typeSafe: false,
        diagnostics,
        error: diagnostics.map((d) => d.message).join("; "),
      };
    }

    return {
      typeSafe: true,
      diagnostics: [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      typeSafe: false,
      diagnostics: [
        {
          file: filePath,
          filePath,
          line: 1,
          column: 1,
          code: "TYPE_VALIDATION_ERROR",
          message: msg,
          category: "error",
        },
      ],
      error: msg,
    };
  }
}

function insertInlineCommentIntoBody(code: string, comment: string): string | null {
  const cleanComment = comment.trim();
  if (!cleanComment) return null;

  // Search for the function/method block opening brace '{' AFTER parameter closing ')'
  const closingParenIdx = code.indexOf(")");
  const searchStart = closingParenIdx !== -1 ? closingParenIdx : 0;
  const bodyBraceIdx = code.indexOf("{", searchStart);
  if (bodyBraceIdx !== -1) {
    return (
      code.slice(0, bodyBraceIdx + 1) +
      `\n  ${cleanComment}\n` +
      code.slice(bodyBraceIdx + 1)
    );
  }

  // Fallback for expression arrow functions: append comment safely
  const arrowIdx = code.indexOf("=>");
  if (arrowIdx !== -1) {
    return `${code} // ${cleanComment.replace(/^\/\/|^\/\*|\*\/$/g, "").trim()}`;
  }

  return null;
}

/**
 * 4. TRIVIA RECONCILIATION
 * Reconciles preserved JSDoc, leading comments, inline comments, and trailing comments
 * with the generated AST to guarantee documentation is not silently lost.
 */
export function reconcileTriviaWithAst(
  refactoredCode: string,
  triviaOrOriginalCode: TriviaMetadata | string,
): TriviaReconciliationResult {
  const trivia =
    typeof triviaOrOriginalCode === "string"
      ? extractTriviaFromText(triviaOrOriginalCode)
      : triviaOrOriginalCode;

  let reconciledCode = refactoredCode;
  let missingTriviaCount = 0;
  let preservedTriviaCount = 0;

  // 1. Reconcile missing JSDoc and leading comments using existing triviaPreserver
  reconciledCode = reconcileTrivia(reconciledCode, trivia);

  // 2. Reconcile missing inline comments into block bodies
  if (trivia.inlineComments && trivia.inlineComments.length > 0) {
    for (const inlineComment of trivia.inlineComments) {
      const cleanComment = inlineComment.trim();
      if (!cleanComment) continue;

      const normReconciled = reconciledCode.replace(/\r\n/g, "\n");
      const normComment = cleanComment.replace(/\r\n/g, "\n");

      if (normReconciled.includes(normComment)) {
        preservedTriviaCount++;
      } else {
        const inserted = insertInlineCommentIntoBody(reconciledCode, cleanComment);
        if (inserted !== null) {
          reconciledCode = inserted;
          preservedTriviaCount++;
        } else {
          missingTriviaCount++;
        }
      }
    }
  }

  // 3. Reconcile trailing comments
  if (trivia.trailingComments && trivia.trailingComments.length > 0) {
    for (const trailing of trivia.trailingComments) {
      const cleanTrailing = trailing.trim();
      if (!cleanTrailing) continue;

      const normReconciled = reconciledCode.replace(/\r\n/g, "\n");
      const normTrailing = cleanTrailing.replace(/\r\n/g, "\n");

      if (normReconciled.includes(normTrailing)) {
        preservedTriviaCount++;
      } else {
        reconciledCode = `${reconciledCode}\n${cleanTrailing}`;
        preservedTriviaCount++;
      }
    }
  }

  // Verify all JSDoc and leading comments are preserved
  const normFinal = reconciledCode.replace(/\r\n/g, "\n");

  for (const doc of trivia.jsDoc) {
    const normDoc = doc.replace(/\r\n/g, "\n").trim();
    if (!normDoc) continue;
    if (normFinal.includes(normDoc)) {
      preservedTriviaCount++;
    } else {
      missingTriviaCount++;
    }
  }
  for (const lead of trivia.leadingComments) {
    const normLead = lead.replace(/\r\n/g, "\n").trim();
    if (!normLead) continue;
    const inJsDoc = trivia.jsDoc.some((d) => d.replace(/\r\n/g, "\n").trim() === normLead);
    if (inJsDoc) continue;

    if (normFinal.includes(normLead)) {
      preservedTriviaCount++;
    } else {
      missingTriviaCount++;
    }
  }

  const triviaPreserved = missingTriviaCount === 0;

  return {
    triviaPreserved,
    reconciledCode,
    missingTriviaCount,
    preservedTriviaCount,
  };
}

/**
 * 5. AST RECONCILIATION
 * Compares the original target AST against the generated target AST to ensure:
 * - target still exists
 * - surrounding source structure remains valid
 * - imports remain valid
 * - exported APIs are not accidentally removed
 * - unrelated nodes are not modified
 */
export function reconcileAst(
  originalCode: string,
  refactoredCode: string,
  options: {
    targetName?: string;
    nodeKind?: string;
    fullOriginalFile?: string;
    fullRefactoredFile?: string;
  } = {},
): AstReconciliationResult {
  try {
    const origProject = new Project({ useInMemoryFileSystem: true });
    const refProject = new Project({ useInMemoryFileSystem: true });

    const origSf = origProject.createSourceFile("orig.ts", originalCode);
    const refSf = refProject.createSourceFile("ref.ts", refactoredCode);

    // 1. Target still exists
    let targetStillExists = true;
    if (options.targetName && options.targetName !== "<anonymous>") {
      const targetName = options.targetName;
      const allOrigNames = [
        ...origSf.getFunctions().map((f) => f.getName()),
        ...origSf.getClasses().map((c) => c.getName()),
        ...origSf.getInterfaces().map((i) => i.getName()),
        ...origSf.getTypeAliases().map((t) => t.getName()),
        ...origSf.getVariableDeclarations().map((d) => d.getName()),
      ].filter(Boolean) as string[];

      // Only assert target still exists if it existed in original code
      if (allOrigNames.includes(targetName)) {
        const allRefNames = [
          ...refSf.getFunctions().map((f) => f.getName()),
          ...refSf.getClasses().map((c) => c.getName()),
          ...refSf.getInterfaces().map((i) => i.getName()),
          ...refSf.getTypeAliases().map((t) => t.getName()),
          ...refSf.getVariableDeclarations().map((d) => d.getName()),
        ].filter(Boolean) as string[];

        if (!allRefNames.includes(targetName)) {
          targetStillExists = false;
          return {
            astReconciled: false,
            targetStillExists: false,
            exportedApisPreserved: true,
            unrelatedNodesUnmodified: true,
            reason: `Target declaration "${targetName}" was not found in refactored AST.`,
          };
        }
      }
    }

    // 2. Exported APIs are preserved
    let exportedApisPreserved = true;
    const origExports = origSf.getExportedDeclarations();
    const refExports = refSf.getExportedDeclarations();

    for (const [expName] of origExports) {
      if (!refExports.has(expName)) {
        // Check if CommonJS module.exports preserved
        const refHasCjs = refSf.getText().includes(expName);
        if (!refHasCjs) {
          exportedApisPreserved = false;
          return {
            astReconciled: false,
            targetStillExists: true,
            exportedApisPreserved: false,
            unrelatedNodesUnmodified: true,
            reason: `Exported declaration "${expName}" was removed from refactored code.`,
          };
        }
      }
    }

    // 3. Unrelated nodes unmodified (when inspecting enclosing full file)
    let unrelatedNodesUnmodified = true;
    if (options.fullOriginalFile && options.fullRefactoredFile) {
      const fullOrigSf = origProject.createSourceFile("fullOrig.ts", options.fullOriginalFile);
      const fullRefSf = refProject.createSourceFile("fullRef.ts", options.fullRefactoredFile);

      const origTopDecls = fullOrigSf.getFunctions().map((f) => f.getName());
      const refTopDecls = fullRefSf.getFunctions().map((f) => f.getName());

      for (const declName of origTopDecls) {
        if (!declName || declName === options.targetName) continue;
        if (!refTopDecls.includes(declName)) {
          unrelatedNodesUnmodified = false;
          return {
            astReconciled: false,
            targetStillExists: true,
            exportedApisPreserved: true,
            unrelatedNodesUnmodified: false,
            reason: `Unrelated declaration "${declName}" was unexpectedly altered or removed.`,
          };
        }
      }
    }

    return {
      astReconciled: true,
      targetStillExists,
      exportedApisPreserved,
      unrelatedNodesUnmodified,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      astReconciled: false,
      targetStillExists: false,
      exportedApisPreserved: false,
      unrelatedNodesUnmodified: false,
      reason: `AST reconciliation failed: ${msg}`,
    };
  }
}

/**
 * 6. RE-ANALYSIS
 * Runs the Stage 2 AST analyzer on the in-memory refactored code and compares
 * code smells Before vs After.
 */
export function reanalyzeSmells(
  refactoredCode: string,
  beforeSmellsOrOriginalCode: CodeSmell[] | string,
  options: {
    filePath?: string;
    astOptions?: AstEngineOptions;
  } = {},
): SmellComparisonResult {
  const filePath = options.filePath ?? "reanalyze.ts";

  // 1. Determine before smells
  let beforeSmells: CodeSmell[];
  if (Array.isArray(beforeSmellsOrOriginalCode)) {
    beforeSmells = beforeSmellsOrOriginalCode;
  } else {
    const project = new Project({ useInMemoryFileSystem: true });
    const origSf = project.createSourceFile("original.ts", beforeSmellsOrOriginalCode);
    const beforeResult = parseSourceFile(origSf, options.astOptions);
    beforeSmells = beforeResult.smells ?? [];
  }

  // 2. Re-analyze after smells on proposed refactored code
  const project = new Project({ useInMemoryFileSystem: true });
  const isJs = filePath.endsWith(".js") || filePath.endsWith(".jsx");
  const refSf = project.createSourceFile(
    isJs ? "refactored.js" : "refactored.ts",
    refactoredCode,
  );
  const afterResult = parseSourceFile(refSf, options.astOptions);
  const afterSmells = afterResult.smells ?? [];

  // 3. Match smells to identify Fixed vs Remaining
  const fixedSmells: CodeSmell[] = [];
  const remainingSmells: CodeSmell[] = [];
  const newSmells: CodeSmell[] = [];

  const remainingAfterSmells = [...afterSmells];

  for (const beforeSmell of beforeSmells) {
    const matchingIdx = remainingAfterSmells.findIndex(
      (s) => s.type === beforeSmell.type,
    );

    if (matchingIdx !== -1) {
      remainingSmells.push(remainingAfterSmells[matchingIdx]);
      remainingAfterSmells.splice(matchingIdx, 1);
    } else {
      fixedSmells.push(beforeSmell);
    }
  }

  // Any leftover smells in afterSmells are new smells introduced by transformation
  for (const extra of remainingAfterSmells) {
    newSmells.push(extra);
    remainingSmells.push(extra);
  }

  const beforeSmellCount = beforeSmells.length;
  const afterSmellCount = afterSmells.length;
  const fixedSmellCount = fixedSmells.length;
  const remainingSmellCount = afterSmells.length;

  let smellReductionPercentage = 0;
  if (beforeSmellCount === 0) {
    smellReductionPercentage = afterSmellCount === 0 ? 0 : -100;
  } else {
    smellReductionPercentage =
      ((beforeSmellCount - afterSmellCount) / beforeSmellCount) * 100;
  }

  return {
    beforeSmells,
    afterSmells,
    fixedSmells,
    remainingSmells,
    newSmells,
    beforeSmellCount,
    afterSmellCount,
    fixedSmellCount,
    remainingSmellCount,
    smellReductionPercentage,
  };
}

/**
 * 7. TECHNICAL DEBT METRICS
 * Computes exact before/after metrics and token savings.
 */
export function calculateSmellMetrics(
  beforeSmells: CodeSmell[],
  afterSmells: CodeSmell[],
  tokenMetrics?: TokenMetrics,
  strategy?: RefactoringStrategy,
): ValidationMetrics {
  const beforeSmellCount = beforeSmells.length;
  const afterSmellCount = afterSmells.length;

  const remainingTypes = [...afterSmells.map((s) => s.type)];
  let fixedSmellCount = 0;
  for (const before of beforeSmells) {
    const idx = remainingTypes.indexOf(before.type);
    if (idx !== -1) {
      remainingTypes.splice(idx, 1);
    } else {
      fixedSmellCount++;
    }
  }

  let smellReductionPercentage = 0;
  if (beforeSmellCount === 0) {
    smellReductionPercentage = afterSmellCount === 0 ? 0 : -100;
  } else {
    smellReductionPercentage =
      ((beforeSmellCount - afterSmellCount) / beforeSmellCount) * 100;
  }

  return {
    beforeSmellCount,
    afterSmellCount,
    fixedSmellCount,
    remainingSmellCount: afterSmellCount,
    smellReductionPercentage,
    syntaxErrorsCount: 0,
    typeErrorsCount: 0,
    tokenMetrics,
  };
}

/**
 * Helper to replace a target snippet inside a full file in memory.
 */
export function applyRefactoringInMemory(
  fullFileContent: string,
  originalCode: string,
  refactoredCode: string,
): string {
  if (fullFileContent === originalCode) {
    return refactoredCode;
  }
  if (fullFileContent.includes(originalCode)) {
    const origIdx = fullFileContent.indexOf(originalCode);
    let sliceStart = origIdx;

    const commentRegex = /(\/\*\*[\s\S]*?\*\/|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g;
    const refactoredComments: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = commentRegex.exec(refactoredCode)) !== null) {
      const beforeComment = refactoredCode.slice(0, match.index).trim();
      if (beforeComment.replace(/(\/\*\*[\s\S]*?\*\/|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g, "").trim() === "") {
        refactoredComments.push(match[0].trim());
      } else {
        break;
      }
    }

    for (const comment of refactoredComments) {
      const beforeTrimmed = fullFileContent.slice(0, sliceStart).trimEnd();
      const normBefore = beforeTrimmed.replace(/\r\n/g, "\n");
      const normComment = comment.replace(/\r\n/g, "\n");
      if (normBefore.endsWith(normComment)) {
        const commentIdx = fullFileContent.lastIndexOf(comment, sliceStart);
        if (commentIdx !== -1) {
          sliceStart = commentIdx;
        } else {
          const matchLen = comment.length;
          if (sliceStart >= matchLen) {
            sliceStart -= matchLen;
          }
        }
      }
    }

    return (
      fullFileContent.slice(0, sliceStart) +
      refactoredCode +
      fullFileContent.slice(origIdx + originalCode.length)
    );
  }
  return refactoredCode;
}

/**
 * 10. VALIDATION PIPELINE
 * Overloaded main entrypoint for Stage 6 validation.
 */
export async function validateRefactoring(
  originalCodeOrResultOrPayload: string | RefactoringResult | OptimizedPayload,
  refactoringResultOrOptions?: RefactoringResult | ValidationOptions,
  workspaceOrOptions?: WorkspaceResult | Project | ValidationOptions,
  explicitOptions?: ValidationOptions,
): Promise<ValidationResult> {
  let originalCode = "";
  let refactoringResult: RefactoringResult;
  let workspace: WorkspaceResult | Project | undefined;
  let options: ValidationOptions = {};
  let payload: OptimizedPayload | undefined;

  // Normalize overloaded arguments
  if (typeof originalCodeOrResultOrPayload === "string") {
    originalCode = originalCodeOrResultOrPayload;
    refactoringResult = refactoringResultOrOptions as RefactoringResult;
    if (workspaceOrOptions && ("projectRoot" in workspaceOrOptions || "createSourceFile" in workspaceOrOptions)) {
      workspace = workspaceOrOptions as WorkspaceResult | Project;
      options = explicitOptions ?? {};
    } else if (workspaceOrOptions) {
      options = workspaceOrOptions as ValidationOptions;
      workspace = options.workspace;
    }
  } else if ("context" in originalCodeOrResultOrPayload && "metrics" in originalCodeOrResultOrPayload) {
    // OptimizedPayload passed
    payload = originalCodeOrResultOrPayload as OptimizedPayload;
    originalCode = payload.context.targetCode;
    refactoringResult = refactoringResultOrOptions as RefactoringResult;
    if (workspaceOrOptions && ("projectRoot" in workspaceOrOptions || "createSourceFile" in workspaceOrOptions)) {
      workspace = workspaceOrOptions as WorkspaceResult | Project;
      options = explicitOptions ?? {};
    } else {
      options = (workspaceOrOptions as ValidationOptions) ?? {};
      workspace = options.workspace;
    }
    if (!options.tokenMetrics) options.tokenMetrics = payload.metrics;
    if (!options.trivia) options.trivia = payload.context.trivia;
    if (!options.targetFile) options.targetFile = payload.context.targetFile;
    if (!options.nodeName) options.nodeName = payload.context.name;
    if (!options.nodeKind) options.nodeKind = payload.context.nodeKind;
    if (!options.beforeSmells) options.beforeSmells = payload.context.smells;
    if (!options.dependencySignatures && payload.context.dependencies) options.dependencySignatures = payload.context.dependencies;
  } else {
    // RefactoringResult passed as first argument
    refactoringResult = originalCodeOrResultOrPayload as RefactoringResult;
    originalCode = refactoringResult.originalCode;
    options = (refactoringResultOrOptions as ValidationOptions) ?? {};
    workspace = options.workspace;
  }

  const targetFile = options.targetFile ?? refactoringResult.targetFile ?? payload?.context?.targetFile ?? "validate.ts";
  const nodeName = options.nodeName ?? refactoringResult.nodeName ?? payload?.context?.name;
  const nodeKind = options.nodeKind ?? refactoringResult.nodeKind ?? payload?.context?.nodeKind;
  const targetNodeId = options.targetNodeId ?? refactoringResult.targetNodeId;
  const taskId = options.taskId;
  const beforeSmells = options.beforeSmells ?? payload?.context?.smells ?? [];

  const allDiagnostics: ValidationDiagnostic[] = [];

  // If Stage 5 itself failed, reject immediately with failure result
  if (!refactoringResult.success) {
    return {
      valid: false,
      syntaxValid: false,
      typeSafe: false,
      triviaPreserved: false,
      astReconciled: false,
      diagnostics: [
        {
          file: targetFile,
          filePath: targetFile,
          line: 1,
          column: 1,
          code: "STAGE5_REFACTORING_FAILED",
          message: refactoringResult.explanation || refactoringResult.error || "Stage 5 transformation failed.",
          category: "error",
        },
      ],
      beforeSmells,
      afterSmells: [...beforeSmells],
      fixedSmells: [],
      remainingSmells: [...beforeSmells],
      beforeSmellCount: beforeSmells.length,
      afterSmellCount: beforeSmells.length,
      fixedSmellCount: 0,
      remainingSmellCount: beforeSmells.length,
      smellReductionPercentage: 0,
      refactoredCode: originalCode,
      originalCode,
      strategy: refactoringResult.strategy,
      tokenMetrics: options.tokenMetrics,
      targetFile,
      nodeName,
      nodeKind,
      targetNodeId,
      taskId,
      error: refactoringResult.error ?? "Stage 5 transformation failed.",
    };
  }

  const proposedCode = refactoringResult.refactoredCode;

  // 1. SYNTAX VALIDATION
  const syntaxCheck = validateSyntax(proposedCode, {
    filePath: targetFile,
    nodeKind,
  });
  allDiagnostics.push(...syntaxCheck.diagnostics);

  if (!syntaxCheck.syntaxValid) {
    return {
      valid: false,
      syntaxValid: false,
      typeSafe: false,
      triviaPreserved: false,
      astReconciled: false,
      diagnostics: allDiagnostics,
      beforeSmells,
      afterSmells: [...beforeSmells],
      fixedSmells: [],
      remainingSmells: [...beforeSmells],
      beforeSmellCount: beforeSmells.length,
      afterSmellCount: beforeSmells.length,
      fixedSmellCount: 0,
      remainingSmellCount: beforeSmells.length,
      smellReductionPercentage: 0,
      refactoredCode: originalCode, // preserve original code on failure
      originalCode,
      strategy: refactoringResult.strategy,
      tokenMetrics: options.tokenMetrics,
      targetFile,
      nodeName,
      nodeKind,
      targetNodeId,
      taskId,
      error: syntaxCheck.error,
    };
  }

  // 2. TRIVIA RECONCILIATION
  const triviaMetadata = options.trivia ?? extractTriviaFromText(originalCode);
  const triviaCheck = reconcileTriviaWithAst(proposedCode, triviaMetadata);
  const finalCode = triviaCheck.reconciledCode;

  // 3. AST RECONCILIATION
  const astCheck = reconcileAst(originalCode, finalCode, {
    targetName: refactoringResult.nodeName ?? nodeName,
    nodeKind: refactoringResult.nodeKind ?? nodeKind,
    fullOriginalFile: options.fullFileContent,
    fullRefactoredFile: options.fullFileContent
      ? applyRefactoringInMemory(options.fullFileContent, originalCode, finalCode)
      : undefined,
  });

  if (!astCheck.astReconciled) {
    allDiagnostics.push({
      file: targetFile,
      filePath: targetFile,
      line: 1,
      column: 1,
      code: "AST_RECONCILIATION_FAILED",
      message: astCheck.reason ?? "AST reconciliation failed.",
      category: "error",
    });
  }

  // 4. TYPE VALIDATION
  const typeCheck = validateTypes(finalCode, {
    originalCode,
    targetFile,
    workspace,
    fullFileCode: options.fullFileContent
      ? applyRefactoringInMemory(options.fullFileContent, originalCode, finalCode)
      : undefined,
    strictTypeCheck: options.strictTypeCheck,
    dependencySignatures: options.dependencySignatures ?? payload?.context?.dependencies,
    tsConfigFilePath: options.tsConfigFilePath,
  });
  allDiagnostics.push(...typeCheck.diagnostics);

  // 5. RE-ANALYSIS: Before vs After Code Smells
  const smellComparison = reanalyzeSmells(
    finalCode,
    beforeSmells.length > 0 ? beforeSmells : originalCode,
    {
      filePath: targetFile,
      astOptions: options.astOptions,
    },
  );

  const syntaxErrorsCount = syntaxCheck.diagnostics.filter((d) => d.category === "error").length;
  const compilerErrorsCount = typeCheck.diagnostics.filter((d) => d.category === "error").length;

  const metrics: ValidationMetrics = {
    beforeSmellCount: smellComparison.beforeSmellCount,
    afterSmellCount: smellComparison.afterSmellCount,
    fixedSmellCount: smellComparison.fixedSmellCount,
    remainingSmellCount: smellComparison.remainingSmellCount,
    smellReductionPercentage: smellComparison.smellReductionPercentage,
    syntaxErrorsCount,
    typeErrorsCount: compilerErrorsCount,
    tokenMetrics: options.tokenMetrics,
  };

  const researchMetrics: ValidationResearchMetrics = {
    originalTechnicalDebt: smellComparison.beforeSmellCount,
    finalTechnicalDebt: smellComparison.afterSmellCount,
    technicalDebtDelta: smellComparison.beforeSmellCount - smellComparison.afterSmellCount,
    smellReductionPercentage: smellComparison.smellReductionPercentage,
    tokenReductionPercentage: options.tokenMetrics?.tokenReductionPercentage,
    tokenSavings: options.tokenMetrics?.estimatedTokenSavings,
    strategy: refactoringResult.strategy,
    syntaxErrorsCount,
    compilerErrorsCount,
    validationPassed: false,
    reconciledTriviaCount: triviaCheck.preservedTriviaCount,
  };

  // Determine Overall Validity
  const isTypeSafe = typeCheck.typeSafe;
  const isTriviaPreserved = options.requireTriviaPreserved ? triviaCheck.triviaPreserved : true;
  const isSmellReductionOk = options.requireSmellReduction
    ? smellComparison.beforeSmellCount === 0 || smellComparison.smellReductionPercentage > 0
    : true;

  const valid =
    syntaxCheck.syntaxValid &&
    isTypeSafe &&
    astCheck.astReconciled &&
    isTriviaPreserved &&
    isSmellReductionOk &&
    compilerErrorsCount === 0 &&
    syntaxErrorsCount === 0;

  researchMetrics.validationPassed = valid;

  return {
    valid,
    syntaxValid: syntaxCheck.syntaxValid,
    typeSafe: isTypeSafe,
    triviaPreserved: triviaCheck.triviaPreserved,
    astReconciled: astCheck.astReconciled,
    diagnostics: allDiagnostics,

    beforeSmells: smellComparison.beforeSmells,
    afterSmells: smellComparison.afterSmells,
    fixedSmells: smellComparison.fixedSmells,
    remainingSmells: smellComparison.remainingSmells,

    beforeSmellCount: smellComparison.beforeSmellCount,
    afterSmellCount: smellComparison.afterSmellCount,
    fixedSmellCount: smellComparison.fixedSmellCount,
    remainingSmellCount: smellComparison.remainingSmellCount,
    smellReductionPercentage: smellComparison.smellReductionPercentage,

    refactoredCode: valid ? finalCode : originalCode,
    originalCode,

    strategy: refactoringResult.strategy,
    tokenMetrics: options.tokenMetrics,
    targetFile,
    nodeName,
    nodeKind,
    targetNodeId,
    taskId,
    error: valid ? undefined : allDiagnostics.find((d) => d.category === "error")?.message,

    metrics,
    researchMetrics,
  };
}
