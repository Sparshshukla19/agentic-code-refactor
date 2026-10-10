/**
 * Stage 7: Pipeline Runner & Orchestration Integration
 *
 * Executes Stages 1 through 6 sequentially, connecting actual outputs
 * into Stage 7 reporting and artifact generation.
 */
import path from "node:path";
import { ingestWorkspace } from "../parser/workspace.js";
import { analyzeWorkspace } from "../parser/astEngine.js";
import { buildDependencyGraph, topologicalSort } from "../planner/dependencyGraph.js";
import { scheduleTasks } from "../planner/taskScheduler.js";
import { buildOptimizedPayload } from "../planner/contextSlicer.js";
import { routeAndRefactor, determineRefactoringStrategy } from "../refactor/refactoringRouter.js";
import { validateRefactoring, applyRefactoringInMemory } from "../validation/index.js";
import { generateReport } from "./reportGenerator.js";
import { writeArtifacts, type ArtifactWriteResult, type RefactoredFileEntry } from "./artifactWriter.js";
import type { WorkspaceResult } from "../types/workspace.types.js";
import type { FileParseResult } from "../types/ast.types.js";
import type { DependencyGraph, QueuedTask, RefactoringQueue } from "../types/graph.types.js";
import type { OptimizedPayload } from "../types/slicer.types.js";
import type { LlmRefactorResponse, RefactoringResult } from "../types/refactor.types.js";
import type { ValidationResult } from "../types/validation.types.js";
import type { Stage7Report } from "../types/report.types.js";

export interface PipelineOptions {
  projectRoot?: string;
  includeJs?: boolean;
  mechanicalOnly?: boolean;
  outputDir?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  writeArtifacts?: boolean;
  skipLlmWithoutKey?: boolean;
  mockLlmResponse?: LlmRefactorResponse;
}

export interface PipelineExecutionResult {
  workspace: WorkspaceResult;
  parseResults: FileParseResult[];
  graph: DependencyGraph;
  queue: RefactoringQueue;
  tasks: QueuedTask[];
  payloads: OptimizedPayload[];
  refactorResults: RefactoringResult[];
  validationResults: ValidationResult[];
  report: Stage7Report;
  artifactResult?: ArtifactWriteResult;
  processingTimeMs: number;
}

/**
 * Executes the complete refactoring and reporting pipeline on a workspace.
 */
export async function runRefactoringPipeline(
  optionsOrRoot: string | PipelineOptions = "./test-target",
): Promise<PipelineExecutionResult> {
  const options: PipelineOptions =
    typeof optionsOrRoot === "string" ? { projectRoot: optionsOrRoot } : optionsOrRoot;

  const projectRoot = path.resolve(process.cwd(), options.projectRoot ?? "./test-target");
  const startTime = Date.now();

  // Stage 1: Workspace Ingestion
  const workspace = await ingestWorkspace(projectRoot, {
    includeJs: options.includeJs ?? true,
  });

  // Stage 2: AST Analysis
  const parseResults = analyzeWorkspace(workspace);

  // Stage 3: Dependency Graph & Task Scheduling
  const graph = buildDependencyGraph(parseResults);
  const queue = topologicalSort(graph);
  const tasks = scheduleTasks(parseResults, graph);

  const payloads: OptimizedPayload[] = [];
  const refactorResults: RefactoringResult[] = [];
  const validationResults: ValidationResult[] = [];

  const currentFileContents = new Map<string, string>();
  for (const f of parseResults) {
    currentFileContents.set(f.filePath, f.fullText ?? f.sourceText ?? "");
  }

  const acceptedModifiedFiles = new Map<string, string>();
  const rejectedFiles = new Set<string>();

  // Stages 4, 5, 6: Sequential Execution in Topological Order
  for (const task of tasks) {
    const file = parseResults.find((f) => path.resolve(f.filePath) === path.resolve(task.filePath));
    if (!file) continue;

    const targetNode = file.nodes.find((n) => n.id === task.targetNodeId);
    if (!targetNode) continue;

    const strategy = determineRefactoringStrategy(targetNode.smells);

    const hasMechanicalSmell = targetNode.smells.some((s) => s.type === "var-usage");
    if (options.mechanicalOnly && !hasMechanicalSmell) {
      continue;
    }

    // Stage 4: Token Optimization & Slicing
    const payload = buildOptimizedPayload({
      task,
      targetNode,
      file,
      fileResults: parseResults,
      graph,
      smells: targetNode.smells,
    });
    payloads.push(payload);

    // Stage 5: Hybrid Transformation
    const refactorResult = await routeAndRefactor(payload, {
      forceStrategy: options.mechanicalOnly ? "mechanical" : undefined,
      mockLlmResponse: options.mockLlmResponse,
    });
    refactorResults.push(refactorResult);

    // Stage 6: In-Memory Multi-Pass Validation
    const currentFullContent = currentFileContents.get(file.filePath) ?? file.fullText;
    const validation = await validateRefactoring(payload, refactorResult, workspace, {
      fullFileContent: currentFullContent,
      targetFile: file.filePath,
    });
    validationResults.push(validation);

    if (validation.valid) {
      // Apply accepted in-memory transformation
      const updatedContent = applyRefactoringInMemory(
        currentFullContent,
        validation.originalCode,
        validation.refactoredCode,
      );
      currentFileContents.set(file.filePath, updatedContent);
      acceptedModifiedFiles.set(file.filePath, updatedContent);
    } else {
      // Transformation was rejected
      rejectedFiles.add(file.filePath);
    }
  }

  const processingTimeMs = Date.now() - startTime;

  // Stage 7: Generate Report
  const report = generateReport({
    workspaceResult: workspace,
    parseResults,
    graph,
    queue,
    tasks,
    payloads,
    refactoringResults: refactorResults,
    validationResults,
    processingTimeMs,
  });

  // Prepare refactored file entries: ONLY validated, accepted transformations
  let artifactResult: ArtifactWriteResult | undefined;
  if (options.writeArtifacts !== false) {
    const fileEntries: RefactoredFileEntry[] = [];
    for (const [filePath, content] of acceptedModifiedFiles.entries()) {
      fileEntries.push({ filePath, content, valid: true });
    }
    // Rejected files marked valid: false so artifactWriter explicitly skips them
    for (const filePath of rejectedFiles) {
      if (!acceptedModifiedFiles.has(filePath)) {
        fileEntries.push({
          filePath,
          content: currentFileContents.get(filePath) ?? "",
          valid: false,
        });
      }
    }

    artifactResult = await writeArtifacts(report, fileEntries, {
      outputDir: options.outputDir ?? "artifacts",
      overwrite: options.overwrite ?? false,
      dryRun: options.dryRun ?? false,
      projectRoot,
      originalSourceFiles: workspace.files.map((f) => f.absolutePath),
    });
  }

  return {
    workspace,
    parseResults,
    graph,
    queue,
    tasks,
    payloads,
    refactorResults,
    validationResults,
    report,
    artifactResult,
    processingTimeMs,
  };
}
