/**
 * Stage 4: Node Slicing & Dependency Signature Extraction
 * Isolates specific AST targets (functions, arrow functions, methods, classes)
 * and extracts lightweight dependency signatures rather than entire implementations.
 */
import path from "node:path";
import { Node, SourceFile } from "ts-morph";
import type { ParsedNode, FileParseResult, CodeSmell } from "../types/ast.types.js";
import type { SlicedTarget, DependencySignature } from "../types/slicer.types.js";
import { normalizePath } from "./dependencyGraph.js";

export type { SlicedTarget, DependencySignature };

/**
 * Checks whether an AST node is a meaningful refactoring target unit.
 * Local variable declarations inside functions are NOT meaningful units on their own;
 * their enclosing function is the meaningful refactoring unit.
 */
function isMeaningfulNode(n: Node): boolean {
  if (
    Node.isFunctionDeclaration(n) ||
    Node.isMethodDeclaration(n) ||
    Node.isArrowFunction(n) ||
    Node.isFunctionExpression(n) ||
    Node.isClassDeclaration(n) ||
    Node.isInterfaceDeclaration(n) ||
    Node.isTypeAliasDeclaration(n)
  ) {
    return true;
  }

  // Top-level variable statements or declarations are meaningful only if NOT inside a function/class
  if (Node.isVariableStatement(n) || Node.isVariableDeclaration(n)) {
    return !hasEnclosingFunctionOrClass(n);
  }

  return false;
}

function hasEnclosingFunctionOrClass(n: Node): boolean {
  let parent = n.getParent();
  while (parent) {
    if (
      Node.isFunctionDeclaration(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isArrowFunction(parent) ||
      Node.isFunctionExpression(parent) ||
      Node.isClassDeclaration(parent)
    ) {
      return true;
    }
    parent = parent.getParent();
  }
  return false;
}

/**
 * Finds the smallest meaningful enclosing AST node at a given line number.
 * Meaningful nodes include functions, methods, arrow functions, classes, and top-level declarations.
 * Local statements (e.g. var-usage inside a function) resolve to the enclosing function.
 */
export function findSmallestEnclosingNode(
  sourceFile: SourceFile,
  line: number,
  column?: number,
): Node | null {
  let bestCandidate: Node | null = null;
  let smallestSpan = Infinity;

  sourceFile.forEachDescendant((n) => {
    const startLine = n.getStartLineNumber();
    const endLine = n.getEndLineNumber();

    if (startLine <= line && endLine >= line) {
      if (isMeaningfulNode(n)) {
        const span = n.getEnd() - n.getStart();
        if (span < smallestSpan) {
          smallestSpan = span;
          bestCandidate = n;
        }
      }
    }
  });

  return bestCandidate;
}

/**
 * Accepts a code-smell location, AST node, or line number and identifies
 * the smallest meaningful enclosing AST node.
 * If no smaller target exists, falls back to the SourceFile.
 */
export function selectTargetNode(
  sourceFile: SourceFile,
  target: number | CodeSmell | ParsedNode | Node,
  column?: number,
): Node {
  if (typeof target === "number") {
    const candidate = findSmallestEnclosingNode(sourceFile, target, column);
    return candidate ?? sourceFile;
  }

  if (target instanceof Node) {
    if (isMeaningfulNode(target)) {
      return target;
    }
    // Walk up to find the enclosing meaningful node
    let current: Node | undefined = target;
    while (current) {
      if (isMeaningfulNode(current)) {
        return current;
      }
      current = current.getParent();
    }
    return sourceFile;
  }

  // CodeSmell or ParsedNode
  const line = "line" in target ? target.line : target.startLine;
  const col = "column" in target ? target.column : undefined;
  const candidate = findSmallestEnclosingNode(sourceFile, line, col);
  return candidate ?? sourceFile;
}

/**
 * Extracts sliced metadata from a ts-morph AST Node.
 */
export function sliceNode(node: Node, filePath: string): SlicedTarget {
  let kind = "unknown";
  let name = "<anonymous>";

  if (Node.isSourceFile(node)) {
    kind = "file";
    name = path.basename(filePath);
    return {
      name,
      kind,
      filePath: normalizePath(filePath),
      startLine: 1,
      endLine: node.getEndLineNumber(),
      startChar: 0,
      endChar: node.getEnd(),
      sourceText: node.getFullText(),
    };
  }

  if (Node.isFunctionDeclaration(node)) {
    kind = "function";
    name = node.getName() ?? "<anonymous>";
  } else if (Node.isMethodDeclaration(node)) {
    kind = "method";
    name = node.getName();
  } else if (Node.isArrowFunction(node)) {
    kind = "arrow-function";
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      name = parent.getName();
    } else if (parent && Node.isPropertyAssignment(parent)) {
      name = parent.getName();
    }
  } else if (Node.isFunctionExpression(node)) {
    kind = "function";
    const parent = node.getParent();
    name = node.getName() ?? (parent && Node.isVariableDeclaration(parent) ? parent.getName() : "<anonymous>");
  } else if (Node.isClassDeclaration(node)) {
    kind = "class";
    name = node.getName() ?? "<anonymous>";
  } else if (Node.isVariableDeclaration(node)) {
    kind = "variable";
    name = node.getName();
  } else if (Node.isVariableStatement(node)) {
    kind = "variable";
    name = node.getDeclarations().map((d) => d.getName()).join(", ") || "<anonymous>";
  } else if (Node.isInterfaceDeclaration(node)) {
    kind = "interface";
    name = node.getName();
  } else if (Node.isTypeAliasDeclaration(node)) {
    kind = "type-alias";
    name = node.getName();
  }

  return {
    name,
    kind,
    filePath: normalizePath(filePath),
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    startChar: node.getStart(),
    endChar: node.getEnd(),
    sourceText: node.getText(),
  };
}

/**
 * Extracts sliced target information from an existing Stage 2 ParsedNode.
 */
export function extractNodeFromParsedNode(parsedNode: ParsedNode): SlicedTarget {
  return {
    name: parsedNode.name,
    kind: parsedNode.kind,
    filePath: normalizePath(parsedNode.filePath),
    startLine: parsedNode.startLine,
    endLine: parsedNode.endLine,
    startChar: 0,
    endChar: parsedNode.sourceText.length,
    sourceText: parsedNode.sourceText,
  };
}

/**
 * Extracts lightweight dependency signatures for any symbols referenced
 * by the target node in dependency files.
 * Uses a two-pass resolution to also pull in type definitions referenced by signature return/param types.
 * Omits full implementation bodies to save context tokens.
 */
export function extractDependencySignatures(
  targetSource: string,
  dependencyFiles: FileParseResult[],
): DependencySignature[] {
  const result: DependencySignature[] = [];

  for (const depFile of dependencyFiles) {
    const signatures: string[] = [];
    const addedNodeIds = new Set<string>();

    // Pass 1: Directly referenced symbols
    for (const node of depFile.nodes) {
      if (!node.name || node.name === "<anonymous>") continue;
      const regex = new RegExp(`\\b${escapeRegex(node.name)}\\b`);
      if (regex.test(targetSource)) {
        signatures.push(formatLightweightSignature(node));
        addedNodeIds.add(node.id);
      }
    }

    // Pass 2: Indirectly referenced type/interface dependencies present in signature headers
    const signatureContext = signatures.join("\n");
    for (const node of depFile.nodes) {
      if (addedNodeIds.has(node.id)) continue;
      if (node.kind === "interface" || node.kind === "type-alias") {
        const typeRegex = new RegExp(`\\b${escapeRegex(node.name)}\\b`);
        if (typeRegex.test(signatureContext)) {
          signatures.push(formatLightweightSignature(node));
          addedNodeIds.add(node.id);
        }
      }
    }

    if (signatures.length > 0) {
      result.push({
        filePath: normalizePath(depFile.filePath),
        signatures,
      });
    }
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts a node into a lightweight declaration signature (no implementation body).
 */
export function formatLightweightSignature(node: ParsedNode): string {
  const text = node.sourceText.trim();

  // If already an interface or type alias, return directly
  if (node.kind === "interface" || node.kind === "type-alias") {
    return text;
  }

  // If class, return a lightweight declaration
  if (node.kind === "class") {
    return `declare class ${node.name};`;
  }

  // If function or method, strip implementation body
  const braceIdx = text.indexOf("{");
  if (braceIdx !== -1) {
    const header = text.slice(0, braceIdx).trim();
    return header.endsWith(";") ? header : `${header};`;
  }

  // For arrow function: const foo = (x) => ...
  const arrowIdx = text.indexOf("=>");
  if (arrowIdx !== -1) {
    const header = text.slice(0, arrowIdx).trim();
    return header.endsWith(";") ? header : `${header};`;
  }

  return text.endsWith(";") ? text : `${text};`;
}

/**
 * Filters imports to only those relevant to the target source text.
 */
export function extractRelevantImports(targetSource: string, imports: string[]): string[] {
  if (imports.length === 0) return [];

  return imports.filter((imp) => {
    // Check if the import path or identifier appears in the target source
    const cleanSpecifier = imp.replace(/['";]/g, "").trim();
    const basename = path.basename(cleanSpecifier, path.extname(cleanSpecifier));
    const regex = new RegExp(`\\b${escapeRegex(basename)}\\b`);
    return regex.test(targetSource) || imp.includes(basename);
  });
}
