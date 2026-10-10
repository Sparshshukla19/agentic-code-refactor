/**
 * Types for the repository-wide dependency DAG and the
 * topologically-ordered execution queue derived from it.
 */

export interface DependencyEdge {
  from: string; // Importer file path
  to: string; // Imported file path
  importPath: string; // Raw import specifier
  importType?: "named" | "default" | "namespace" | "require" | "side-effect";
}

export interface GraphNode {
  id: string; // file path, used as the graph node identity
  filePath: string;
  dependsOn: string[]; // file paths this file imports from
  dependedOnBy: string[]; // file paths that import this file
}

export interface RefactoringQueue {
  files: string[];
  hasCycle: boolean;
  cycle?: string[];
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  edges: DependencyEdge[];
  addNode(filePath: string): GraphNode;
  addEdge(
    fromFilePath: string,
    toFilePath: string,
    importPath?: string,
    importType?: DependencyEdge["importType"],
  ): void;
  topologicalOrder(): string[]; // bottom-up: utilities before consumers (throws on cycle)
  hasCycle(): boolean;
  detectCycle(): string[] | null;
}

export interface QueuedTask {
  taskId: string;
  filePath: string;
  targetNodeId: string; // references ParsedNode.id from ast.types.ts
  order: number; // position in the topological execution queue
  status: "pending" | "in-progress" | "verified" | "failed";
}