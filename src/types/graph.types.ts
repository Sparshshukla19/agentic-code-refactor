/**
 * Types for the repository-wide dependency DAG and the
 * topologically-ordered execution queue derived from it.
 */

export interface GraphNode {
  id: string; // file path, used as the graph node identity
  filePath: string;
  dependsOn: string[]; // file paths this file imports from
  dependedOnBy: string[]; // file paths that import this file
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  addNode(filePath: string): GraphNode;
  addEdge(fromFilePath: string, toFilePath: string): void;
  topologicalOrder(): string[]; // bottom-up: utilities before consumers
}

export interface QueuedTask {
  taskId: string;
  filePath: string;
  targetNodeId: string; // references ParsedNode.id from ast.types.ts
  order: number; // position in the topological execution queue
  status: "pending" | "in-progress" | "verified" | "failed";
}
