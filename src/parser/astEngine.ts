/**
 * ts-morph wrapper: loads source files into a Project, walks their AST,
 * extracts declarations as ParsedNode records, and flags code smells.
 *
 * Stage 2: Static Code Parser & AST Builder.
 */
import {
  Project,
  SourceFile,
  SyntaxKind,
  FunctionDeclaration,
  ClassDeclaration,
  MethodDeclaration,
  InterfaceDeclaration,
  TypeAliasDeclaration,
  VariableStatement,
  ArrowFunction,
  FunctionExpression,
  Node,
} from "ts-morph";
import type {
  AstEngineOptions,
  CodeSmell,
  CodeSmellType,
  ExportInfo,
  FileParseResult,
  ImportInfo,
  NodeKind,
  ParsedNode,
} from "../types/ast.types.js";
import type { WorkspaceResult } from "../types/workspace.types.js";
import { extractTrivia } from "./triviaPreserver.js";

export type {
  AstEngineOptions,
  CodeSmell,
  CodeSmellType,
  ExportInfo,
  FileParseResult,
  ImportInfo,
  NodeKind,
  ParsedNode,
};

/**
 * Creates a ts-morph Project rooted at the given tsconfig, or an
 * in-memory project (useful for tests / plain JS targets without one).
 */
export function createProject(tsConfigFilePath?: string): Project {
  return tsConfigFilePath
    ? new Project({ tsConfigFilePath })
    : new Project({
        useInMemoryFileSystem: false,
        compilerOptions: { allowJs: true, checkJs: false },
      });
}

/** Adds one or more file globs/paths to the project and returns the loaded SourceFiles. */
export function loadSourceFiles(project: Project, filePaths: string[]): SourceFile[] {
  return filePaths.map((p) => project.addSourceFileAtPath(p));
}

/**
 * Stage 2 entrypoint: Analyzes an ingested workspace (from Stage 1) and returns AST analysis results.
 *
 * @param workspaceResult Ingested workspace from Stage 1 (workspace.ts)
 * @param options Configurable AST analysis thresholds
 * @returns Array of FileParseResult records ready for Stage 3 dependency graph
 */
export function analyzeWorkspace(
  workspaceResult: WorkspaceResult,
  options?: AstEngineOptions,
): FileParseResult[] {
  const results: FileParseResult[] = [];

  for (const file of workspaceResult.files) {
    let sourceFile = workspaceResult.project.getSourceFile(file.absolutePath);
    if (!sourceFile) {
      sourceFile = workspaceResult.project.createSourceFile(
        file.absolutePath,
        file.sourceText,
        { overwrite: true },
      );
    }

    results.push(parseSourceFile(sourceFile, options));
  }

  return results;
}

/** Parses a single already-loaded SourceFile into a FileParseResult. */
export function parseSourceFile(
  sourceFile: SourceFile,
  options?: AstEngineOptions,
): FileParseResult {
  const filePath = sourceFile.getFilePath();
  const language: "js" | "ts" = filePath.endsWith(".ts") || filePath.endsWith(".tsx") ? "ts" : "js";

  const nodes: ParsedNode[] = [];

  sourceFile.getFunctions().forEach((fn) => nodes.push(toParsedNode(fn, "function", filePath, options)));
  sourceFile.getClasses().forEach((cls) => {
    nodes.push(toParsedNode(cls, "class", filePath, options));
    cls.getMethods().forEach((m) => nodes.push(toParsedNode(m, "method", filePath, options)));
  });
  sourceFile.getInterfaces().forEach((i) => nodes.push(toParsedNode(i, "interface", filePath, options)));
  sourceFile.getTypeAliases().forEach((t) => nodes.push(toParsedNode(t, "type-alias", filePath, options)));

  sourceFile.getVariableStatements().forEach((v) => {
    let hasFunctionInit = false;
    for (const decl of v.getDeclarations()) {
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        hasFunctionInit = true;
        nodes.push(toParsedNode(init, "function", filePath, options));
      }
    }
    if (!hasFunctionInit || (v.getDeclarationKind() as string) === "var" || hasAnyUsage(v)) {
      nodes.push(toParsedNode(v, "variable", filePath, options));
    }
  });

  const importsResult = extractImports(sourceFile);
  const exportsResult = extractExports(sourceFile);
  const fullText = sourceFile.getFullText();

  // Aggregate file-level smells
  const allSmells: CodeSmell[] = [];
  nodes.forEach((n) => allSmells.push(...n.smells));

  return {
    filePath,
    language,
    nodes,
    imports: importsResult.specifiers,
    exports: exportsResult.names,
    fullText,
    sourceText: fullText,
    smells: allSmells,
    importDeclarations: importsResult.declarations,
    exportDeclarations: exportsResult.declarations,
  };
}

/** Convenience: load + parse a batch of files in one call. */
export function parseFiles(
  filePaths: string[],
  tsConfigFilePath?: string,
  options?: AstEngineOptions,
): FileParseResult[] {
  const project = createProject(tsConfigFilePath);
  const sourceFiles = loadSourceFiles(project, filePaths);
  return sourceFiles.map((sf) => parseSourceFile(sf, options));
}

// ---- internals -------------------------------------------------------

type SmellableNode =
  | FunctionDeclaration
  | ClassDeclaration
  | MethodDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | VariableStatement
  | ArrowFunction
  | FunctionExpression;

function toParsedNode(
  node: SmellableNode,
  kind: NodeKind,
  filePath: string,
  options?: AstEngineOptions,
): ParsedNode {
  const name = getNodeName(node, kind);
  const complexity = computeCyclomaticComplexity(node, kind);
  return {
    id: `${filePath}::${name}`,
    kind,
    name,
    filePath,
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    sourceText: node.getText(),
    complexity,
    smells: detectSmells(node, complexity, filePath, options),
    trivia: extractTrivia(node),
  };
}

function getNodeName(node: SmellableNode, kind: NodeKind): string {
  if (kind === "variable") {
    const decls = (node as VariableStatement).getDeclarations();
    return decls.map((d) => d.getName()).join(", ") || "<anonymous>";
  }
  const named = node as
    | FunctionDeclaration
    | ClassDeclaration
    | MethodDeclaration
    | InterfaceDeclaration
    | TypeAliasDeclaration;
  if ("getName" in named && typeof named.getName === "function") {
    const name = named.getName();
    if (name) return name;
  }
  const parent = node.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return "<anonymous>";
}

/**
 * Extracts ESM and CommonJS imports as both specifier strings and structured metadata.
 */
export function extractImports(sourceFile: SourceFile): {
  specifiers: string[];
  declarations: ImportInfo[];
} {
  const specifiers: string[] = [];
  const declarations: ImportInfo[] = [];

  for (const imp of sourceFile.getImportDeclarations()) {
    const specifier = imp.getModuleSpecifierValue();
    specifiers.push(specifier);

    const defaultImport = imp.getDefaultImport()?.getText();
    const namedImports = imp.getNamedImports().map((n) => n.getName());
    const namespaceImport = imp.getNamespaceImport()?.getText();
    const line = imp.getStartLineNumber();
    const column = sourceFile.getLineAndColumnAtPos(imp.getStart()).column;

    declarations.push({
      moduleSpecifier: specifier,
      defaultImport,
      namedImports,
      namespaceImport,
      isRequire: false,
      line,
      column,
    });
  }

  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node) && node.getExpression().getText() === "require") {
      const arg = node.getArguments()[0];
      if (arg && Node.isStringLiteral(arg)) {
        const specifier = arg.getLiteralValue();
        specifiers.push(specifier);
        declarations.push({
          moduleSpecifier: specifier,
          namedImports: [],
          isRequire: true,
          line: node.getStartLineNumber(),
          column: sourceFile.getLineAndColumnAtPos(node.getStart()).column,
        });
      }
    }
  });

  return { specifiers, declarations };
}

/**
 * Extracts ESM and CommonJS exports as both names and structured metadata.
 */
export function extractExports(sourceFile: SourceFile): {
  names: string[];
  declarations: ExportInfo[];
} {
  const filePath = sourceFile.getFilePath();
  const isTypeScript = filePath.endsWith(".ts") || filePath.endsWith(".tsx");

  const names: string[] = [];
  const declarations: ExportInfo[] = [];

  if (isTypeScript) {
    const exportedMap = sourceFile.getExportedDeclarations();
    for (const [name, decls] of exportedMap.entries()) {
      names.push(name);
      const firstDecl = decls[0];
      const line = firstDecl ? firstDecl.getStartLineNumber() : 1;
      const column = firstDecl
        ? sourceFile.getLineAndColumnAtPos(firstDecl.getStart()).column
        : 1;
      declarations.push({
        name,
        isDefault: name === "default",
        line,
        column,
      });
    }
  } else {
    const cjsNames = getCommonJsExportNames(sourceFile);
    names.push(...cjsNames);
    for (const name of cjsNames) {
      declarations.push({
        name,
        isDefault: false,
        line: 1,
        column: 1,
      });
    }
  }

  return { names, declarations };
}

function getCommonJsExportNames(sourceFile: SourceFile): string[] {
  const names = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;
    const leftText = node.getLeft().getText();
    const right = node.getRight();

    if (leftText === "module.exports" && Node.isObjectLiteralExpression(right)) {
      right
        .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
        .getProperties()
        .forEach((p) => {
          if (Node.isShorthandPropertyAssignment(p) || Node.isPropertyAssignment(p)) {
            names.add(p.getName());
          }
        });
    } else if (/^(module\.exports|exports)\.\w+$/.test(leftText)) {
      names.add(leftText.split(".").pop()!);
    }
  });

  return Array.from(names);
}

const DEFAULT_COMPLEXITY_THRESHOLD = 10;
const DEFAULT_LONG_FUNCTION_THRESHOLD = 50;
const DEFAULT_DEEP_NESTING_THRESHOLD = 4;
const DEFAULT_CALLBACK_HELL_THRESHOLD = 2;

function computeCyclomaticComplexity(node: SmellableNode, kind: NodeKind): number {
  if (kind !== "function" && kind !== "method") return 1;

  let complexity = 1;
  node.forEachDescendant((n) => {
    if (
      Node.isIfStatement(n) ||
      Node.isForStatement(n) ||
      Node.isForInStatement(n) ||
      Node.isForOfStatement(n) ||
      Node.isWhileStatement(n) ||
      Node.isDoStatement(n) ||
      Node.isCatchClause(n) ||
      Node.isConditionalExpression(n) ||
      Node.isCaseClause(n)
    ) {
      complexity++;
    } else if (Node.isBinaryExpression(n)) {
      const opKind = n.getOperatorToken().getKind();
      if (opKind === SyntaxKind.AmpersandAmpersandToken || opKind === SyntaxKind.BarBarToken) {
        complexity++;
      }
    }
  });
  return complexity;
}

function detectSmells(
  node: SmellableNode,
  complexity: number,
  filePath: string,
  options?: AstEngineOptions,
): CodeSmell[] {
  const smells: CodeSmell[] = [];

  const pushSmell = (
    condition: boolean,
    type: CodeSmellType,
    message: string,
    targetNode?: Node,
  ) => {
    if (!condition) return;
    const target = targetNode ?? node;
    const targetSf = target.getSourceFile();
    const line = target.getStartLineNumber();
    const column = targetSf.getLineAndColumnAtPos(target.getStart()).column;
    const start = target.getStart();
    const end = target.getEnd();
    const code = target.getText();

    smells.push({
      type,
      message,
      line,
      column,
      start,
      end,
      code,
      filePath,
    });
  };

  // 1. var-usage
  if (hasVarUsage(node)) {
    const varDecl = findVarDeclaration(node);
    pushSmell(true, "var-usage", "Uses `var` instead of `let`/`const`", varDecl);
  }

  // 2. untyped-signature (untyped parameters)
  if (hasUntypedSignature(node)) {
    pushSmell(true, "untyped-signature", "Parameters or return type are untyped", node);
  }

  // 3. missing-return-type
  if (hasMissingReturnType(node)) {
    pushSmell(true, "missing-return-type", "Function is missing an explicit return type annotation", node);
  }

  // 4. any-usage
  if (hasAnyUsage(node)) {
    const anyNode = findAnyKeyword(node);
    pushSmell(true, "any-usage", "Explicit usage of `any` type detected", anyNode);
  }

  // 5. long-function
  const longFnThreshold = options?.longFunctionThreshold ?? DEFAULT_LONG_FUNCTION_THRESHOLD;
  if (isLongFunction(node, longFnThreshold)) {
    const lines = node.getEndLineNumber() - node.getStartLineNumber() + 1;
    pushSmell(
      true,
      "long-function",
      `Function exceeds maximum length (${lines} lines; threshold: ${longFnThreshold})`,
      node,
    );
  }

  // 6. deep-nesting
  const nestingThreshold = options?.deepNestingThreshold ?? DEFAULT_DEEP_NESTING_THRESHOLD;
  if (hasDeepNesting(node, nestingThreshold)) {
    const depth = computeNestingDepth(node);
    pushSmell(
      true,
      "deep-nesting",
      `Block nesting depth of ${depth} reaches or exceeds threshold of ${nestingThreshold}`,
      node,
    );
  }

  // 7. callback-hell
  const callbackThreshold = options?.callbackHellThreshold ?? DEFAULT_CALLBACK_HELL_THRESHOLD;
  if (hasCallbackHell(node, callbackThreshold)) {
    pushSmell(true, "callback-hell", "Nested callback parameters exceed depth threshold", node);
  }

  // 8. no-error-handling
  if (hasNoErrorHandling(node)) {
    pushSmell(true, "no-error-handling", "Async/callback logic with no visible error handling", node);
  }

  // 9. high-complexity
  const compThreshold = options?.complexityThreshold ?? DEFAULT_COMPLEXITY_THRESHOLD;
  if (complexity > compThreshold) {
    pushSmell(
      true,
      "high-complexity",
      `Cyclomatic complexity is ${complexity} (McCabe threshold: ${compThreshold})`,
      node,
    );
  }

  return smells;
}

function hasUntypedSignature(node: SmellableNode): boolean {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node) &&
    !Node.isArrowFunction(node) &&
    !Node.isFunctionExpression(node)
  ) {
    return false;
  }
  const params = node.getParameters();
  return params.length > 0 && params.some((p) => !p.getTypeNode());
}

function hasMissingReturnType(node: SmellableNode): boolean {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node) &&
    !Node.isArrowFunction(node) &&
    !Node.isFunctionExpression(node)
  ) {
    return false;
  }
  if (Node.isConstructorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    return false;
  }
  return !node.getReturnTypeNode();
}

function hasAnyUsage(node: Node): boolean {
  return node.getKind() === SyntaxKind.AnyKeyword || node.getDescendantsOfKind(SyntaxKind.AnyKeyword).length > 0;
}

function findAnyKeyword(node: Node): Node | undefined {
  if (node.getKind() === SyntaxKind.AnyKeyword) return node;
  return node.getDescendantsOfKind(SyntaxKind.AnyKeyword)[0];
}

function hasVarUsage(node: SmellableNode): boolean {
  if (Node.isVariableStatement(node) && (node.getDeclarationKind() as string) === "var") {
    return true;
  }
  let found = false;
  node.forEachDescendant((n) => {
    if (Node.isVariableDeclarationList(n) && ((n.getDeclarationKind() as string) === "var")) {
      found = true;
    }
  });
  return found;
}

function findVarDeclaration(node: SmellableNode): Node | undefined {
  if (Node.isVariableStatement(node) && ((node.getDeclarationKind() as string) === "var")) {
    return node;
  }
  let target: Node | undefined;
  node.forEachDescendant((n) => {
    if (!target && Node.isVariableDeclarationList(n) && ((n.getDeclarationKind() as string) === "var")) {
      target = n;
    }
  });
  return target;
}

function isLongFunction(node: SmellableNode, threshold: number): boolean {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node) &&
    !Node.isArrowFunction(node) &&
    !Node.isFunctionExpression(node)
  ) {
    return false;
  }
  const lines = node.getEndLineNumber() - node.getStartLineNumber() + 1;
  return lines > threshold;
}

function computeNestingDepth(node: SmellableNode): number {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node) &&
    !Node.isArrowFunction(node) &&
    !Node.isFunctionExpression(node)
  ) {
    return 0;
  }

  const body =
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node)
      ? node.getBody()
      : undefined;

  if (!body) return 0;

  let maxDepth = 0;
  const walk = (n: Node, currentDepth: number) => {
    maxDepth = Math.max(maxDepth, currentDepth);
    const isNesting =
      Node.isIfStatement(n) ||
      Node.isForStatement(n) ||
      Node.isForInStatement(n) ||
      Node.isForOfStatement(n) ||
      Node.isWhileStatement(n) ||
      Node.isDoStatement(n) ||
      Node.isSwitchStatement(n) ||
      Node.isTryStatement(n) ||
      Node.isCatchClause(n);

    const nextDepth = isNesting ? currentDepth + 1 : currentDepth;
    n.forEachChild((child) => walk(child, nextDepth));
  };

  walk(body, 0);
  return maxDepth;
}

function hasDeepNesting(node: SmellableNode, threshold: number): boolean {
  return computeNestingDepth(node) >= threshold;
}

function hasCallbackHell(node: SmellableNode, depthThreshold = 2): boolean {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node) &&
    !Node.isArrowFunction(node) &&
    !Node.isFunctionExpression(node)
  ) {
    return false;
  }
  let maxDepth = 0;
  const walk = (n: Node, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    n.forEachChild((child) => {
      const isCallbackArg =
        Node.isCallExpression(child) &&
        child.getArguments().some((a) => Node.isFunctionExpression(a) || Node.isArrowFunction(a));
      walk(child, isCallbackArg ? depth + 1 : depth);
    });
  };
  walk(node, 0);
  return maxDepth >= depthThreshold;
}

function hasNoErrorHandling(node: SmellableNode): boolean {
  if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node)) return false;
  const text = node.getText();
  const looksAsync = /callback|cb\s*\(|\.then\(|await\s/.test(text);
  const hasTryCatch = node.getDescendantsOfKind(SyntaxKind.TryStatement).length > 0;
  const hasErrCheck = /if\s*\(\s*err/.test(text);
  return looksAsync && !hasTryCatch && !hasErrCheck;
}