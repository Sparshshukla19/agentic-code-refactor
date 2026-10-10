/**
 * Main pipeline orchestrator connecting all sub-engines:
 * parser -> planner -> agent -> sandbox -> vcs.
 *
 * Status: skeleton — implementation pending.
 */
// Stage 1: Workspace Ingestion
export {
  ingestWorkspace,
  ingestWorkspaceSync,
  WorkspaceIngestionError,
} from "./parser/workspace.js";
export type {
  WorkspaceFile,
  WorkspaceResult,
  WorkspaceIngestOptions,
} from "./types/workspace.types.js";

// Stage 2: AST Parser & Smell Detection
export {
  analyzeWorkspace,
  parseSourceFile,
  parseFiles,
  createProject,
  loadSourceFiles,
  extractImports,
  extractExports,
} from "./parser/astEngine.js";
export type {
  AstEngineOptions,
  CodeSmell,
  CodeSmellType,
  ExportInfo,
  FileParseResult,
  ImportInfo,
  NodeKind,
  ParsedNode,
} from "./types/ast.types.js";

// Stage 3: Dependency Graph & Topological Sorter
export {
  buildDependencyGraph,
  topologicalSort,
  createDependencyGraph,
  resolveImportSpecifier,
  normalizePath,
  CircularDependencyError,
} from "./planner/dependencyGraph.js";
export type {
  DependencyEdge,
  DependencyGraph,
  GraphNode,
  RefactoringQueue,
  QueuedTask,
} from "./types/graph.types.js";

// Stage 4: Node Slicing, Trivia Preservation & Token Optimization
export {
  buildOptimizedPayload,
  buildContextSlice,
  buildRefactorObjective,
  generateInstruction,
  estimateTokens,
  estimateTokenSavings,
  aggregateTokenSavings,
  calculateTokenMetrics,
  formatExperimentComparison,
  DeterministicTokenEstimator,
} from "./planner/contextSlicer.js";
export {
  findSmallestEnclosingNode,
  selectTargetNode,
  sliceNode,
  extractNodeFromParsedNode,
  extractDependencySignatures,
  formatLightweightSignature,
  extractRelevantImports,
} from "./parser/nodeExtractor.js";
export {
  extractTrivia,
  extractTriviaFromText,
  reconcileTrivia,
} from "./parser/triviaPreserver.js";
export type {
  TriviaMetadata,
  DependencySignature,
  RefactoringContext,
  TokenMetrics,
  OptimizedPayload,
  SlicedTarget,
  SlicerOptions,
  BuildOptimizedPayloadParams,
} from "./types/slicer.types.js";

// Stage 5: Hybrid Transformation & Refactoring Agent
export {
  routeAndRefactor,
  determineRefactoringStrategy,
  isSupportedSmell,
} from "./refactor/refactoringRouter.js";
export {
  applyMechanicalRefactoring,
  transformVarDeclarations,
  cleanupUnusedImports,
} from "./refactor/mechanicalRefactor.js";
export { generateStructuredRefactor } from "./agent/llmClient.js";
export type {
  RefactoringStrategy,
  RefactoringChange,
  RefactoringResult,
  LlmRefactorResponse,
  RefactorRouterOptions,
} from "./types/refactor.types.js";

// Stage 6: Validation, Trivia Reconciliation & Re-analysis
export {
  validateRefactoring,
  validateSyntax,
  validateTypes,
  reconcileTriviaWithAst,
  reconcileAst,
  reanalyzeSmells,
  calculateSmellMetrics,
  applyRefactoringInMemory,
} from "./validation/index.js";
export type {
  ValidationDiagnostic,
  SyntaxValidationResult,
  TypeValidationResult,
  TriviaReconciliationResult,
  AstReconciliationResult,
  SmellComparisonResult,
  ValidationMetrics,
  ValidationResearchMetrics,
  ValidationResult,
  ValidationOptions,
} from "./types/validation.types.js";

// Stage 7: Reporting, Dashboard & Artifact Output
export {
  generateReport,
  generateJsonReport,
  generateMarkdownReport,
  calculateSmellReductionPercentage,
  calculateTokenReductionPercentage,
} from "./reporting/reportGenerator.js";
export {
  writeArtifacts,
  assertSafeOutputPath,
  PathTraversalError,
  FileExistsError,
} from "./reporting/artifactWriter.js";
export {
  runRefactoringPipeline,
} from "./reporting/pipelineRunner.js";
export type {
  Stage7Report,
  ProjectReportInfo,
  TechnicalDebtReport,
  TokenOptimizationReport,
  RefactoringActivityReport,
  ValidationSummaryReport,
  ExecutionSummaryReport,
  IndividualRefactoringReport,
  ResearchEvaluationMetrics,
  ReportGeneratorOptions,
  ReportGeneratorInput,
} from "./types/report.types.js";
export type {
  ArtifactWriterOptions,
  ArtifactWriteResult,
  RefactoredFileEntry,
} from "./reporting/artifactWriter.js";
export type {
  PipelineOptions,
  PipelineExecutionResult,
} from "./reporting/pipelineRunner.js";

async function main(): Promise<void> {
  console.log("AutoRefactor AI pipeline — skeleton entrypoint.");
  // 1. parser: build AST + dependency graph for the target repo
  // 2. planner: derive topological task queue + context slices
  // 3. agent: generate patches via ReAct loop
  // 4. sandbox: verify (tsc -> eslint -> test), reflect + retry on failure
  // 5. vcs: commit verified patches, open PR
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
