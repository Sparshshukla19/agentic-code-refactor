/**
 * Combines complexity, impact (fan-in), size, and smell count into one
 * priority score — used to decide WHICH flagged issues are actually worth
 * an LLM call, directly serving the token-optimization goal by skipping
 * low-impact busywork (e.g. one `var` in a 3-line function nobody else
 * uses) in favor of the functions that genuinely need attention.
 *
 * Multiplying the four raw numbers together — the naive version of this —
 * breaks in two ways: a large-but-simple function can outscore a small-
 * but-nasty one purely on line count, and a genuinely complex function
 * that happens to have zero callers (fan-in 0) gets its whole score
 * zeroed out. Each factor below is dampened or offset by 1 so no single
 * factor can dominate or erase the others:
 *   - complexity is used as-is (already a small, meaningful integer)
 *   - fan-in becomes (1 + fanIn) so "nobody calls this yet" doesn't zero
 *     out a function that's complex on its own merits
 *   - lines of code is log2-dampened — size matters, but doubling a
 *     function's length shouldn't double its priority
 *   - smell count becomes (1 + smellCount) for the same zero-safety reason
 *
 * IMPORTANT SIMPLIFICATION: fan-in here is FILE-level (how many other
 * files import this file at all), not true per-function call-graph fan-in
 * (how many places call this specific function). Function-level fan-in
 * would need call-site tracking across files, which isn't built yet — this
 * is a reasonable proxy for a first pass, not the final word.
 */
import type { DependencyGraph, QueuedTask } from "../types/graph.types.js";
import type { FileParseResult, ParsedNode } from "../types/ast.types.js";

export const DEFAULT_REFACTOR_THRESHOLD = 15;

/** Looks up a file's fan-in (how many other known files import it) from the DAG. */
export function getFileFanIn(filePath: string, graph: DependencyGraph): number {
  return graph.nodes.get(filePath)?.dependedOnBy.length ?? 0;
}

/** The dampened refactoring-priority score for one node. Higher = more worth fixing. */
export function calculateRefactoringScore(node: ParsedNode, fanIn: number): number {
  const linesOfCode = node.endLine - node.startLine + 1;
  const impactFactor = 1 + fanIn;
  const sizeFactor = Math.log2(1 + linesOfCode);
  const smellFactor = 1 + node.smells.length;

  return node.complexity * impactFactor * sizeFactor * smellFactor;
}

/** A node is worth scheduling if it has at least one smell AND clears the priority threshold. */
export function shouldRefactor(node: ParsedNode, fanIn: number, threshold: number = DEFAULT_REFACTOR_THRESHOLD): boolean {
  return node.smells.length > 0 && calculateRefactoringScore(node, fanIn) >= threshold;
}

/**
 * Takes an already-scheduled task queue (from taskScheduler.scheduleTasks)
 * and re-filters/re-sorts it by refactoring score. This is intentionally a
 * SEPARATE pass rather than built into scheduleTasks itself, for one
 * critical reason: scores must never be used to reorder tasks ACROSS
 * files, only within a single file's own group of tasks. Doing otherwise
 * would break the DAG's bottom-up guarantee — a high-scoring function in
 * userController.js must still never jump ahead of mathUtils.js, since
 * mathUtils has to be typed first regardless of how "important" the
 * consumer's fix looks. File order is preserved exactly as scheduleTasks
 * produced it; only the order WITHIN each file's group, and whether a task
 * survives at all, changes here.
 */
export function prioritizeTasks(
  tasks: QueuedTask[],
  fileResults: FileParseResult[],
  graph: DependencyGraph,
  threshold: number = DEFAULT_REFACTOR_THRESHOLD,
): QueuedTask[] {
  const nodeById = new Map(fileResults.flatMap((f) => f.nodes.map((n) => [n.id, n] as const)));

  const fileOrder: string[] = [];
  const byFile = new Map<string, QueuedTask[]>();
  for (const task of tasks) {
    if (!byFile.has(task.filePath)) {
      byFile.set(task.filePath, []);
      fileOrder.push(task.filePath);
    }
    byFile.get(task.filePath)!.push(task);
  }

  const result: QueuedTask[] = [];
  let position = 0;

  for (const filePath of fileOrder) {
    const fanIn = getFileFanIn(filePath, graph);
    const scored = byFile
      .get(filePath)!
      .map((task) => {
        const node = nodeById.get(task.targetNodeId);
        return { task, score: node ? calculateRefactoringScore(node, fanIn) : 0, meetsBar: node ? shouldRefactor(node, fanIn, threshold) : false };
      })
      .filter((entry) => entry.meetsBar)
      .sort((a, b) => b.score - a.score);

    for (const { task } of scored) {
      result.push({ ...task, taskId: `task-${position}`, order: position });
      position++;
    }
  }

  return result;
}