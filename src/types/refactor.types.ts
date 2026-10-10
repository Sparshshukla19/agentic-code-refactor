/**
 * Types for Stage 5: Hybrid Transformation & Refactoring Agent.
 * Consumes Stage 4 OptimizedPayload and produces a validated RefactoringResult.
 */
import type { CodeSmell } from "./ast.types.js";
import type { OptimizedPayload } from "./slicer.types.js";

export type RefactoringStrategy = "mechanical" | "llm";

export interface RefactoringChange {
  smellType: string;
  description: string;
}

export interface RefactoringResult {
  success: boolean;
  strategy: RefactoringStrategy;
  originalCode: string;
  refactoredCode: string;
  explanation: string;
  changes: RefactoringChange[];
  targetFile?: string;
  targetNodeId?: string;
  nodeKind?: string;
  nodeName?: string;
  startLine?: number;
  endLine?: number;
  error?: string;
}

export interface LlmRefactorResponse {
  success: boolean;
  refactoredCode: string;
  explanation: string;
  changes: {
    type: string;
    description: string;
  }[];
}

export interface RefactorRouterOptions {
  forceStrategy?: RefactoringStrategy;
  mockLlmResponse?: LlmRefactorResponse;
  timeoutMs?: number;
  skipSyntaxValidation?: boolean;
}
