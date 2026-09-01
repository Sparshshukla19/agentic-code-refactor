/**
 * Builds the repository-wide dependency DAG from parsed files and computes
 * a topological sort — the order refactoring tasks must run in so that a
 * utility file is always refactored before the files that consume it.
 */
import path from "node:path";
import type { DependencyGraph, GraphNode } from "../types/graph.types.js";
import type { FileParseResult } from "../types/ast.types.js";

const RESOLVABLE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx"];

/** Thrown when the graph contains a cycle, so topologicalOrder() can't fully drain it. */
export class CircularDependencyError extends Error {
  constructor(public readonly remainingFiles: string[]) {
    super(`Circular dependency detected among: ${remainingFiles.join(", ")}`);
    this.name = "CircularDependencyError";
  }
}

class DependencyGraphImpl implements DependencyGraph {
  nodes: Map<string, GraphNode> = new Map();

  addNode(filePath: string): GraphNode {
    const existing = this.nodes.get(filePath);
    if (existing) return existing;
    const node: GraphNode = { id: filePath, filePath, dependsOn: [], dependedOnBy: [] };
    this.nodes.set(filePath, node);
    return node;
  }

  addEdge(fromFilePath: string, toFilePath: string): void {
    // "fromFilePath depends on toFilePath" — toFilePath must be refactored first.
    const from = this.addNode(fromFilePath);
    const to = this.addNode(toFilePath);
    if (!from.dependsOn.includes(toFilePath)) from.dependsOn.push(toFilePath);
    if (!to.dependedOnBy.includes(fromFilePath)) to.dependedOnBy.push(fromFilePath);
  }

  /**
   * Kahn's algorithm: repeatedly remove nodes whose remaining dependency
   * count has dropped to zero. Each removal frees up its dependents, so the
   * result is bottom-up — utilities before consumers. Any node that never
   * reaches zero is part of a cycle.
   */
  topologicalOrder(): string[] {
    const remainingDepCount = new Map<string, number>();
    for (const node of this.nodes.values()) {
      remainingDepCount.set(node.id, node.dependsOn.length);
    }

    const ready: string[] = [...this.nodes.values()]
      .filter((n) => remainingDepCount.get(n.id) === 0)
      .map((n) => n.id);

    const order: string[] = [];

    while (ready.length > 0) {
      const id = ready.shift()!;
      order.push(id);
      const node = this.nodes.get(id)!;
      for (const dependentId of node.dependedOnBy) {
        const remaining = remainingDepCount.get(dependentId)! - 1;
        remainingDepCount.set(dependentId, remaining);
        if (remaining === 0) ready.push(dependentId);
      }
    }

    if (order.length < this.nodes.size) {
      const unresolved = [...this.nodes.keys()].filter((id) => !order.includes(id));
      throw new CircularDependencyError(unresolved);
    }

    return order;
  }
}

export function createDependencyGraph(): DependencyGraph {
  return new DependencyGraphImpl();
}

/**
 * Resolves a raw import specifier (e.g. "./mathUtils") against the set of
 * files we actually parsed. Non-relative specifiers (e.g. "express") are
 * external packages — not part of our internal DAG — and resolve to null.
 */
export function resolveImportSpecifier(
  fromFilePath: string,
  specifier: string,
  knownFilePaths: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null; // external package, not our concern

  const base = path.resolve(path.dirname(fromFilePath), specifier);

  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = base + ext;
    if (knownFilePaths.has(candidate)) return candidate;
  }
  // also try as a directory with an index file: "./utils" -> "./utils/index.ts"
  for (const ext of RESOLVABLE_EXTENSIONS.filter((e) => e !== "")) {
    const candidate = path.join(base, "index" + ext);
    if (knownFilePaths.has(candidate)) return candidate;
  }

  return null;
}

/** Builds the full dependency graph from a batch of already-parsed files. */
export function buildDependencyGraph(fileResults: FileParseResult[]): DependencyGraph {
  const graph = createDependencyGraph();
  const knownFilePaths = new Set(fileResults.map((f) => f.filePath));

  for (const file of fileResults) {
    graph.addNode(file.filePath);
  }

  for (const file of fileResults) {
    for (const specifier of file.imports) {
      const resolved = resolveImportSpecifier(file.filePath, specifier, knownFilePaths);
      if (resolved && resolved !== file.filePath) {
        graph.addEdge(file.filePath, resolved);
      }
    }
  }

  return graph;
}