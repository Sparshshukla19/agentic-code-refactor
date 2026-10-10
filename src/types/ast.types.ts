/**
 * Types describing parsed source nodes and detected code smells.
 * Produced by src/parser/astEngine.ts and consumed by planner + agent layers.
 */

export type CodeSmellType =
  | "untyped-signature"
  | "missing-return-type"
  | "callback-hell"
  | "implicit-any"
  | "any-usage"
  | "var-usage"
  | "long-function"
  | "deep-nesting"
  | "no-error-handling"
  | "duplicate-logic"
  | "high-complexity";

export type NodeKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type-alias"
  | "variable"
  | "arrow-function";

export interface CodeSmell {
  type: CodeSmellType;
  message: string;
  line: number;
  column?: number;
  start?: number;
  end?: number;
  code?: string;
  filePath?: string;
}

export interface ParsedNode {
  id: string; // stable id, e.g. `${filePath}::${symbolName}`
  kind: NodeKind;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceText: string;
  complexity: number; // McCabe cyclomatic complexity — see astEngine.ts for how it's computed
  smells: CodeSmell[];
  trivia?: {
    leadingComments: string[];
    trailingComments: string[];
    jsDoc: string[];
    inlineComments?: string[];
  };
}

export interface ImportInfo {
  moduleSpecifier: string;
  defaultImport?: string;
  namedImports: string[];
  namespaceImport?: string;
  isRequire: boolean;
  line: number;
  column: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number;
  column: number;
}

export interface FileParseResult {
  filePath: string;
  language: "js" | "ts";
  nodes: ParsedNode[];
  imports: string[]; // resolved import specifiers found in this file
  exports: string[]; // exported symbol names
  fullText: string; // the file's raw source — the naive "send the whole file" baseline for token-savings comparisons
  sourceText?: string; // exact raw source code
  smells?: CodeSmell[]; // aggregated file-level and node-level smells
  importDeclarations?: ImportInfo[]; // detailed import metadata
  exportDeclarations?: ExportInfo[]; // detailed export metadata
}

export interface AstEngineOptions {
  longFunctionThreshold?: number;
  deepNestingThreshold?: number;
  callbackHellThreshold?: number;
  complexityThreshold?: number;
}