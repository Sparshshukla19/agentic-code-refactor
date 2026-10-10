/**
 * Builds the repository-wide dependency DAG from parsed files and computes
 * a topological sort — the order refactoring tasks must run in so that a
 * utility file is always refactored before the files that consume it.
 *
 * Stage 3: Dependency Graph & Topological Sorter.
 */
import path from "node:path";
import type {
  DependencyEdge,
  DependencyGraph,
  GraphNode,
  RefactoringQueue,
} from "../types/graph.types.js";
import type { FileParseResult } from "../types/ast.types.js";

export type {
  DependencyEdge,
  DependencyGraph,
  GraphNode,
  RefactoringQueue,
};

const RESOLVABLE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx"];

/**
 * Normalizes file paths to forward slashes across all platforms.
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** Thrown when the graph contains a cycle, so topologicalOrder() can't fully drain it. */
export class CircularDependencyError extends Error {
  constructor(public readonly remainingFiles: string[]) {
    super(`Circular dependency detected among: ${remainingFiles.join(", ")}`);
    this.name = "CircularDependencyError";
  }
}

class DependencyGraphImpl implements DependencyGraph {
  nodes: Map<string, GraphNode> = new Map();
  edges: DependencyEdge[] = [];

  addNode(filePath: string): GraphNode {
    const normalized = normalizePath(filePath);
    const existing = this.nodes.get(normalized);
    if (existing) return existing;
    const node: GraphNode = {
      id: normalized,
      filePath: normalized,
      dependsOn: [],
      dependedOnBy: [],
    };
    this.nodes.set(normalized, node);
    return node;
  }

  addEdge(
    fromFilePath: string,
    toFilePath: string,
    importPath: string = "",
    importType?: DependencyEdge["importType"],
  ): void {
    // "fromFilePath depends on toFilePath" — toFilePath must be refactored first.
    const from = this.addNode(fromFilePath);
    const to = this.addNode(toFilePath);

    // Store the NORMALIZED paths (from/to.filePath)
    if (!from.dependsOn.includes(to.filePath)) from.dependsOn.push(to.filePath);
    if (!to.dependedOnBy.includes(from.filePath)) to.dependedOnBy.push(from.filePath);

    // Record the edge metadata
    const rawImport = importPath || to.filePath;
    const existingEdge = this.edges.find(
      (e) => e.from === from.filePath && e.to === to.filePath && e.importPath === rawImport,
    );
    if (!existingEdge) {
      this.edges.push({
        from: from.filePath,
        to: to.filePath,
        importPath: rawImport,
        importType: importType ?? "named",
      });
    }
  }

  hasCycle(): boolean {
    return this.detectCycle() !== null;
  }

  detectCycle(): string[] | null {
    return findCycleInGraph(this.nodes);
  }

  /**
   * Kahn's algorithm: repeatedly remove nodes whose remaining dependency
   * count has dropped to zero. Each removal frees up its dependents, so the
   * result is bottom-up — utilities before consumers.
   * Throws CircularDependencyError if any cycle exists.
   */
  topologicalOrder(): string[] {
    const queue = topologicalSort(this);
    if (queue.hasCycle) {
      const unresolved = [...this.nodes.keys()].filter((id) => !queue.files.includes(id));
      throw new CircularDependencyError(unresolved);
    }
    return queue.files;
  }
}

/**
 * Cycle detection via DFS depth-first search on the directed graph.
 * Returns the cycle path as an array of file paths, or null if acyclic.
 */
function findCycleInGraph(nodes: Map<string, GraphNode>): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parentMap = new Map<string, string>();

  function dfs(current: string): string[] | null {
    visited.add(current);
    inStack.add(current);

    const node = nodes.get(current);
    if (node) {
      for (const neighbor of node.dependsOn) {
        if (!nodes.has(neighbor)) continue;

        if (inStack.has(neighbor)) {
          // Detected cycle: trace path from current back to neighbor
          const cycle: string[] = [neighbor, current];
          let curr = current;
          while (parentMap.has(curr) && parentMap.get(curr) !== neighbor) {
            curr = parentMap.get(curr)!;
            cycle.push(curr);
          }
          return cycle.reverse();
        }

        if (!visited.has(neighbor)) {
          parentMap.set(neighbor, current);
          const found = dfs(neighbor);
          if (found) return found;
        }
      }
    }

    inStack.delete(current);
    return null;
  }

  for (const nodeId of nodes.keys()) {
    if (!visited.has(nodeId)) {
      const cycle = dfs(nodeId);
      if (cycle) return cycle;
    }
  }

  return null;
}

/**
 * Kahn's algorithm: computes topological ordering of files for bottom-up refactoring.
 * Lower-level utilities are processed before higher-level consumers.
 * Detects cycles gracefully and returns a RefactoringQueue object.
 */
export function topologicalSort(graph: DependencyGraph): RefactoringQueue {
  const remainingDepCount = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    remainingDepCount.set(node.id, node.dependsOn.length);
  }

  // Nodes with 0 remaining dependencies are ready first
  const ready: string[] = [...graph.nodes.values()]
    .filter((n) => remainingDepCount.get(n.id) === 0)
    .map((n) => n.id)
    .sort();

  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    const node = graph.nodes.get(id);
    if (!node) continue;

    for (const dependentId of node.dependedOnBy) {
      const remaining = (remainingDepCount.get(dependentId) ?? 1) - 1;
      remainingDepCount.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
        ready.sort();
      }
    }
  }

  if (order.length < graph.nodes.size) {
    const cycle = graph.detectCycle() ?? [...graph.nodes.keys()].filter((id) => !order.includes(id));
    return {
      files: order,
      hasCycle: true,
      cycle,
    };
  }

  return {
    files: order,
    hasCycle: false,
  };
}

export function createDependencyGraph(): DependencyGraph {
  return new DependencyGraphImpl();
}

/**
 * Resolves a raw import specifier (e.g. "./mathUtils", "../service/userService")
 * against the set of project source files.
 * Non-relative specifiers (e.g. "express", "node:path") are external packages
 * and resolve to null.
 * Handles both Windows drive letters and POSIX-style mock paths consistently.
 */
export function resolveImportSpecifier(
  fromFilePath: string,
  specifier: string,
  knownFilePaths: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null; // external package

  const normalizedFrom = normalizePath(fromFilePath);
  const dir = normalizedFrom.includes("/")
    ? normalizedFrom.substring(0, normalizedFrom.lastIndexOf("/"))
    : ".";

  const base = path.posix.normalize(dir + "/" + specifier);

  // 1. Direct extension match or candidate with RESOLVABLE_EXTENSIONS
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = normalizePath(base + ext);
    if (knownFilePaths.has(candidate)) return candidate;
  }

  // 2. ESM .js/.jsx import pointing to a TypeScript .ts/.tsx file (NodeNext convention)
  if (specifier.endsWith(".js") || specifier.endsWith(".jsx")) {
    const withoutExt = base.replace(/\.jsx?$/, "");
    for (const tsExt of [".ts", ".tsx"]) {
      const candidate = normalizePath(withoutExt + tsExt);
      if (knownFilePaths.has(candidate)) return candidate;
    }
  }

  // 3. Directory with an index file: "./utils" -> "./utils/index.ts"
  for (const ext of RESOLVABLE_EXTENSIONS.filter((e) => e !== "")) {
    const candidate = normalizePath(path.posix.join(base, "index" + ext));
    if (knownFilePaths.has(candidate)) return candidate;
  }

  return null;
}

/** Builds the full dependency graph from a batch of already-parsed Stage 2 files. */
export function buildDependencyGraph(fileResults: FileParseResult[]): DependencyGraph {
  const graph = createDependencyGraph();
  const knownFilePaths = new Set(fileResults.map((f) => normalizePath(f.filePath)));

  for (const file of fileResults) {
    graph.addNode(file.filePath);
  }

  for (const file of fileResults) {
    if (file.importDeclarations && file.importDeclarations.length > 0) {
      for (const decl of file.importDeclarations) {
        const resolved = resolveImportSpecifier(file.filePath, decl.moduleSpecifier, knownFilePaths);
        if (resolved && resolved !== normalizePath(file.filePath)) {
          let importType: DependencyEdge["importType"] = "named";
          if (decl.isRequire) {
            importType = "require";
          } else if (decl.namespaceImport) {
            importType = "namespace";
          } else if (decl.defaultImport) {
            importType = "default";
          } else if (decl.namedImports.length > 0) {
            importType = "named";
          } else {
            importType = "side-effect";
          }
          graph.addEdge(file.filePath, resolved, decl.moduleSpecifier, importType);
        }
      }
    } else {
      // Fallback for mock fileResults in tests with string imports
      for (const specifier of file.imports) {
        const resolved = resolveImportSpecifier(file.filePath, specifier, knownFilePaths);
        if (resolved && resolved !== normalizePath(file.filePath)) {
          graph.addEdge(file.filePath, resolved, specifier);
        }
      }
    }
  }

  return graph;
}
