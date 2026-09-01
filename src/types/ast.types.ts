/**
 * Types describing parsed source nodes and detected code smells.
 * Produced by src/parser/astEngine.ts and consumed by planner + agent layers.
 */

export type CodeSmellType =
  | "untyped-signature"
  | "callback-hell"
  | "implicit-any"
  | "var-usage"
  | "no-error-handling"
  | "duplicate-logic";

export type NodeKind = "function" | "class" | "method" | "interface" | "type-alias" | "variable";

export interface CodeSmell {
  type: CodeSmellType;
  message: string;
  line: number;
}

export interface ParsedNode {
  id: string; // stable id, e.g. `${filePath}::${symbolName}`
  kind: NodeKind;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceText: string;
  smells: CodeSmell[];
}

export interface FileParseResult {
  filePath: string;
  language: "js" | "ts";
  nodes: ParsedNode[];
  imports: string[]; // resolved import specifiers found in this file
  exports: string[]; // exported symbol names
}
