/**
 * Stage 7: Reporting, Dashboard & Artifact Output Types
 *
 * Combines outputs from Stages 1–6 into structured JSON/Markdown reports,
 * research metrics, and artifact outputs.
 */
import type { CodeSmell, FileParseResult } from "./ast.types.js";
import type { DependencyGraph, QueuedTask, RefactoringQueue } from "./graph.types.js";
import type { RefactoringResult, RefactoringStrategy } from "./refactor.types.js";
import type { OptimizedPayload, TokenMetrics } from "./slicer.types.js";
import type { ValidationDiagnostic, ValidationResult } from "./validation.types.js";
import type { WorkspaceResult } from "./workspace.types.js";

export interface ProjectReportInfo {
  root: string;
  filesAnalyzed: number;
  filesProcessed: number;
  totalCharacters: number;
}

export interface TechnicalDebtReport {
  beforeSmellCount: number;
  afterSmellCount: number;
  fixedSmellCount: number;
  smellReductionPercentage: number;
  smellsByTypeBefore: Record<string, number>;
  smellsByTypeAfter: Record<string, number>;
  affectedFiles: string[];
}

export interface TokenOptimizationReport {
  originalContextCharacters: number | null;
  optimizedContextCharacters: number | null;
  estimatedOriginalTokens: number | null;
  estimatedOptimizedTokens: number | null;
  estimatedTokensSaved: number | null;
  tokenReductionPercentage: number | null;
  isEstimated: boolean;
}

export interface RefactoringActivityReport {
  targetsAnalyzed: number;
  mechanicalTransformations: number;
  llmTransformations: number;
  successfulTransformations: number;
  rejectedTransformations: number;
}

export interface ValidationSummaryReport {
  syntaxValid: boolean;
  typeSafe: boolean;
  triviaPreserved: boolean;
  acceptedTransformations: number;
  rejectedTransformations: number;
  diagnostics: ValidationDiagnostic[];
  rejectedReasons: Array<{ target: string; reason: string }>;
}

export interface ExecutionSummaryReport {
  filesSuccessfullyProcessed: number;
  filesSkipped: number;
  transformationsRejected: number;
  overallExecutionStatus: "success" | "partial" | "failed" | "no-op";
  processingTimeMs: number | null;
}

export interface IndividualRefactoringReport {
  target: string;
  targetFile: string;
  nodeKind: string;
  nodeName: string;
  strategy: RefactoringStrategy;
  status: "accepted" | "rejected" | "skipped";
  syntaxValid: boolean;
  typeSafe: boolean;
  triviaPreserved: boolean;
  beforeSmells: string[];
  afterSmells: string[];
  fixedSmells: string[];
  tokenMetrics: TokenMetrics | null;
  reason?: string;
  explanation?: string;
  diagnostics?: ValidationDiagnostic[];
}

export interface ResearchEvaluationMetrics {
  originalContextCharacters: number | null;
  optimizedContextCharacters: number | null;
  estimatedOriginalTokens: number | null;
  estimatedOptimizedTokens: number | null;
  estimatedTokensSaved: number | null;
  tokenReductionPercentage: number | null;
  beforeSmellCount: number;
  afterSmellCount: number;
  fixedSmellCount: number;
  smellReductionPercentage: number;
  validationPassRate: number;
  targetsAnalyzed: number;
  mechanicalTransformations: number;
  llmTransformations: number;
  rejectedTransformations: number;
  processingTimeMs: number | null;
}

export interface Stage7Report {
  project: ProjectReportInfo;
  technicalDebt: TechnicalDebtReport;
  tokenOptimization: TokenOptimizationReport;
  refactoringActivity: RefactoringActivityReport;
  validation: ValidationSummaryReport;
  executionSummary: ExecutionSummaryReport;
  individualResults: IndividualRefactoringReport[];
  researchMetrics: ResearchEvaluationMetrics;
  unresolvedIssues: string[];
}

export interface ReportGeneratorOptions {
  projectName?: string;
  processingTimeMs?: number;
}

export interface ReportGeneratorInput {
  projectRoot?: string;
  workspaceResult?: WorkspaceResult;
  parseResults?: FileParseResult[];
  graph?: DependencyGraph;
  queue?: RefactoringQueue;
  tasks?: QueuedTask[];
  payloads?: OptimizedPayload[];
  refactoringResults?: RefactoringResult[];
  validationResults?: ValidationResult[];
  processingTimeMs?: number;
  errors?: string[];
  options?: ReportGeneratorOptions;
}
