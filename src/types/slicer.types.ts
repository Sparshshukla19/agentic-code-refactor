/**
 * Stage 4: Node Slicing, Trivia Preservation & Token Optimization Types
 */
import type { CodeSmell, FileParseResult, ParsedNode } from "./ast.types.js";
import type { QueuedTask, DependencyGraph } from "./graph.types.js";

export interface TriviaMetadata {
  leadingComments: string[];
  trailingComments: string[];
  jsDoc: string[];
  inlineComments?: string[];
}

export interface DependencySignature {
  filePath: string;
  signatures: string[];
}

export interface RefactoringContext {
  targetCode: string;
  targetFile: string;
  nodeKind: string;
  name?: string;
  startLine: number;
  endLine: number;
  startChar?: number;
  endChar?: number;
  smells: CodeSmell[];
  trivia: TriviaMetadata;
  dependencies: DependencySignature[];
  imports: string[];
  types?: string[];
  promptContext?: string;
}

export interface TokenMetrics {
  originalCharacters: number;
  optimizedCharacters: number;
  originalCharacterCount?: number;
  optimizedCharacterCount?: number;
  estimatedOriginalTokens: number;
  estimatedOptimizedTokens: number;
  estimatedTokenSavings: number;
  tokenReductionPercentage: number;
  dependencyFilesCount?: number;
  sourceLinesCount?: number;
}

export interface OptimizedPayload {
  context: RefactoringContext;
  metrics: TokenMetrics;
}

export interface SlicedTarget {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  sourceText: string;
}

export interface SlicerOptions {
  tokenizerRatio?: number; // default: 4 characters per token
  maxReferencedSiblings?: number;
  includeTriviaInMetrics?: boolean;
}

export interface BuildOptimizedPayloadParams {
  task?: QueuedTask;
  targetNode?: ParsedNode | SlicedTarget;
  file?: FileParseResult;
  fileResults?: FileParseResult[];
  graph?: DependencyGraph;
  dependencyFiles?: FileParseResult[];
  smells?: CodeSmell[];
  options?: SlicerOptions;
}
