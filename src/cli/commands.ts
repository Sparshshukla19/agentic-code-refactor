/**
 * Commander.js command definitions: `analyze` (read-only, no LLM, no
 * writes) and `run` (the full pipeline). Kept thin — all real work lives in
 * the modules these call; this file only parses arguments, applies safety
 * checks, and formats output.
 */
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { parseFiles } from "../parser/astEngine.js";
import { buildDependencyGraph } from "../parser/dependencyGraph.js";
import { scheduleTasks } from "../planner/taskScheduler.js";
import { calculateRefactoringScore, DEFAULT_REFACTOR_THRESHOLD, getFileFanIn, prioritizeTasks } from "../planner/refactorScore.js";
import { aggregateTokenSavings, buildRefactorObjective, estimateTokenSavings } from "../planner/contextSlicer.js";
import { getLlmConfigProblem } from "../agent/llmClient.js";
import { hasUncommittedChanges } from "../vcs/gitManager.js";
import { runPipeline } from "../index.js";
import { discoverFiles } from "./fileDiscovery.js";

/** Plain-text analysis of a target: what's wrong, in what order it would be fixed, and the token estimate. No LLM, no writes. */
export function formatAnalysis(targetDir: string, threshold: number = DEFAULT_REFACTOR_THRESHOLD): string {
  const files = discoverFiles(targetDir);
  const results = parseFiles(files);
  const graph = buildDependencyGraph(results);
  const order = graph.topologicalOrder();
  const byPath = new Map(results.map((r) => [r.filePath, r]));
  const rel = (p: string) => path.relative(targetDir, p) || path.basename(p);

  const lines: string[] = [`Analyzed ${results.length} file(s) in ${targetDir}`, "", "Processing order (dependencies first):"];
  order.forEach((f, i) => lines.push(`  ${i + 1}. ${rel(f)}`));

  lines.push("", `Findings (refactor score threshold: ${threshold}):`);
  for (const filePath of order) {
    const file = byPath.get(filePath)!;
    const fanIn = getFileFanIn(filePath, graph);
    for (const node of file.nodes.filter((n) => n.smells.length > 0)) {
      const score = calculateRefactoringScore(node, fanIn);
      const smells = node.smells.map((s) => s.type).join(", ");
      lines.push(
        `  ${rel(filePath)} :: ${node.name}  complexity=${node.complexity}  score=${score.toFixed(1)} ${score >= threshold ? "[will refactor]" : "[below threshold]"}`,
        `      ${smells}`,
      );
    }
  }

  const tasks = prioritizeTasks(scheduleTasks(results, graph), results, graph, threshold);
  lines.push("", `${tasks.length} task(s) would run.`);
  const reports = tasks.map((t) => {
    const file = byPath.get(t.filePath)!;
    return estimateTokenSavings(file, buildRefactorObjective(t, file).contextSlice);
  });
  if (reports.length > 0) {
    const total = aggregateTokenSavings(reports);
    lines.push(`Estimated ~${total.estimatedSliceTokens} tokens sent vs ~${total.estimatedFullFileTokens} for whole-file sends (${total.reductionPercent}% smaller).`);
  }
  return lines.join("\n");
}

function colorize(message: string): string {
  if (message.startsWith("✓") || message.includes("verified")) return chalk.green(message);
  if (message.startsWith("✗") || message.includes("failed")) return chalk.red(message);
  if (message.startsWith("→")) return chalk.cyan(message);
  return chalk.gray(message);
}

function parseNumber(label: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number (got "${raw}")`);
  return value;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("autorefactor").description("Token-efficient agentic refactoring of legacy JS/TS codebases");

  program
    .command("analyze <target>")
    .description("Show what would be refactored and why, without calling an LLM or changing any file")
    .option("--min-score <n>", "refactor score threshold", String(DEFAULT_REFACTOR_THRESHOLD))
    .action((target: string, opts: { minScore: string }) => {
      try {
        console.log(formatAnalysis(path.resolve(target), parseNumber("--min-score", opts.minScore)));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  program
    .command("run <target>")
    .description("Refactor the target: patch, verify, retry on failure, and commit each verified fix")
    .option("--no-git", "skip branch/commit/diff (patches are still applied to the files)")
    .option("--run-tests", "also run the target's own Jest suite as a verification stage")
    .option("--max-retries <n>", "attempts per task before giving up", "3")
    .option("--min-score <n>", "refactor score threshold", String(DEFAULT_REFACTOR_THRESHOLD))
    .action(async (target: string, opts: { git: boolean; runTests?: boolean; maxRetries: string; minScore: string }) => {
      try {
        const targetDir = path.resolve(target);
        const filePaths = discoverFiles(targetDir);
        if (filePaths.length === 0) throw new Error(`No analyzable .js/.ts files found in ${targetDir}`);

        const configProblem = getLlmConfigProblem();
        if (configProblem) throw new Error(configProblem);

        if (opts.git) {
          // Refuse to branch off a dirty tree: the fixes would be mixed with the user's own uncommitted work.
          let dirty: boolean;
          try {
            dirty = await hasUncommittedChanges(targetDir);
          } catch {
            throw new Error(`${targetDir} is not inside a git repository. Run \`git init\` there, or pass --no-git.`);
          }
          if (dirty) throw new Error("The git working tree has uncommitted changes. Commit or stash them first, or pass --no-git.");
        }

        const result = await runPipeline({
          targetDir,
          filePaths,
          skipGit: !opts.git,
          runTestSuite: Boolean(opts.runTests),
          maxRetries: parseNumber("--max-retries", opts.maxRetries),
          minRefactorScore: parseNumber("--min-score", opts.minScore),
          onProgress: (m) => console.log(colorize(m)),
        });

        const passed = result.taskOutcomes.filter((t) => t.passed).length;
        console.log(`\n${passed}/${result.taskOutcomes.length} task(s) verified.`);
        console.log(`Tokens: ~${result.tokenSavings.estimatedSliceTokens} sent vs ~${result.tokenSavings.estimatedFullFileTokens} for whole-file sends (${result.tokenSavings.reductionPercent}% smaller).`);

        if (result.diffReport) {
          const reportDir = path.resolve(".autorefactor-work");
          fs.mkdirSync(reportDir, { recursive: true });
          const reportPath = path.join(reportDir, `report-${Date.now()}.md`);
          fs.writeFileSync(reportPath, result.diffReport);
          console.log(`Branch: ${result.branchName}\nReport: ${reportPath}`);
        }
        if (passed < result.taskOutcomes.length) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  return program;
}