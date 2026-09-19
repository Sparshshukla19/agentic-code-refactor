/**
 * ts-morph wrapper: loads source files into a Project, walks their AST,
 * extracts declarations as ParsedNode records, and flags code smells.
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
  Node,
} from "ts-morph";
import type { CodeSmell, CodeSmellType, FileParseResult, NodeKind, ParsedNode } from "../types/ast.types.js";

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

/** Parses a single already-loaded SourceFile into a FileParseResult. */
export function parseSourceFile(sourceFile: SourceFile): FileParseResult {
  const filePath = sourceFile.getFilePath();
  const language: "js" | "ts" = filePath.endsWith(".ts") || filePath.endsWith(".tsx") ? "ts" : "js";

  const nodes: ParsedNode[] = [];

  sourceFile.getFunctions().forEach((fn) => nodes.push(toParsedNode(fn, "function", filePath)));
  sourceFile.getClasses().forEach((cls) => {
    nodes.push(toParsedNode(cls, "class", filePath));
    cls.getMethods().forEach((m) => nodes.push(toParsedNode(m, "method", filePath)));
  });
  sourceFile.getInterfaces().forEach((i) => nodes.push(toParsedNode(i, "interface", filePath)));
  sourceFile.getTypeAliases().forEach((t) => nodes.push(toParsedNode(t, "type-alias", filePath)));
  sourceFile.getVariableStatements().forEach((v) => nodes.push(toParsedNode(v, "variable", filePath)));

  return {
    filePath,
    language,
    nodes,
    imports: getImportSpecifiers(sourceFile),
    exports: getExportNames(sourceFile),
    fullText: sourceFile.getFullText(),
  };
}

/** Convenience: load + parse a batch of files in one call. */
export function parseFiles(filePaths: string[], tsConfigFilePath?: string): FileParseResult[] {
  const project = createProject(tsConfigFilePath);
  const sourceFiles = loadSourceFiles(project, filePaths);
  return sourceFiles.map(parseSourceFile);
}

// ---- internals -------------------------------------------------------

type SmellableNode =
  | FunctionDeclaration
  | ClassDeclaration
  | MethodDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | VariableStatement;

function toParsedNode(node: SmellableNode, kind: NodeKind, filePath: string): ParsedNode {
  const name = getNodeName(node, kind);
  return {
    id: `${filePath}::${name}`,
    kind,
    name,
    filePath,
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    sourceText: node.getText(),
    smells: detectSmells(node),
  };
}

function getNodeName(node: SmellableNode, kind: NodeKind): string {
  if (kind === "variable") {
    const decls = (node as VariableStatement).getDeclarations();
    return decls.map((d) => d.getName()).join(", ") || "<anonymous>";
  }
  const named = node as FunctionDeclaration | ClassDeclaration | MethodDeclaration | InterfaceDeclaration | TypeAliasDeclaration;
  return named.getName?.() ?? "<anonymous>";
}

function getImportSpecifiers(sourceFile: SourceFile): string[] {
  const esmImports = sourceFile.getImportDeclarations().map((d) => d.getModuleSpecifierValue());
  // CommonJS: require("...") calls — needed since test-target/ is plain JS.
  const cjsImports: string[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node) && node.getExpression().getText() === "require") {
      const arg = node.getArguments()[0];
      if (arg && Node.isStringLiteral(arg)) cjsImports.push(arg.getLiteralValue());
    }
  });
  return [...esmImports, ...cjsImports];
}

function getExportNames(sourceFile: SourceFile): string[] {
  const filePath = sourceFile.getFilePath();
  const isTypeScript = filePath.endsWith(".ts") || filePath.endsWith(".tsx");

  // ts-morph's getExportedDeclarations() resolves ESM `export` statements
  // reliably. For CommonJS `.js` files it depends on the checker's
  // usage-driven symbol resolution (unreliable with checkJs: false — a file
  // nothing else requires can resolve to zero exports even with a clear
  // `module.exports = {...}`), so CJS gets its own explicit scan instead.
  if (isTypeScript) {
    return Array.from(sourceFile.getExportedDeclarations().keys());
  }
  return getCommonJsExportNames(sourceFile);
}

function getCommonJsExportNames(sourceFile: SourceFile): string[] {
  const names = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;
    const leftText = node.getLeft().getText();
    const right = node.getRight();

    // module.exports = { a, b, c }  /  exports.foo = ... (single named export)
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

function detectSmells(node: SmellableNode): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const line = node.getStartLineNumber();

  pushIf(smells, hasUntypedSignature(node), "untyped-signature", "Parameters or return type are untyped", line);
  pushIf(smells, hasCallbackHell(node), "callback-hell", "Nested callback parameters exceed depth threshold", line);
  pushIf(smells, hasVarUsage(node), "var-usage", "Uses `var` instead of `let`/`const`", line);
  pushIf(smells, hasNoErrorHandling(node), "no-error-handling", "Async/callback logic with no visible error handling", line);

  return smells;
}

function pushIf(smells: CodeSmell[], condition: boolean, type: CodeSmellType, message: string, line: number): void {
  if (condition) smells.push({ type, message, line });
}

function hasUntypedSignature(node: SmellableNode): boolean {
  if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node)) return false;
  const noReturnType = !node.getReturnTypeNode();
  const anyUntypedParam = node.getParameters().some((p) => !p.getTypeNode());
  return noReturnType || anyUntypedParam;
}

function hasCallbackHell(node: SmellableNode, depthThreshold = 2): boolean {
  if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node)) return false;
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

function hasVarUsage(node: SmellableNode): boolean {
  let found = false;
  node.forEachDescendant((n) => {
    if (Node.isVariableDeclarationList(n) && n.getDeclarationKind() === "var" as any) found = true;
  });
  return found;
}

function hasNoErrorHandling(node: SmellableNode): boolean {
  if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node)) return false;
  const text = node.getText();
  const looksAsync = /callback|cb\s*\(|\.then\(|await\s/.test(text);
  const hasTryCatch = node.getDescendantsOfKind(SyntaxKind.TryStatement).length > 0;
  const hasErrCheck = /if\s*\(\s*err/.test(text);
  return looksAsync && !hasTryCatch && !hasErrCheck;
}