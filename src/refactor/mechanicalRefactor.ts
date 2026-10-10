/**
 * Stage 5: Mechanical Transformation Engine
 * Deterministic, AST-based transformations using ts-morph.
 * Handles safe, mechanical fixes (such as var -> const/let and import cleanup)
 * with ZERO LLM calls.
 */
import { Project, SyntaxKind, Node, VariableDeclarationKind, SourceFile } from "ts-morph";
import type { CodeSmell } from "../types/ast.types.js";
import type { TriviaMetadata } from "../types/slicer.types.js";
import type { RefactoringChange, RefactoringResult } from "../types/refactor.types.js";
import { reconcileTrivia } from "../parser/triviaPreserver.js";

/**
 * Checks whether an identifier name is reassigned in the given AST scope.
 * Inspects binary assignment expressions and increment/decrement operators.
 */
function isVariableReassigned(sourceFile: SourceFile, varName: string): boolean {
  let reassigned = false;

  sourceFile.forEachDescendant((n) => {
    if (reassigned) return;

    // 1. Binary assignment: x = ..., x += ..., etc.
    if (Node.isBinaryExpression(n)) {
      const left = n.getLeft();
      const op = n.getOperatorToken().getKind();
      const isAssignment =
        op === SyntaxKind.EqualsToken ||
        op === SyntaxKind.PlusEqualsToken ||
        op === SyntaxKind.MinusEqualsToken ||
        op === SyntaxKind.AsteriskEqualsToken ||
        op === SyntaxKind.SlashEqualsToken ||
        op === SyntaxKind.PercentEqualsToken ||
        op === SyntaxKind.AmpersandEqualsToken ||
        op === SyntaxKind.BarEqualsToken ||
        op === SyntaxKind.CaretEqualsToken ||
        op === SyntaxKind.LessThanLessThanEqualsToken ||
        op === SyntaxKind.GreaterThanGreaterThanEqualsToken;

      if (isAssignment && Node.isIdentifier(left) && left.getText() === varName) {
        reassigned = true;
      }
    }

    // 2. Unary increment/decrement: ++x, --x, x++, x--
    if (Node.isPrefixUnaryExpression(n) || Node.isPostfixUnaryExpression(n)) {
      const operand = n.getOperand();
      const op = n.getOperatorToken();
      if (
        (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) &&
        Node.isIdentifier(operand) &&
        operand.getText() === varName
      ) {
        reassigned = true;
      }
    }
  });

  return reassigned;
}

/**
 * Transforms `var` statements into `const` (if immutable) or `let` (if reassigned or uninitialized).
 */
export function transformVarDeclarations(sourceFile: SourceFile): {
  refactored: boolean;
  changes: RefactoringChange[];
} {
  const changes: RefactoringChange[] = [];
  let refactored = false;

  // 1. Variable statements (top-level and inside function/block scopes)
  const statements = sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement);
  for (const statement of statements) {
    if (statement.getDeclarationKind() === "var") {
      const decls = statement.getDeclarations();
      let hasReassignmentOrUninit = false;

      for (const decl of decls) {
        const name = decl.getName();
        const hasInit = Boolean(decl.getInitializer());
        const reassigned = isVariableReassigned(sourceFile, name);

        if (!hasInit || reassigned) {
          hasReassignmentOrUninit = true;
          break;
        }
      }

      if (hasReassignmentOrUninit) {
        statement.setDeclarationKind(VariableDeclarationKind.Let);
        refactored = true;
        changes.push({
          smellType: "var-usage",
          description: `Replaced 'var' declaration with 'let' due to reassignment or lack of initializer (${decls.map((d) => d.getName()).join(", ")})`,
        });
      } else {
        statement.setDeclarationKind(VariableDeclarationKind.Const);
        refactored = true;
        changes.push({
          smellType: "var-usage",
          description: `Replaced immutable 'var' declaration with 'const' (${decls.map((d) => d.getName()).join(", ")})`,
        });
      }
    }
  }

  // 2. Loop variable declaration lists (e.g. for (var i = 0; ...))
  const declLists = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclarationList);
  for (const list of declLists) {
    if (Node.isVariableStatement(list.getParent())) {
      continue;
    }
    if (list.getDeclarationKind() === VariableDeclarationKind.Var) {
      const decls = list.getDeclarations();
      list.setDeclarationKind(VariableDeclarationKind.Let);
      refactored = true;
      changes.push({
        smellType: "var-usage",
        description: `Replaced loop 'var' declaration with 'let' (${decls.map((d) => d.getName()).join(", ")})`,
      });
    }
  }

  return { refactored, changes };
}

/**
 * Removes unused import specifiers where safely detectable within the slice.
 */
export function cleanupUnusedImports(sourceFile: SourceFile): {
  refactored: boolean;
  changes: RefactoringChange[];
} {
  const changes: RefactoringChange[] = [];
  let refactored = false;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const namedImports = importDecl.getNamedImports();
    const importStart = importDecl.getStart();
    const importEnd = importDecl.getEnd();

    for (const named of namedImports) {
      const name = named.getName();
      let usageCount = 0;

      sourceFile.forEachDescendant((n) => {
        const isInsideImport = n.getStart() >= importStart && n.getEnd() <= importEnd;
        if (Node.isIdentifier(n) && n.getText() === name && !isInsideImport) {
          usageCount++;
        }
      });

      if (usageCount === 0) {
        named.remove();
        refactored = true;
        changes.push({
          smellType: "unused-import",
          description: `Removed unused named import '${name}'`,
        });
      }
    }

    if (
      importDecl.getNamedImports().length === 0 &&
      !importDecl.getDefaultImport() &&
      !importDecl.getNamespaceImport()
    ) {
      importDecl.remove();
    }
  }

  return { refactored, changes };
}

/**
 * Executes deterministic AST mechanical refactoring on a target code string.
 */
export function applyMechanicalRefactoring(
  targetCode: string,
  smells: CodeSmell[],
  trivia?: TriviaMetadata,
): RefactoringResult {
  const originalCode = targetCode;

  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("target.ts", targetCode);

    const changes: RefactoringChange[] = [];
    let appliedAny = false;

    // 1. Transform var declarations
    const varResult = transformVarDeclarations(sourceFile);
    if (varResult.refactored) {
      appliedAny = true;
      changes.push(...varResult.changes);
    }

    // 2. Clean up imports if detected
    const importResult = cleanupUnusedImports(sourceFile);
    if (importResult.refactored) {
      appliedAny = true;
      changes.push(...importResult.changes);
    }

    let refactoredCode = sourceFile.getFullText();

    // 3. Reconcile comments and trivia
    if (trivia) {
      refactoredCode = reconcileTrivia(refactoredCode, trivia);
    }

    const explanation = appliedAny
      ? `Applied deterministic mechanical refactoring: ${changes.map((c) => c.description).join("; ")}`
      : "No mechanical transformations were applicable to the target code.";

    return {
      success: true,
      strategy: "mechanical",
      originalCode,
      refactoredCode,
      explanation,
      changes,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      strategy: "mechanical",
      originalCode,
      refactoredCode: originalCode,
      explanation: `Mechanical transformation failed: ${msg}`,
      changes: [],
      error: msg,
    };
  }
}
