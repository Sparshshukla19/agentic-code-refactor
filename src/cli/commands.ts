/**
 * Commander.js command definitions (run, analyze)
 */
import { Command } from "commander";
import path from "node:path";
import { ingestWorkspace } from "../parser/workspace.js";
import { analyzeWorkspace } from "../parser/astEngine.js";
import { buildDependencyGraph, topologicalSort } from "../planner/dependencyGraph.js";
import { scheduleTasks } from "../planner/taskScheduler.js";
import { buildOptimizedPayload } from "../planner/contextSlicer.js";

export function notImplemented(): never {
  throw new Error("commands: not yet implemented");
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("autorefactor")
    .description("Autonomous agentic codebase refactoring engine")
    .version("0.1.0");

  program
    .command("analyze [targetPath]")
    .description("Analyze project workspace (Stages 1 - 3)")
    .option("--no-js", "Exclude JavaScript files from ingestion")
    .action(async (targetPath?: string, options?: { js?: boolean }) => {
      try {
        const inputPath = targetPath ?? "./test-target";
        const projectRoot = path.resolve(process.cwd(), inputPath);

        // Stage 1: Workspace Ingestion
        const workspaceResult = await ingestWorkspace(projectRoot, {
          includeJs: options?.js,
        });

        // Stage 2: AST Parser & Smell Detection
        const parseResults = analyzeWorkspace(workspaceResult);

        // Stage 3: Dependency Graph & Topological Sorting
        const graph = buildDependencyGraph(parseResults);
        const queue = topologicalSort(graph);

        console.log("Workspace loaded successfully\n");
        console.log("Project Root:");
        console.log(workspaceResult.projectRoot);
        console.log("\nSource Files:");
        console.log(workspaceResult.fileCount);
        console.log("\nTotal Characters:");
        console.log(workspaceResult.totalCharacters);
        console.log("\nExcluded:");
        console.log("node_modules\ntests\ndist");
        console.log("\nVirtual TypeScript Project:");
        console.log("READY");

        console.log("\nStage 2 AST Analysis:");
        console.log(`Parsed Files: ${parseResults.length}`);

        console.log("\nDependency Graph:");
        if (graph.edges.length > 0) {
          for (const edge of graph.edges) {
            const fromName = path.basename(edge.from);
            const toName = path.basename(edge.to);
            console.log(`${toName}\n    ↑ required by\n${fromName}`);
          }
        } else {
          console.log("(No internal project dependencies detected)");
        }

        console.log("\nRefactoring Order:");
        queue.files.forEach((file, idx) => {
          console.log(`${idx + 1}. ${path.basename(file)}`);
        });

        console.log("\nCycle:");
        if (queue.hasCycle && queue.cycle) {
          console.log(`DETECTED: ${queue.cycle.map((f) => path.basename(f)).join(" -> ")}`);
        } else {
          console.log("NONE");
        }

        console.log("\nStage 4 Token Optimization Preview:");
        const tasks = scheduleTasks(parseResults, graph);
        if (tasks.length > 0) {
          const sampleTask =
            tasks.find((t) => t.filePath.includes("userController") && t.targetNodeId.includes("getUserScoreSummary")) ??
            tasks[0];
          const payload = buildOptimizedPayload({ task: sampleTask, fileResults: parseResults, graph });
          console.log(`Target: ${payload.context.nodeKind} "${payload.context.name}" (${path.basename(payload.context.targetFile)})`);
          console.log(`Original Context: ${payload.metrics.originalCharacters} characters / ~${payload.metrics.estimatedOriginalTokens} tokens`);
          console.log(`Optimized Context: ${payload.metrics.optimizedCharacters} characters / ~${payload.metrics.estimatedOptimizedTokens} tokens`);
          console.log(`Estimated Reduction: ${payload.metrics.tokenReductionPercentage}%`);
          console.log(`Dependency Signatures: ${payload.context.dependencies.length} file(s)`);
        } else {
          console.log("(No tasks scheduled)");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Analysis failed: ${msg}`);
        process.exit(1);
      }
    });

  // Stage 7: Report Generation & Artifact Output
  program
    .command("report [targetPath]")
    .description("Execute refactoring pipeline and generate Stage 7 reports (JSON & Markdown)")
    .option("-o, --output <dir>", "Artifact output directory", "artifacts")
    .option("--overwrite", "Overwrite existing artifact files", false)
    .option("--dry-run", "Simulate refactoring without writing files to disk", false)
    .option("--mechanical-only", "Run only mechanical transformations without LLM calls", false)
    .option("--no-js", "Exclude JavaScript files from ingestion")
    .option("--json", "Print raw JSON report to stdout", false)
    .action(
      async (
        targetPath?: string,
        options?: {
          output?: string;
          overwrite?: boolean;
          dryRun?: boolean;
          mechanicalOnly?: boolean;
          js?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const { runRefactoringPipeline } = await import("../reporting/pipelineRunner.js");
          const { generateJsonReport } = await import("../reporting/reportGenerator.js");

          const result = await runRefactoringPipeline({
            projectRoot: targetPath ?? "./test-target",
            includeJs: options?.js,
            outputDir: options?.output,
            overwrite: options?.overwrite,
            dryRun: options?.dryRun,
            mechanicalOnly: options?.mechanicalOnly,
          });

          if (options?.json) {
            console.log(generateJsonReport(result.report, true));
            return;
          }

          printCliReportSummary(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Report generation failed: ${msg}`);
          process.exit(1);
        }
      },
    );

  program
    .command("refactor [targetPath]")
    .description("Execute refactoring pipeline with optional Stage 7 reporting and artifact output")
    .option("--report", "Generate JSON and Markdown reports and output artifacts", true)
    .option("-o, --output <dir>", "Artifact output directory", "artifacts")
    .option("--overwrite", "Overwrite existing artifact files", false)
    .option("--dry-run", "Simulate refactoring without writing files to disk", false)
    .option("--mechanical-only", "Run only mechanical transformations without LLM calls", false)
    .option("--no-js", "Exclude JavaScript files from ingestion")
    .action(
      async (
        targetPath?: string,
        options?: {
          report?: boolean;
          output?: string;
          overwrite?: boolean;
          dryRun?: boolean;
          mechanicalOnly?: boolean;
          js?: boolean;
        },
      ) => {
        try {
          const { runRefactoringPipeline } = await import("../reporting/pipelineRunner.js");

          const result = await runRefactoringPipeline({
            projectRoot: targetPath ?? "./test-target",
            includeJs: options?.js,
            outputDir: options?.output,
            overwrite: options?.overwrite,
            dryRun: options?.dryRun,
            mechanicalOnly: options?.mechanicalOnly,
            writeArtifacts: options?.report !== false,
          });

          printCliReportSummary(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Refactoring failed: ${msg}`);
          process.exit(1);
        }
      },
    );

  return program;
}

function printCliReportSummary(result: import("../reporting/pipelineRunner.js").PipelineExecutionResult): void {
  const { report, artifactResult } = result;
  console.log("\n==================================================");
  console.log("AGENTIC CODE REFACTOR: STAGE 7 REPORT");
  console.log("==================================================");
  console.log(`Project Root:      ${report.project.root}`);
  console.log(`Files Analyzed:    ${report.project.filesAnalyzed}`);
  console.log(`Files Processed:   ${report.project.filesProcessed}`);
  console.log(`Total Characters:  ${report.project.totalCharacters.toLocaleString()}`);

  console.log("\nTechnical Debt:");
  console.log(`  Before:          ${report.technicalDebt.beforeSmellCount}`);
  console.log(`  After:           ${report.technicalDebt.afterSmellCount}`);
  console.log(`  Fixed:           ${report.technicalDebt.fixedSmellCount}`);
  console.log(`  Reduction:       ${report.technicalDebt.smellReductionPercentage}%`);

  console.log("\nToken Optimization:");
  if (report.tokenOptimization.estimatedOriginalTokens !== null) {
    console.log(`  Original Tokens: ~${report.tokenOptimization.estimatedOriginalTokens}`);
    console.log(`  Optimized Tokens:~${report.tokenOptimization.estimatedOptimizedTokens}`);
    console.log(`  Tokens Saved:    ~${report.tokenOptimization.estimatedTokensSaved}`);
    console.log(`  Reduction:       ${report.tokenOptimization.tokenReductionPercentage}%`);
  } else {
    console.log("  Token Metrics:   Unavailable");
  }

  console.log("\nValidation Results:");
  console.log(`  Syntax Valid:    ${report.validation.syntaxValid ? "PASS" : "FAIL"}`);
  console.log(`  Type Safe:       ${report.validation.typeSafe ? "PASS" : "FAIL"}`);
  console.log(`  Trivia Kept:     ${report.validation.triviaPreserved ? "PASS" : "FAIL"}`);
  console.log(`  Accepted:        ${report.validation.acceptedTransformations}`);
  console.log(`  Rejected:        ${report.validation.rejectedTransformations}`);

  console.log("\nExecution Status:  " + report.executionSummary.overallExecutionStatus.toUpperCase());

  if (artifactResult) {
    console.log("\nArtifacts:");
    console.log(`  JSON Report:     ${artifactResult.jsonReportPath}`);
    console.log(`  Markdown Report: ${artifactResult.markdownReportPath}`);
    console.log(`  Refactored Files:${artifactResult.refactoredFiles.length} file(s)`);
  }
  console.log("==================================================\n");
}
