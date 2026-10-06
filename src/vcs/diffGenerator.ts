/**
 * Generates a unified diff between the refactor branch and its base, and
 * formats the final markdown report — including the token-efficiency
 * section, since measuring that is this project's stated priority, not
 * an afterthought.
 */
import { getGit } from "./gitManager.js";
import type { TokenSavingsReport } from "../planner/contextSlicer.js";

export async function getUnifiedDiff(cwd: string, baseBranch: string): Promise<string> {
  return getGit(cwd).diff([baseBranch]);
}

export interface TaskSummaryEntry {
  taskId: string;
  filePath: string;
  passed: boolean;
}

export interface DiffReportOptions {
  branchName: string;
  baseBranch: string;
  diff: string;
  tasksSummary: TaskSummaryEntry[];
  tokenSavings?: TokenSavingsReport;
}

/** Formats the full markdown report: task outcomes, token savings, and the raw diff. */
export function formatDiffReport(opts: DiffReportOptions): string {
  const lines: string[] = [];

  lines.push("# AutoRefactor AI — Refactor Report");
  lines.push("");
  lines.push(`**Branch:** \`${opts.branchName}\` (based on \`${opts.baseBranch}\`)`);
  lines.push("");

  const passedCount = opts.tasksSummary.filter((t) => t.passed).length;
  lines.push(`## Tasks — ${passedCount}/${opts.tasksSummary.length} verified`);
  for (const t of opts.tasksSummary) {
    lines.push(`- ${t.passed ? "✅" : "❌"} \`${t.taskId}\` — ${t.filePath}`);
  }

  if (opts.tokenSavings) {
    lines.push("");
    lines.push("## Token Efficiency");
    lines.push(
      `Sent ~${opts.tokenSavings.estimatedSliceTokens} tokens across this run, versus ~${opts.tokenSavings.estimatedFullFileTokens} ` +
        `a naive whole-file approach would have used — **${opts.tokenSavings.reductionPercent}% smaller**.`,
    );
  }

  lines.push("");
  lines.push("## Diff");
  lines.push("```diff");
  lines.push(opts.diff.trim() || "(no changes)");
  lines.push("```");

  return lines.join("\n");
}