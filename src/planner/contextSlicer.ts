/**
 * Extracts the minimal source context the agent needs for one refactor
 * task: the target node itself, plus same-file helpers it actually calls
 * (so the LLM isn't guessing at a dependency's signature), and a
 * plain-language instruction derived from the smells that were detected.
 * Deliberately excludes everything else in the file — token budget and
 * hallucination risk both grow with irrelevant context.
 *
 * This module also owns token-savings measurement: estimateTokenSavings()
 * for a single task, and aggregateTokenSavings() to roll many tasks up
 * into one run-level report (used by the CLI to print a summary at the
 * end of a refactor run).
 */
import type { CodeSmell, CodeSmellType, FileParseResult, ParsedNode } from "../types/ast.types.js";
import type { DependencyGraph, QueuedTask } from "../types/graph.types.js";
import type { RefactorObjective } from "../types/agent.types.js";
import type {
  BuildOptimizedPayloadParams,
  DependencySignature,
  OptimizedPayload,
  RefactoringContext,
  SlicedTarget,
  SlicerOptions,
  TokenMetrics,
  TriviaMetadata,
} from "../types/slicer.types.js";
import {
  extractDependencySignatures,
  extractRelevantImports,
} from "../parser/nodeExtractor.js";
import { normalizePath } from "./dependencyGraph.js";
import { extractTriviaFromText } from "../parser/triviaPreserver.js";

const MAX_REFERENCED_SIBLINGS = 5;
// A sibling this large or smaller gets included verbatim; above it, only its
// signature is sent. The agent almost always needs a helper's *interface* to
// type against — not its implementation — and bodies are where token cost hides.
const SIBLING_FULL_BODY_CHAR_LIMIT = 300;
const SIGNATURE_FALLBACK_CHAR_LIMIT = 80;

const SMELL_INSTRUCTIONS: Record<CodeSmellType, string> = {
  "untyped-signature": "Add explicit parameter and return types.",
  "missing-return-type": "Add an explicit return type annotation.",
  "callback-hell": "Convert nested callbacks into async/await with a single top-level try/catch.",
  "implicit-any": "Replace implicit `any` types with explicit, accurate types.",
  "any-usage": "Replace `any` types with specific, accurate types.",
  "var-usage": "Replace `var` declarations with `let` or `const` as appropriate.",
  "long-function": "Refactor this long function into smaller, well-scoped functions.",
  "deep-nesting": "Reduce deeply nested blocks using early returns or guard clauses.",
  "no-error-handling": "Add proper error handling (try/catch, or an error-first check) around the async logic.",
  "duplicate-logic": "Extract the duplicated logic into a single shared helper.",
  "high-complexity": "Break this function into smaller pieces to reduce branching complexity.",
};

/**
 * Tokenizer interface abstraction for token measurements and estimations.
 */
export interface Tokenizer {
  estimateTokens(text: string): number;
}

/**
 * Deterministic tokenizer approximation (~4 characters per token by default).
 * Clearly marked as an estimate to avoid false precision.
 */
export class DeterministicTokenEstimator implements Tokenizer {
  constructor(private charsPerToken: number = 4) {}

  estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }
}

const defaultEstimator = new DeterministicTokenEstimator(4);

/** Builds the plain-language refactor instruction from a node's detected smells. */
export function generateInstruction(node: { smells?: CodeSmell[] }): string {
  if (!node.smells || node.smells.length === 0) {
    return "Modernize this code without changing its behavior.";
  }
  // Dedupe: two smells can map to the same instruction (rare but possible),
  // and we don't want the LLM told the same thing twice.
  const uniqueInstructions = Array.from(new Set(node.smells.map((s) => SMELL_INSTRUCTIONS[s.type])));
  return uniqueInstructions.join(" ");
}

/**
 * Finds other declarations in the same file that the target node's source
 * text actually references by name — e.g. a helper function it calls.
 * Whole-word matching avoids "add" inside "address" being treated as a call.
 * Capped at MAX_REFERENCED_SIBLINGS so a node that touches half the file
 * doesn't balloon the slice back up toward "the whole file" anyway.
 */
function findReferencedSiblings(targetNode: ParsedNode, file: FileParseResult): ParsedNode[] {
  const candidates = file.nodes.filter(
    (n) => n.id !== targetNode.id && (n.kind === "function" || n.kind === "method" || n.kind === "variable"),
  );

  const referenced = candidates.filter((sibling) => {
    const pattern = new RegExp(`\\b${escapeRegExp(sibling.name)}\\b`);
    return pattern.test(targetNode.sourceText);
  });

  return referenced.slice(0, MAX_REFERENCED_SIBLINGS);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reduces a sibling's source to just its signature line(s) — everything up
 * to (not including) the opening brace of its body. Falls back to a capped
 * first line if no brace is found (e.g. a one-line arrow function) — that
 * first line isn't guaranteed to be short, so it's truncated explicitly
 * rather than assumed to be.
 */
function summarizeSignature(sourceText: string): string {
  const braceIndex = sourceText.indexOf("{");
  if (braceIndex !== -1) {
    return `${sourceText.slice(0, braceIndex).trim()} { /* body omitted for brevity */ }`;
  }
  const firstLine = sourceText.split("\n")[0].trim();
  return firstLine.length > SIGNATURE_FALLBACK_CHAR_LIMIT
    ? `${firstLine.slice(0, SIGNATURE_FALLBACK_CHAR_LIMIT)}... /* truncated */`
    : firstLine;
}

/** Renders one referenced sibling as either its full body or a signature stub, whichever is cheaper. */
function renderSibling(sibling: ParsedNode): string {
  const body =
    sibling.sourceText.length <= SIBLING_FULL_BODY_CHAR_LIMIT
      ? sibling.sourceText
      : summarizeSignature(sibling.sourceText);
  return `// Referenced ${sibling.kind}: ${sibling.name}\n${body}`;
}

/** Rough token estimate (~4 chars/token) — good enough to compare slice sizes, not for billing precision. */
export function estimateTokens(text: string): number {
  return defaultEstimator.estimateTokens(text);
}

export interface TokenSavingsReport {
  fullFileChars: number;
  sliceChars: number;
  estimatedFullFileTokens: number;
  estimatedSliceTokens: number;
  reductionPercent: number;
}

/**
 * Compares the slice actually sent to the LLM against the naive baseline of
 * sending the entire raw file. Used for logging/demo purposes to make the
 * token savings concrete rather than an unverified claim.
 */
export function estimateTokenSavings(file: FileParseResult, slice: string): TokenSavingsReport {
  const fullFileChars = file.fullText.length;
  const sliceChars = slice.length;
  const estimatedFullFileTokens = estimateTokens(file.fullText);
  const estimatedSliceTokens = estimateTokens(slice);
  const reductionPercent =
    fullFileChars === 0 ? 0 : Math.round(((fullFileChars - sliceChars) / fullFileChars) * 100);

  return { fullFileChars, sliceChars, estimatedFullFileTokens, estimatedSliceTokens, reductionPercent };
}

/**
 * Rolls up per-task TokenSavingsReports into one run-level total — what the
 * CLI prints at the end of a refactor run ("sent ~X tokens across N tasks
 * vs ~Y if every task had seen its whole file, Z% smaller"). Summing chars
 * first and re-deriving the percentage keeps the aggregate mathematically
 * consistent rather than averaging already-rounded per-task percentages.
 */
export function aggregateTokenSavings(reports: TokenSavingsReport[]): TokenSavingsReport {
  const totals = reports.reduce(
    (acc, r) => ({
      fullFileChars: acc.fullFileChars + r.fullFileChars,
      sliceChars: acc.sliceChars + r.sliceChars,
      estimatedFullFileTokens: acc.estimatedFullFileTokens + r.estimatedFullFileTokens,
      estimatedSliceTokens: acc.estimatedSliceTokens + r.estimatedSliceTokens,
    }),
    { fullFileChars: 0, sliceChars: 0, estimatedFullFileTokens: 0, estimatedSliceTokens: 0 },
  );

  const reductionPercent =
    totals.fullFileChars === 0
      ? 0
      : Math.round(((totals.fullFileChars - totals.sliceChars) / totals.fullFileChars) * 100);

  return { ...totals, reductionPercent };
}

/** Assembles the minimal source context slice for one target node. */
export function buildContextSlice(targetNode: ParsedNode, file: FileParseResult): string {
  const referencedSiblings = findReferencedSiblings(targetNode, file);
  const sections: string[] = [`// File: ${file.filePath}`];

  if (file.imports.length > 0) {
    sections.push(`// Imports in scope: ${file.imports.join(", ")}`);
  }

  for (const sibling of referencedSiblings) {
    sections.push(renderSibling(sibling));
  }

  sections.push(
    `// --- Refactor target: ${targetNode.kind} "${targetNode.name}" (lines ${targetNode.startLine}-${targetNode.endLine}) ---\n${targetNode.sourceText}`,
  );

  return sections.join("\n\n");
}

/** Combines scheduling + slicing into the objective the agent's ReAct loop consumes. */
export function buildRefactorObjective(task: QueuedTask, file: FileParseResult): RefactorObjective {
  const targetNode = file.nodes.find((n) => n.id === task.targetNodeId);
  if (!targetNode) {
    throw new Error(`Target node ${task.targetNodeId} not found in parsed file ${file.filePath}`);
  }

  return {
    taskId: task.taskId,
    targetNodeId: task.targetNodeId,
    instruction: generateInstruction(targetNode),
    contextSlice: buildContextSlice(targetNode, file),
  };
}

/**
 * Calculates deterministic token metrics comparing the unoptimized original context
 * against the optimized pruned payload.
 */
export function calculateTokenMetrics(
  originalText: string,
  optimizedText: string,
  options?: SlicerOptions,
): TokenMetrics {
  const ratio = options?.tokenizerRatio ?? 4;
  const estimator = new DeterministicTokenEstimator(ratio);

  const originalCharacters = originalText.length;
  const optimizedCharacters = optimizedText.length;
  const estimatedOriginalTokens = estimator.estimateTokens(originalText);
  const estimatedOptimizedTokens = estimator.estimateTokens(optimizedText);
  const estimatedTokenSavings = Math.max(0, estimatedOriginalTokens - estimatedOptimizedTokens);

  const tokenReductionPercentage =
    estimatedOriginalTokens === 0
      ? 0
      : Number((((estimatedOriginalTokens - estimatedOptimizedTokens) / estimatedOriginalTokens) * 100).toFixed(2));

  return {
    originalCharacters,
    optimizedCharacters,
    originalCharacterCount: originalCharacters,
    optimizedCharacterCount: optimizedCharacters,
    estimatedOriginalTokens,
    estimatedOptimizedTokens,
    estimatedTokenSavings,
    tokenReductionPercentage,
  };
}

/**
 * Stage 4 Primary Pipeline Entrypoint:
 * Takes a queued task or direct target node, performs node slicing, trivia extraction,
 * lightweight dependency signature extraction, context pruning, and token optimization measurement.
 *
 * IMPORTANT: ZERO LLM calls are made here. The resulting OptimizedPayload is passed to Stage 5.
 */
export function buildOptimizedPayload(params: BuildOptimizedPayloadParams): OptimizedPayload {
  let targetFileObj: FileParseResult | undefined = params.file;
  let targetNode: ParsedNode | SlicedTarget | undefined = params.targetNode;
  let dependencyFiles: FileParseResult[] = params.dependencyFiles ?? [];

  // If task and fileResults are passed from Stage 3 pipeline:
  if (params.task && params.fileResults) {
    const normTaskPath = normalizePath(params.task.filePath);
    targetFileObj = params.fileResults.find((f) => normalizePath(f.filePath) === normTaskPath);
    if (!targetFileObj) {
      throw new Error(`Target file ${params.task.filePath} not found in parsed workspace results`);
    }

    const foundNode = targetFileObj.nodes.find((n) => n.id === params.task!.targetNodeId);
    if (!foundNode) {
      throw new Error(`Target node ${params.task.targetNodeId} not found in ${params.task.filePath}`);
    }
    targetNode = foundNode;

    // Use dependency graph to discover imported dependency files if available
    if (params.graph) {
      const depNode = params.graph.nodes.get(targetFileObj.filePath) ?? params.graph.nodes.get(normTaskPath);
      const depPaths = depNode?.dependsOn.map(normalizePath) ?? [];
      dependencyFiles = params.fileResults.filter((f) => depPaths.includes(normalizePath(f.filePath)));
    }
  }

  if (!targetNode) {
    throw new Error("Cannot build optimized payload without a target AST node or queued task");
  }

  const targetCode = targetNode.sourceText;
  const targetFile = targetFileObj?.filePath ?? targetNode.filePath;
  const nodeKind = targetNode.kind;
  const name = targetNode.name;
  const startLine = targetNode.startLine;
  const endLine = targetNode.endLine;
  const startChar = "startChar" in targetNode ? targetNode.startChar : 0;
  const endChar = "endChar" in targetNode ? targetNode.endChar : targetCode.length;

  const smells: CodeSmell[] = params.smells ?? ("smells" in targetNode ? targetNode.smells : []);

  // 1. Trivia Extraction
  let trivia: TriviaMetadata = extractTriviaFromText(targetCode);
  if (targetNode && "trivia" in targetNode && targetNode.trivia) {
    trivia = {
      leadingComments: Array.from(new Set([...targetNode.trivia.leadingComments, ...trivia.leadingComments])),
      trailingComments: Array.from(new Set([...targetNode.trivia.trailingComments, ...trivia.trailingComments])),
      jsDoc: Array.from(new Set([...targetNode.trivia.jsDoc, ...trivia.jsDoc])),
      inlineComments: Array.from(new Set([...(targetNode.trivia.inlineComments ?? []), ...(trivia.inlineComments ?? [])])),
    };
  } else if (targetFileObj && targetFileObj.fullText && startLine > 1) {
    const fileLines = targetFileObj.fullText.split(/\r?\n/);
    const precedingLines = fileLines.slice(0, startLine - 1);
    const precedingTrivia = extractTriviaFromText(precedingLines.join("\n"));
    trivia = {
      leadingComments: Array.from(new Set([...precedingTrivia.trailingComments, ...precedingTrivia.leadingComments, ...trivia.leadingComments])),
      trailingComments: trivia.trailingComments,
      jsDoc: Array.from(new Set([...precedingTrivia.jsDoc, ...trivia.jsDoc])),
      inlineComments: trivia.inlineComments,
    };
  }

  // 2. Dependency Signatures (Lightweight declarations, stripped bodies)
  const dependencySignatures = extractDependencySignatures(targetCode, dependencyFiles);

  // 3. Relevant in-scope imports
  const allImports = targetFileObj?.imports ?? [];
  const relevantImports = extractRelevantImports(targetCode, allImports);

  // 4. Same-file referenced helpers (if targetFileObj available and target is a ParsedNode)
  const referencedSiblings: ParsedNode[] =
    targetFileObj && "id" in targetNode ? findReferencedSiblings(targetNode as ParsedNode, targetFileObj) : [];

  // 5. Context Pruning: Construct token-optimized representation
  // Target node + required signatures + required types + relevant imports + relevant trivia
  const optimizedParts: string[] = [];

  if (relevantImports.length > 0) {
    optimizedParts.push(relevantImports.join("\n"));
  }

  if (dependencySignatures.length > 0) {
    for (const dep of dependencySignatures) {
      optimizedParts.push(`// Signatures from ${dep.filePath}:\n${dep.signatures.join("\n")}`);
    }
  }

  if (referencedSiblings.length > 0) {
    for (const sib of referencedSiblings) {
      optimizedParts.push(renderSibling(sib));
    }
  }

  if (trivia.jsDoc.length > 0 && !targetCode.includes(trivia.jsDoc[0].trim())) {
    optimizedParts.push(trivia.jsDoc.join("\n"));
  }

  optimizedParts.push(targetCode);

  const optimizedText = optimizedParts.join("\n\n");

  const promptParts: string[] = [];
  promptParts.push(`// File: ${targetFile}`);
  promptParts.push(`// Target: ${nodeKind} "${name}" (lines ${startLine}-${endLine})`);

  if (smells.length > 0) {
    const parsedTarget = {
      id: "id" in targetNode ? targetNode.id : `${targetFile}::${name}`,
      kind: nodeKind as ParsedNode["kind"],
      name,
      filePath: targetFile,
      startLine,
      endLine,
      sourceText: targetCode,
      complexity: "complexity" in targetNode ? (targetNode as any).complexity : 1,
      smells,
    };
    promptParts.push(`// Instruction: ${generateInstruction(parsedTarget)}`);
  }

  promptParts.push(optimizedText);
  const promptContext = promptParts.join("\n\n");

  // 6. Token measurement:
  // Baseline: Entire target file fullText + full text of all imported dependency files
  const baselineComponents: string[] = [];
  if (targetFileObj?.fullText) {
    baselineComponents.push(targetFileObj.fullText);
  } else {
    baselineComponents.push(targetCode);
  }
  for (const dep of dependencyFiles) {
    if (dep.fullText) baselineComponents.push(dep.fullText);
  }
  const originalBaseline = baselineComponents.join("\n\n");

  const metrics = calculateTokenMetrics(originalBaseline, optimizedText, params.options);
  metrics.dependencyFilesCount = dependencySignatures.length;
  metrics.sourceLinesCount = endLine - startLine + 1;

  const context: RefactoringContext = {
    targetCode,
    targetFile,
    nodeKind,
    name,
    startLine,
    endLine,
    startChar,
    endChar,
    smells,
    trivia,
    dependencies: dependencySignatures,
    imports: relevantImports,
    promptContext,
  };

  return {
    context,
    metrics,
  };
}

/**
 * Generates an experiment comparison summary formatted for research metrics.
 */
export function formatExperimentComparison(payload: OptimizedPayload): string {
  const { context, metrics } = payload;
  const deps = context.dependencies.map((d) => d.filePath).join(", ");
  return [
    `Target: ${context.nodeKind} "${context.name}" in ${context.targetFile} (lines ${context.startLine}-${context.endLine})`,
    `Original context: ${metrics.originalCharacters} characters / ${metrics.estimatedOriginalTokens} estimated tokens`,
    `Optimized context: ${metrics.optimizedCharacters} characters / ${metrics.estimatedOptimizedTokens} estimated tokens`,
    `Estimated token reduction: ${metrics.tokenReductionPercentage}% (${metrics.estimatedTokenSavings} tokens saved)`,
    `Dependencies included: ${metrics.dependencyFilesCount ?? context.dependencies.length} file(s)${deps ? ` (${deps})` : ""}`,
    `Source lines: ${metrics.sourceLinesCount ?? context.endLine - context.startLine + 1} lines`,
  ].join("\n");
}