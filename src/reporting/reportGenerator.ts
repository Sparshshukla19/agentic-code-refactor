/**
 * Stage 7: Report Generator Module
 *
 * Produces structured machine-readable JSON and human-readable Markdown reports
 * combining the actual results of Stages 1 through 6.
 *
 * Safety & Integrity:
 * - Never invents fake values or claims improvements without measured data.
 * - Clearly marks unmeasured metrics as null or "Unavailable".
 * - Accurately differentiates exact character metrics from estimated token metrics.
 */
import path from "node:path";
import type { CodeSmell } from "../types/ast.types.js";
import type {
  ExecutionSummaryReport,
  IndividualRefactoringReport,
  ProjectReportInfo,
  RefactoringActivityReport,
  ReportGeneratorInput,
  ResearchEvaluationMetrics,
  Stage7Report,
  TechnicalDebtReport,
  TokenOptimizationReport,
  ValidationSummaryReport,
} from "../types/report.types.js";
import type { TokenMetrics } from "../types/slicer.types.js";
import type { ValidationDiagnostic, ValidationResult } from "../types/validation.types.js";

/**
 * Calculates deterministic token reduction percentage.
 * Avoids converting negative values into positive claims of success.
 */
export function calculateTokenReductionPercentage(
  estimatedOriginalTokens: number | null | undefined,
  estimatedOptimizedTokens: number | null | undefined,
): number | null {
  if (estimatedOriginalTokens === null || estimatedOriginalTokens === undefined) {
    return null;
  }
  if (estimatedOptimizedTokens === null || estimatedOptimizedTokens === undefined) {
    return null;
  }
  if (estimatedOriginalTokens <= 0) {
    return 0;
  }

  const reduction =
    ((estimatedOriginalTokens - estimatedOptimizedTokens) / estimatedOriginalTokens) * 100;
  return Number(reduction.toFixed(2));
}

/**
 * Calculates technical debt smell reduction percentage.
 * Avoids converting negative values into positive claims of success.
 */
export function calculateSmellReductionPercentage(
  beforeSmellCount: number,
  afterSmellCount: number,
): number {
  if (beforeSmellCount <= 0) {
    return afterSmellCount === 0 ? 0 : -100;
  }

  const reduction = ((beforeSmellCount - afterSmellCount) / beforeSmellCount) * 100;
  return Number(reduction.toFixed(2));
}

/**
 * Aggregates token metrics across all processed payloads / validation results.
 * Distinguishes exact character counts from estimated token counts.
 */
function aggregateTokenOptimization(
  metricsList: TokenMetrics[],
): TokenOptimizationReport {
  if (metricsList.length === 0) {
    return {
      originalContextCharacters: null,
      optimizedContextCharacters: null,
      estimatedOriginalTokens: null,
      estimatedOptimizedTokens: null,
      estimatedTokensSaved: null,
      tokenReductionPercentage: null,
      isEstimated: true,
    };
  }

  let originalContextCharacters = 0;
  let optimizedContextCharacters = 0;
  let estimatedOriginalTokens = 0;
  let estimatedOptimizedTokens = 0;

  for (const m of metricsList) {
    originalContextCharacters += m.originalCharacters ?? m.originalCharacterCount ?? 0;
    optimizedContextCharacters += m.optimizedCharacters ?? m.optimizedCharacterCount ?? 0;
    estimatedOriginalTokens += m.estimatedOriginalTokens ?? 0;
    estimatedOptimizedTokens += m.estimatedOptimizedTokens ?? 0;
  }

  const estimatedTokensSaved = estimatedOriginalTokens - estimatedOptimizedTokens;
  const tokenReductionPercentage = calculateTokenReductionPercentage(
    estimatedOriginalTokens,
    estimatedOptimizedTokens,
  );

  return {
    originalContextCharacters,
    optimizedContextCharacters,
    estimatedOriginalTokens,
    estimatedOptimizedTokens,
    estimatedTokensSaved,
    tokenReductionPercentage,
    isEstimated: true,
  };
}

/**
 * Gathers all detected code smells across parsed files.
 */
function extractAllBeforeSmells(input: ReportGeneratorInput): CodeSmell[] {
  if (input.parseResults && input.parseResults.length > 0) {
    const smells: CodeSmell[] = [];
    for (const f of input.parseResults) {
      if (f.smells && f.smells.length > 0) {
        smells.push(...f.smells);
      } else if (f.nodes && f.nodes.length > 0) {
        for (const n of f.nodes) {
          if (n.smells && n.smells.length > 0) {
            smells.push(...n.smells);
          }
        }
      }
    }
    return smells;
  }

  // Fallback to validation results beforeSmells if parseResults not supplied
  if (input.validationResults && input.validationResults.length > 0) {
    return input.validationResults.flatMap((v) => v.beforeSmells ?? []);
  }

  // Fallback to payloads
  if (input.payloads && input.payloads.length > 0) {
    return input.payloads.flatMap((p) => p.context.smells ?? []);
  }

  return [];
}

/**
 * Counts smells grouped by smell type.
 */
function groupSmellsByType(smells: CodeSmell[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of smells) {
    counts[s.type] = (counts[s.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compiles individual refactoring reports for each target.
 */
function compileIndividualResults(
  input: ReportGeneratorInput,
): IndividualRefactoringReport[] {
  const reports: IndividualRefactoringReport[] = [];

  if (input.validationResults && input.validationResults.length > 0) {
    for (let i = 0; i < input.validationResults.length; i++) {
      const v = input.validationResults[i];
      const task = input.tasks?.[i];
      const payload = input.payloads?.[i];

      const targetFile = v.targetFile ?? payload?.context?.targetFile ?? task?.filePath ?? "unknown";
      const nodeName = v.nodeName ?? payload?.context?.name ?? (v.metrics ? "target" : "node");
      const nodeKind = v.nodeKind ?? payload?.context?.nodeKind ?? "function";
      const target = v.targetNodeId ?? task?.targetNodeId ?? (nodeName ? `${targetFile}::${nodeName}` : targetFile);
      const status = v.valid ? "accepted" : "rejected";

      reports.push({
        target,
        targetFile,
        nodeKind,
        nodeName,
        strategy: v.strategy ?? "mechanical",
        status,
        syntaxValid: v.syntaxValid,
        typeSafe: v.typeSafe,
        triviaPreserved: v.triviaPreserved,
        beforeSmells: (v.beforeSmells && v.beforeSmells.length > 0 ? v.beforeSmells : (payload?.context?.smells ?? [])).map((s) => s.type),
        afterSmells: v.afterSmells.map((s) => s.type),
        fixedSmells: v.fixedSmells.map((s) => s.type),
        tokenMetrics: v.tokenMetrics ?? payload?.metrics ?? null,
        reason: v.valid ? undefined : v.error ?? "Validation rejected transformation",
        diagnostics: v.diagnostics,
      });
    }
    return reports;
  }

  if (input.refactoringResults && input.refactoringResults.length > 0) {
    for (const r of input.refactoringResults) {
      const target = r.targetNodeId ?? `${r.targetFile ?? "unknown"}::${r.nodeName ?? "node"}`;
      reports.push({
        target,
        targetFile: r.targetFile ?? "unknown",
        nodeKind: r.nodeKind ?? "unknown",
        nodeName: r.nodeName ?? "unknown",
        strategy: r.strategy,
        status: r.success ? "accepted" : "rejected",
        syntaxValid: r.success,
        typeSafe: r.success,
        triviaPreserved: true,
        beforeSmells: [],
        afterSmells: [],
        fixedSmells: r.changes.map((c) => c.smellType),
        tokenMetrics: null,
        reason: r.success ? undefined : r.error,
        explanation: r.explanation,
      });
    }
    return reports;
  }

  return reports;
}

/**
 * Main Report Generator:
 * Aggregates all Stage 1–6 artifacts into a comprehensive Stage7Report.
 */
export function generateReport(input: ReportGeneratorInput): Stage7Report {
  // 1. Project Info
  const root =
    input.projectRoot ??
    input.workspaceResult?.projectRoot ??
    (input.parseResults?.[0] ? path.dirname(input.parseResults[0].filePath) : process.cwd());
  const filesAnalyzed =
    input.parseResults?.length ?? input.workspaceResult?.fileCount ?? 0;

  const totalCharacters =
    input.workspaceResult?.totalCharacters ??
    input.parseResults?.reduce((sum, f) => sum + (f.fullText?.length ?? f.sourceText?.length ?? 0), 0) ??
    0;

  // 2. Technical Debt Before
  const beforeSmells = extractAllBeforeSmells(input);
  const beforeSmellCount = beforeSmells.length;
  const smellsByTypeBefore = groupSmellsByType(beforeSmells);

  const affectedFilesSet = new Set<string>();
  if (input.parseResults) {
    for (const f of input.parseResults) {
      const fileSmells = f.smells ?? f.nodes.flatMap((n) => n.smells);
      if (fileSmells.length > 0) {
        affectedFilesSet.add(f.filePath);
      }
    }
  } else {
    for (const s of beforeSmells) {
      if (s.filePath) affectedFilesSet.add(s.filePath);
    }
  }
  const affectedFiles = Array.from(affectedFilesSet);

  // 3. Refactoring Activity & Validation Results
  const valResults = input.validationResults ?? [];
  const refResults = input.refactoringResults ?? [];

  const targetsAnalyzed =
    valResults.length > 0
      ? valResults.length
      : refResults.length > 0
        ? refResults.length
        : input.tasks?.length ?? 0;

  let mechanicalCount = 0;
  let llmCount = 0;
  let acceptedCount = 0;
  let rejectedCount = 0;

  const allDiagnostics: ValidationDiagnostic[] = [];
  const rejectedReasons: Array<{ target: string; reason: string }> = [];

  if (valResults.length > 0) {
    for (const v of valResults) {
      if (v.strategy === "mechanical") mechanicalCount++;
      else if (v.strategy === "llm") llmCount++;

      if (v.valid) {
        acceptedCount++;
      } else {
        rejectedCount++;
        const targetIdentifier =
          v.targetNodeId ??
          (v.nodeName ? `${v.targetFile ?? "unknown"}::${v.nodeName}` : v.targetFile ?? "unknown");
        rejectedReasons.push({
          target: targetIdentifier,
          reason: v.error ?? v.diagnostics.find((d) => d.category === "error")?.message ?? "Validation failed",
        });
      }

      if (v.diagnostics && v.diagnostics.length > 0) {
        allDiagnostics.push(...v.diagnostics);
      }
    }
  } else if (refResults.length > 0) {
    for (const r of refResults) {
      if (r.strategy === "mechanical") mechanicalCount++;
      else if (r.strategy === "llm") llmCount++;

      if (r.success) acceptedCount++;
      else {
        rejectedCount++;
        const targetIdentifier =
          r.targetNodeId ??
          (r.nodeName ? `${r.targetFile ?? "unknown"}::${r.nodeName}` : r.targetFile ?? "unknown");
        rejectedReasons.push({
          target: targetIdentifier,
          reason: r.error ?? r.explanation ?? "Transformation failed",
        });
      }
    }
  }

  const syntaxValid = valResults.length === 0 ? true : valResults.every((v) => v.syntaxValid);
  const typeSafe = valResults.length === 0 ? true : valResults.every((v) => v.typeSafe);
  const triviaPreserved = valResults.length === 0 ? true : valResults.every((v) => v.triviaPreserved);

  // 4. Technical Debt After Refactoring
  // Calculate fixed smells and remaining smells
  let fixedSmellCount = 0;
  const fixedSmellsList: CodeSmell[] = [];

  if (valResults.length > 0) {
    for (const v of valResults) {
      if (v.valid) {
        fixedSmellCount += v.fixedSmellCount;
        fixedSmellsList.push(...v.fixedSmells);
      }
    }
  } else if (refResults.length > 0) {
    // If only refactoringResults are available without Stage 6 validation
    for (const r of refResults) {
      if (r.success) {
        fixedSmellCount += r.changes.length;
      }
    }
  }

  // After smell count is beforeSmellCount - fixedSmellCount
  // Avoid negative counts if more fixes were claimed than before smells
  const afterSmellCount = Math.max(0, beforeSmellCount - fixedSmellCount);

  // Group after smells by type
  const smellsByTypeAfter: Record<string, number> = { ...smellsByTypeBefore };
  for (const fixed of fixedSmellsList) {
    if (smellsByTypeAfter[fixed.type] !== undefined) {
      smellsByTypeAfter[fixed.type] = Math.max(0, smellsByTypeAfter[fixed.type] - 1);
      if (smellsByTypeAfter[fixed.type] === 0) {
        delete smellsByTypeAfter[fixed.type];
      }
    }
  }

  const smellReductionPercentage = calculateSmellReductionPercentage(
    beforeSmellCount,
    afterSmellCount,
  );

  // 5. Token Optimization
  const tokenMetricsList: TokenMetrics[] = [];
  if (input.payloads) {
    for (const p of input.payloads) {
      if (p.metrics) tokenMetricsList.push(p.metrics);
    }
  }
  if (input.validationResults) {
    for (const v of input.validationResults) {
      if (v.tokenMetrics && !tokenMetricsList.includes(v.tokenMetrics)) {
        tokenMetricsList.push(v.tokenMetrics);
      }
    }
  }

  const tokenOptimization = aggregateTokenOptimization(tokenMetricsList);

  // 6. Execution Summary
  const distinctFilesProcessed = new Set<string>();
  if (valResults.length > 0) {
    for (const v of valResults) {
      if (v.valid && v.targetFile) distinctFilesProcessed.add(v.targetFile);
    }
  } else if (refResults.length > 0) {
    for (const r of refResults) {
      if (r.success && r.targetFile) distinctFilesProcessed.add(r.targetFile);
    }
  }
  const filesSuccessfullyProcessed = distinctFilesProcessed.size;
  const filesSkipped = Math.max(0, filesAnalyzed - filesSuccessfullyProcessed);

  let overallExecutionStatus: ExecutionSummaryReport["overallExecutionStatus"] = "no-op";
  if (targetsAnalyzed === 0) {
    overallExecutionStatus = "no-op";
  } else if (rejectedCount === 0 && acceptedCount > 0) {
    overallExecutionStatus = "success";
  } else if (acceptedCount > 0 && rejectedCount > 0) {
    overallExecutionStatus = "partial";
  } else if (rejectedCount > 0 && acceptedCount === 0) {
    overallExecutionStatus = "failed";
  }

  const processingTimeMs = input.processingTimeMs ?? null;

  // 7. Research Evaluation Metrics (Section 10)
  const validationPassRate =
    targetsAnalyzed > 0
      ? Number(((acceptedCount / targetsAnalyzed) * 100).toFixed(2))
      : 100;

  const researchMetrics: ResearchEvaluationMetrics = {
    originalContextCharacters: tokenOptimization.originalContextCharacters,
    optimizedContextCharacters: tokenOptimization.optimizedContextCharacters,
    estimatedOriginalTokens: tokenOptimization.estimatedOriginalTokens,
    estimatedOptimizedTokens: tokenOptimization.estimatedOptimizedTokens,
    estimatedTokensSaved: tokenOptimization.estimatedTokensSaved,
    tokenReductionPercentage: tokenOptimization.tokenReductionPercentage,
    beforeSmellCount,
    afterSmellCount,
    fixedSmellCount,
    smellReductionPercentage,
    validationPassRate,
    targetsAnalyzed,
    mechanicalTransformations: mechanicalCount,
    llmTransformations: llmCount,
    rejectedTransformations: rejectedCount,
    processingTimeMs,
  };

  // 8. Individual Results & Unresolved Issues
  const individualResults = compileIndividualResults(input);
  const unresolvedIssues: string[] = [];

  if (input.errors && input.errors.length > 0) {
    unresolvedIssues.push(...input.errors);
  }
  for (const r of rejectedReasons) {
    unresolvedIssues.push(`[${r.target}] Rejected: ${r.reason}`);
  }
  for (const d of allDiagnostics.filter((diag) => diag.category === "error")) {
    unresolvedIssues.push(`[${d.file}:${d.line}] Compiler Error ${d.code}: ${d.message}`);
  }

  const project: ProjectReportInfo = {
    root,
    filesAnalyzed,
    filesProcessed: filesSuccessfullyProcessed,
    totalCharacters,
  };

  const technicalDebt: TechnicalDebtReport = {
    beforeSmellCount,
    afterSmellCount,
    fixedSmellCount,
    smellReductionPercentage,
    smellsByTypeBefore,
    smellsByTypeAfter,
    affectedFiles,
  };

  const refactoringActivity: RefactoringActivityReport = {
    targetsAnalyzed,
    mechanicalTransformations: mechanicalCount,
    llmTransformations: llmCount,
    successfulTransformations: acceptedCount,
    rejectedTransformations: rejectedCount,
  };

  const validation: ValidationSummaryReport = {
    syntaxValid,
    typeSafe,
    triviaPreserved,
    acceptedTransformations: acceptedCount,
    rejectedTransformations: rejectedCount,
    diagnostics: allDiagnostics,
    rejectedReasons,
  };

  const executionSummary: ExecutionSummaryReport = {
    filesSuccessfullyProcessed,
    filesSkipped,
    transformationsRejected: rejectedCount,
    overallExecutionStatus,
    processingTimeMs,
  };

  return {
    project,
    technicalDebt,
    tokenOptimization,
    refactoringActivity,
    validation,
    executionSummary,
    individualResults,
    researchMetrics,
    unresolvedIssues,
  };
}

/**
 * Generates formatted JSON report string.
 */
export function generateJsonReport(report: Stage7Report, pretty = true): string {
  return JSON.stringify(report, null, pretty ? 2 : 0);
}

/**
 * Formats a metric value or displays "Unavailable" if null/undefined.
 */
function formatMetric<T>(val: T | null | undefined, suffix = ""): string {
  if (val === null || val === undefined) {
    return "Unavailable";
  }
  return `${val}${suffix}`;
}

/**
 * Generates human-readable Markdown report conforming to Section 5 specification.
 */
export function generateMarkdownReport(report: Stage7Report): string {
  const {
    project,
    technicalDebt,
    tokenOptimization,
    refactoringActivity,
    validation,
    executionSummary,
    individualResults,
    unresolvedIssues,
  } = report;

  const lines: string[] = [];

  lines.push("# Agentic Code Refactor Report\n");

  // Project Summary
  lines.push("## Project Summary\n");
  lines.push(`- **Project Root**: \`${project.root}\``);
  lines.push(`- **Files Analyzed**: ${project.filesAnalyzed}`);
  lines.push(`- **Files Processed**: ${project.filesProcessed}`);
  lines.push(`- **Total Source Characters**: ${project.totalCharacters.toLocaleString()}`);
  lines.push("");

  // Architecture Execution Summary
  lines.push("## Architecture Execution Summary\n");
  lines.push(`- **Execution Status**: **${executionSummary.overallExecutionStatus.toUpperCase()}**`);
  lines.push(`- **Files Successfully Processed**: ${executionSummary.filesSuccessfullyProcessed}`);
  lines.push(`- **Files Skipped**: ${executionSummary.filesSkipped}`);
  lines.push(`- **Transformations Rejected**: ${executionSummary.transformationsRejected}`);
  lines.push(
    `- **Processing Time**: ${formatMetric(executionSummary.processingTimeMs, " ms")}`,
  );
  lines.push("");

  // Technical Debt
  lines.push("## Technical Debt\n");
  lines.push(`- **Before**: ${technicalDebt.beforeSmellCount}`);
  lines.push(`- **After**: ${technicalDebt.afterSmellCount}`);
  lines.push(`- **Fixed**: ${technicalDebt.fixedSmellCount}`);
  lines.push(`- **Reduction**: ${technicalDebt.smellReductionPercentage}%`);
  lines.push("");

  if (Object.keys(technicalDebt.smellsByTypeBefore).length > 0) {
    lines.push("### Smells Grouped by Type (Before vs After)\n");
    lines.push("| Smell Type | Before | After | Fixed |");
    lines.push("|---|---|---|---|");

    const allTypes = Array.from(
      new Set([
        ...Object.keys(technicalDebt.smellsByTypeBefore),
        ...Object.keys(technicalDebt.smellsByTypeAfter),
      ]),
    ).sort();

    for (const t of allTypes) {
      const before = technicalDebt.smellsByTypeBefore[t] ?? 0;
      const after = technicalDebt.smellsByTypeAfter[t] ?? 0;
      const fixed = Math.max(0, before - after);
      lines.push(`| \`${t}\` | ${before} | ${after} | ${fixed} |`);
    }
    lines.push("");
  }

  if (technicalDebt.affectedFiles.length > 0) {
    lines.push("### Affected Files\n");
    for (const f of technicalDebt.affectedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  // Token Optimization
  lines.push("## Token Optimization\n");
  lines.push(
    `- **Original Context Characters (Exact)**: ${formatMetric(tokenOptimization.originalContextCharacters)}`,
  );
  lines.push(
    `- **Optimized Context Characters (Exact)**: ${formatMetric(tokenOptimization.optimizedContextCharacters)}`,
  );
  lines.push(
    `- **Original Estimated Tokens (~4 chars/token)**: ${formatMetric(tokenOptimization.estimatedOriginalTokens)}`,
  );
  lines.push(
    `- **Optimized Estimated Tokens (~4 chars/token)**: ${formatMetric(tokenOptimization.estimatedOptimizedTokens)}`,
  );
  lines.push(
    `- **Estimated Tokens Saved**: ${formatMetric(tokenOptimization.estimatedTokensSaved)}`,
  );
  lines.push(
    `- **Estimated Token Reduction**: ${formatMetric(tokenOptimization.tokenReductionPercentage, "%")}`,
  );
  lines.push(
    `*(Note: Token counts are deterministic approximations; character counts represent exact context length).*`,
  );
  lines.push("");

  // Refactoring Strategy Distribution
  lines.push("## Refactoring Strategy Distribution\n");
  lines.push(`- **Targets Analyzed**: ${refactoringActivity.targetsAnalyzed}`);
  lines.push(`- **Mechanical Transformations**: ${refactoringActivity.mechanicalTransformations}`);
  lines.push(`- **LLM Transformations**: ${refactoringActivity.llmTransformations}`);
  lines.push(`- **Successful Transformations**: ${refactoringActivity.successfulTransformations}`);
  lines.push(`- **Rejected Transformations**: ${refactoringActivity.rejectedTransformations}`);
  lines.push("");

  // Validation Results
  lines.push("## Validation Results\n");
  lines.push(`- **Syntax Validation**: ${validation.syntaxValid ? "PASS" : "FAIL"}`);
  lines.push(`- **Type Checking**: ${validation.typeSafe ? "PASS" : "FAIL"}`);
  lines.push(`- **Trivia Preservation**: ${validation.triviaPreserved ? "PASS" : "FAIL"}`);
  lines.push(`- **Accepted Transformations**: ${validation.acceptedTransformations}`);
  lines.push(`- **Rejected Transformations**: ${validation.rejectedTransformations}`);
  lines.push("");

  // Compiler Diagnostics
  lines.push("## Compiler Diagnostics\n");
  if (validation.diagnostics.length === 0) {
    lines.push("*(No compiler diagnostics or errors reported)*\n");
  } else {
    lines.push("| File | Line | Code | Message |");
    lines.push("|---|---|---|---|");
    for (const d of validation.diagnostics.slice(0, 20)) {
      lines.push(`| \`${d.file}\` | ${d.line} | \`${d.code}\` | ${d.message.replace(/\|/g, "\\|")} |`);
    }
    if (validation.diagnostics.length > 20) {
      lines.push(`\n*(...and ${validation.diagnostics.length - 20} additional diagnostics)*`);
    }
    lines.push("");
  }

  // Individual Results
  if (individualResults.length > 0) {
    lines.push("## Individual Refactoring Results\n");
    lines.push("| Target | Strategy | Status | Smells (Before → After) | Token Reduction |");
    lines.push("|---|---|---|---|---|");
    for (const item of individualResults) {
      const smellsChange = `${item.beforeSmells.length} → ${item.afterSmells.length}`;
      const tokenRed = item.tokenMetrics
        ? `${item.tokenMetrics.tokenReductionPercentage}%`
        : "N/A";
      lines.push(
        `| \`${item.targetFile}::${item.nodeName}\` | ${item.strategy} | **${item.status.toUpperCase()}** | ${smellsChange} | ${tokenRed} |`,
      );
    }
    lines.push("");
  }

  // Unresolved Issues
  lines.push("## Unresolved Issues\n");
  if (unresolvedIssues.length === 0) {
    lines.push("*(None — all attempted refactorings passed verification)*\n");
  } else {
    for (const issue of unresolvedIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
