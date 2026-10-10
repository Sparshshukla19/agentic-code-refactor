/**
 * Types for Stage 6: Validation, Trivia Reconciliation & Re-analysis.
 * Consumes Stage 5 RefactoringResult and produces a verified, type-safe ValidationResult.
 */
import type { CodeSmell, AstEngineOptions } from "./ast.types.js";
import type { RefactoringResult, RefactoringStrategy } from "./refactor.types.js";
import type { TokenMetrics, TriviaMetadata, OptimizedPayload, DependencySignature } from "./slicer.types.js";
import type { WorkspaceResult } from "./workspace.types.js";
import type { Project } from "ts-morph";

export interface ValidationDiagnostic {
  file: string;
  filePath?: string; // compatibility alias
  line: number;
  column: number;
  code: string | number;
  message: string;
  category?: "error" | "warning" | "suggestion" | "message";
}

export interface SyntaxValidationResult {
  syntaxValid: boolean;
  diagnostics: ValidationDiagnostic[];
  error?: string;
}

export interface TypeValidationResult {
  typeSafe: boolean;
  diagnostics: ValidationDiagnostic[];
  error?: string;
}

export interface TriviaReconciliationResult {
  triviaPreserved: boolean;
  reconciledCode: string;
  missingTriviaCount: number;
  preservedTriviaCount: number;
}

export interface AstReconciliationResult {
  astReconciled: boolean;
  targetStillExists: boolean;
  exportedApisPreserved: boolean;
  unrelatedNodesUnmodified: boolean;
  reason?: string;
}

export interface SmellComparisonResult {
  beforeSmells: CodeSmell[];
  afterSmells: CodeSmell[];
  fixedSmells: CodeSmell[];
  remainingSmells: CodeSmell[];
  newSmells: CodeSmell[];
  beforeSmellCount: number;
  afterSmellCount: number;
  fixedSmellCount: number;
  remainingSmellCount: number;
  smellReductionPercentage: number;
}

export interface ValidationMetrics {
  beforeSmellCount: number;
  afterSmellCount: number;
  fixedSmellCount: number;
  remainingSmellCount: number;
  smellReductionPercentage: number;
  syntaxErrorsCount: number;
  typeErrorsCount: number;
  tokenMetrics?: TokenMetrics;
}

export interface ValidationResearchMetrics {
  originalTechnicalDebt: number;
  finalTechnicalDebt: number;
  technicalDebtDelta: number;
  smellReductionPercentage: number;
  tokenReductionPercentage?: number;
  tokenSavings?: number;
  strategy: RefactoringStrategy;
  syntaxErrorsCount: number;
  compilerErrorsCount: number;
  validationPassed: boolean;
  reconciledTriviaCount: number;
}

export interface ValidationResult {
  valid: boolean;

  syntaxValid: boolean;
  typeSafe: boolean;
  triviaPreserved: boolean;
  astReconciled: boolean;

  diagnostics: ValidationDiagnostic[];

  beforeSmells: CodeSmell[];
  afterSmells: CodeSmell[];

  fixedSmells: CodeSmell[];
  remainingSmells: CodeSmell[];

  beforeSmellCount: number;
  afterSmellCount: number;
  fixedSmellCount: number;
  remainingSmellCount: number;

  smellReductionPercentage: number;

  refactoredCode: string;
  originalCode: string;

  strategy?: RefactoringStrategy;
  tokenMetrics?: TokenMetrics;
  targetFile?: string;
  nodeName?: string;
  nodeKind?: string;
  targetNodeId?: string;
  taskId?: string;
  error?: string;

  metrics?: ValidationMetrics;
  researchMetrics?: ValidationResearchMetrics;
}

export interface ValidationOptions {
  workspace?: WorkspaceResult | Project;
  targetFile?: string;
  trivia?: TriviaMetadata;
  astOptions?: AstEngineOptions;
  tokenMetrics?: TokenMetrics;
  fullFileContent?: string;
  requireSmellReduction?: boolean;
  requireTriviaPreserved?: boolean;
  strictTypeCheck?: boolean;
  nodeName?: string;
  nodeKind?: string;
  targetNodeId?: string;
  taskId?: string;
  dependencySignatures?: DependencySignature[];
  beforeSmells?: CodeSmell[];
  tsConfigFilePath?: string;
}
