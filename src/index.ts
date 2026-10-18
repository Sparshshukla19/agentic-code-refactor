/**
 * Main pipeline orchestrator — connects all six stations in order:
 *   Parser -> Dependency Graph -> Planner -> Agent -> Sandbox -> Delivery
 *
 * Per-task safety rules (each added after finding a real gap):
 *  - The file is snapshotted before a task starts. Every retry begins from
 *    that snapshot, so an attempt is never applied on top of an earlier
 *    failed attempt (which would break if the failed attempt renamed the
 *    function). If the task ends unverified, the snapshot is restored, so a
 *    broken patch is never left on disk for a later task to build on or
 *    commit.
 *  - After a verified fix the file is re-parsed, so later tasks in the same
 *    file get context slices built from the code as it now is.
 */
import fs from "node:fs";
import path from "node:path";
import { createProject, parseFiles } from "./parser/astEngine.js";
import { buildDependencyGraph } from "./parser/dependencyGraph.js";
import { applyPatch } from "./parser/nodeExtractor.js";
import { scheduleTasks } from "./planner/taskScheduler.js";
import { prioritizeTasks, DEFAULT_REFACTOR_THRESHOLD } from "./planner/refactorScore.js";
import { buildRefactorObjective, estimateTokenSavings, aggregateTokenSavings, type TokenSavingsReport } from "./planner/contextSlicer.js";
import { runRefactorTask, buildRetryTurns } from "./agent/reactLoop.js";
import { describeModel, pickModelTier, type ConversationTurn } from "./agent/llmClient.js";
import { createVerificationProject, typeCheckFile } from "./sandbox/typeChecker.js";
import { lintFile } from "./sandbox/linterRunner.js";
import { runTests } from "./sandbox/testRunner.js";
import { combineStageResults, extractErrorMessages, recordAttempt, shouldRetry, startReflection } from "./sandbox/reflector.js";
import { createRefactorBranch, commitFile, getCurrentBranch } from "./vcs/gitManager.js";
import { getUnifiedDiff, formatDiffReport, type TaskSummaryEntry } from "./vcs/diffGenerator.js";
import type { FileParseResult } from "./types/ast.types.js";
import type { StageResult, VerificationResult } from "./types/verification.types.js";

export interface PipelineOptions {
  targetDir: string; // the root of the codebase being refactored (e.g. test-target/)
  filePaths: string[]; // absolute paths to the files to analyze, within targetDir
  maxRetries?: number;
  minRefactorScore?: number;
  runTestSuite?: boolean; // whether to actually run the target's test suite (needs it installed)
  skipGit?: boolean; // useful for a dry run with no git side effects
  onProgress?: (message: string) => void; // called as the pipeline works, for CLI output
}

export interface ActualUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface PipelineResult {
  actualUsage: ActualUsage; // what the API really billed — vs tokenSavings, which is an estimate
  branchName?: string;
  diffReport?: string;
  taskOutcomes: TaskSummaryEntry[];
  tokenSavings: TokenSavingsReport;
}

/** Verifies the already-patched file on disk: type check, lint, and optionally the target's tests. */
async function verifyTask(filePath: string, targetDir: string, runTestSuite: boolean): Promise<VerificationResult> {
  const verificationProject = createVerificationProject();
  verificationProject.addSourceFileAtPath(filePath);

  const stages: StageResult[] = [typeCheckFile(verificationProject, filePath), await lintFile(filePath)];
  if (runTestSuite) {
    stages.push(await runTests({ cwd: targetDir }));
  }

  return combineStageResults(filePath, stages);
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const log = options.onProgress ?? (() => {});
  const maxRetries = options.maxRetries ?? 3;
  const threshold = options.minRefactorScore ?? DEFAULT_REFACTOR_THRESHOLD;

  // Station 1 + 2: parse everything, build the dependency order.
  const fileResults: FileParseResult[] = parseFiles(options.filePaths);
  const graph = buildDependencyGraph(fileResults);
  const fileByPath = new Map(fileResults.map((f) => [f.filePath, f]));

  // Station 6, part 1: create the working branch BEFORE any commits happen,
  // so every verified fix below lands on it rather than on whatever branch
  // happened to be checked out already.
  const baseBranch = options.skipGit ? undefined : await getCurrentBranch(options.targetDir);
  const workingBranch = options.skipGit ? undefined : await createRefactorBranch(options.targetDir);
  if (workingBranch) log(`Created branch ${workingBranch} (from ${baseBranch})`);

  // Station 3: schedule and prioritize.
  const allTasks = scheduleTasks(fileResults, graph);
  const tasks = prioritizeTasks(allTasks, fileResults, graph, threshold);
  log(`${tasks.length} task(s) to run (${allTasks.length - tasks.length} skipped as low priority)`);

  const actualUsage: ActualUsage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  const taskOutcomes: TaskSummaryEntry[] = [];
  const tokenReports: TokenSavingsReport[] = [];

  for (const task of tasks) {
    const file = fileByPath.get(task.filePath)!;
    const targetNode = file.nodes.find((n) => n.id === task.targetNodeId);
    if (!targetNode) {
      const note = "target no longer found (renamed by an earlier fix?)";
      taskOutcomes.push({ taskId: task.taskId, filePath: task.filePath, passed: false, note });
      log(`✗ ${task.taskId}: ${note}`);
      continue;
    }

    const objective = buildRefactorObjective(task, file);
    tokenReports.push(estimateTokenSavings(file, objective.contextSlice));
    log(`→ ${task.taskId}: ${targetNode.name} (${path.basename(task.filePath)}) — ${objective.instruction}`);

    const snapshot = fs.readFileSync(task.filePath, "utf-8");
    let reflection = startReflection(task.taskId, maxRetries);
    let priorTurns: ConversationTurn[] = [];
    let verified = false;
    let note: string | undefined;

    try {
      // Station 4 + 5: generate a patch, apply it, verify it; retry with real
      // error feedback on failure, up to maxRetries.
      do {
        log(`   asking ${describeModel(pickModelTier(targetNode))} for a patch (attempt ${reflection.attempts.length + 1})...`);
        const askedAt = Date.now();
        // A heartbeat, so a slow (not failed) model call never looks like a freeze.
        const heartbeat = setInterval(() => log(`   ...still waiting (${Math.round((Date.now() - askedAt) / 1000)}s)`), 15_000);
        let toolCall: Awaited<ReturnType<typeof runRefactorTask>>;
        let callUsage: { promptTokens: number; completionTokens: number } | undefined;
        try {
          // eslint-disable-next-line no-await-in-loop
          toolCall = await runRefactorTask(objective, targetNode, {
            priorTurns,
            onRetry: (r) => log(`   ⏳ ${r.reason} — waiting ${Math.ceil(r.waitMs / 1000)}s (retry ${r.attempt}/${r.maxRetries})`),
            onUsage: (u) => {
              actualUsage.calls += 1;
              actualUsage.promptTokens += u.promptTokens;
              actualUsage.completionTokens += u.completionTokens;
              callUsage = u;
            },
          });
        } finally {
          clearInterval(heartbeat);
        }
        const usedNote = callUsage ? ` — ${callUsage.promptTokens} in / ${callUsage.completionTokens} out tokens` : "";
        log(`   got "${toolCall.tool}" after ${((Date.now() - askedAt) / 1000).toFixed(1)}s${usedNote}`);

        if (toolCall.tool !== "propose_patch") {
          note = `agent ${toolCall.tool === "abort_task" ? "aborted" : "requested more context"}: ${toolCall.payload.reason}`;
          break;
        }

        const patch = toolCall.payload;

        // Every attempt starts from the original file, never from a failed attempt.
        if (reflection.attempts.length > 0) fs.writeFileSync(task.filePath, snapshot);

        // A fresh project with ONLY the target file loaded fresh from disk.
        const patchProject = createProject();
        patchProject.addSourceFileAtPath(task.filePath);
        // eslint-disable-next-line no-await-in-loop
        const applyResult = await applyPatch(patchProject, targetNode, patch.newSourceText);
        if (!applyResult.applied) {
          note = applyResult.reason;
          reflection = recordAttempt(reflection, patch, [applyResult.reason ?? "Could not apply patch"], false);
          break;
        }

        // eslint-disable-next-line no-await-in-loop
        const verification = await verifyTask(task.filePath, options.targetDir, options.runTestSuite ?? false);
        verified = verification.overallPassed;
        for (const stage of verification.stages.filter((st) => st.skipped)) log(`   ⚠ ${stage.rawOutput}`);
        const errors = verified ? [] : extractErrorMessages(verification);
        reflection = recordAttempt(reflection, patch, errors, verified);
        log(`   attempt ${reflection.attempts.length}: ${verified ? "verified" : `failed (${errors.length} error(s))`}`);

        if (!verified && shouldRetry(reflection)) {
          priorTurns = buildRetryTurns(patch, errors);
        }
      } while (!verified && shouldRetry(reflection));
    } finally {
      // Whatever happened — including an exception from the LLM call — never
      // leave an unverified patch on disk.
      if (!verified && fs.readFileSync(task.filePath, "utf-8") !== snapshot) {
        fs.writeFileSync(task.filePath, snapshot);
        log(`   restored ${path.basename(task.filePath)} to its original state`);
      }
    }

    if (!verified && !note) note = `verification failed after ${reflection.attempts.length} attempt(s)`;
    taskOutcomes.push({ taskId: task.taskId, filePath: task.filePath, passed: verified, note });
    log(`${verified ? "✓" : "✗"} ${task.taskId}${note ? `: ${note}` : ""}`);

    if (verified) {
      if (!options.skipGit) {
        // eslint-disable-next-line no-await-in-loop
        await commitFile(options.targetDir, path.relative(options.targetDir, task.filePath), `Refactor: ${objective.instruction}`);
      }
      // Later tasks in this file must see the code as it is now.
      const [fresh] = parseFiles([task.filePath]);
      fileByPath.set(task.filePath, fresh);
    }
  }

  const tokenSavings = aggregateTokenSavings(tokenReports);

  if (options.skipGit || !baseBranch || !workingBranch) {
    return { taskOutcomes, tokenSavings, actualUsage };
  }

  // Station 6, part 2: diff the working branch against the original base.
  const diff = await getUnifiedDiff(options.targetDir, baseBranch);
  const diffReport = formatDiffReport({
    branchName: workingBranch,
    baseBranch,
    diff,
    tasksSummary: taskOutcomes,
    tokenSavings,
    actualUsage,
  });

  return { branchName: workingBranch, diffReport, taskOutcomes, tokenSavings, actualUsage };
}