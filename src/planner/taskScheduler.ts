/**
 * Generates the ordered refactor task queue from the dependency DAG. Only
 * nodes flagged with at least one code smell get scheduled — clean code
 * doesn't need the agent's attention. Tasks come out in the DAG's
 * topological order (utilities before consumers), and by source line
 * within a file, so logs and retries read top-to-bottom as expected.
 */
import type { FileParseResult } from "../types/ast.types.js";
import type { DependencyGraph, QueuedTask } from "../types/graph.types.js";

export function scheduleTasks(fileResults: FileParseResult[], graph: DependencyGraph): QueuedTask[] {
  const order = graph.topologicalOrder();
  const fileByPath = new Map(fileResults.map((f) => [f.filePath, f]));

  const tasks: QueuedTask[] = [];
  let position = 0;

  for (const filePath of order) {
    const file = fileByPath.get(filePath);
    if (!file) continue; // graph node with no matching parse result (shouldn't happen in practice)

    const smellyNodes = file.nodes
      .filter((n) => n.smells.length > 0)
      .sort((a, b) => a.startLine - b.startLine);

    for (const node of smellyNodes) {
      tasks.push({
        taskId: `task-${position}`,
        filePath,
        targetNodeId: node.id,
        order: position,
        status: "pending",
      });
      position++;
    }
  }

  return tasks;
}