/**
 * Stage 6: Validation, Trivia Reconciliation & Re-analysis Module
 */
export {
  validateRefactoring,
  validateSyntax,
  validateTypes,
  reconcileTriviaWithAst,
  reconcileAst,
  reanalyzeSmells,
  calculateSmellMetrics,
  applyRefactoringInMemory,
} from "./validator.js";

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
} from "../types/validation.types.js";
