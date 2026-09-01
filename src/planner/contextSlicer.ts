/**
 * Extracts the minimal source context the agent needs for one refactor
 * task: the target node itself, plus same-file helpers it actually calls
 * (so the LLM isn't guessing at a dependency's signature), and a
 * plain-language instruction derived from the smells that were detected.
 * Deliberately excludes everything else in the file — token budget and
 * hallucination risk both grow with irrelevant context.
 */
import type { CodeSmellType, FileParseResult, ParsedNode } from "../types/ast.types.js";
import type { QueuedTask } from "../types/graph.types.js";
import type { RefactorObjective } from "../types/agent.types.js";

const MAX_REFERENCED_SIBLINGS = 5;
// A sibling this large or smaller gets included verbatim; above it, only its
// signature is sent. The agent almost always needs a helper's *interface* to
// type against — not its implementation — and bodies are where token cost hides.
const SIBLING_FULL_BODY_CHAR_LIMIT = 300;

const SMELL_INSTRUCTIONS: Record<CodeSmellType, string> = {
  "untyped-signature": "Add explicit parameter and return types.",
  "callback-hell": "Convert nested callbacks into async/await with a single top-level try/catch.",
  "implicit-any": "Replace implicit `any` types with explicit, accurate types.",
  "var-usage": "Replace `var` declarations with `let` or `const` as appropriate.",
  "no-error-handling": "Add proper error handling (try/catch, or an error-first check) around the async logic.",
  "duplicate-logic": "Extract the duplicated logic into a single shared helper.",
};

/** Builds the plain-language refactor instruction from a node's detected smells. */
export function generateInstruction(node: ParsedNode): string {
  if (node.smells.length === 0) {
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
 * to (not including) the opening brace of its body. Falls back to the first
 * line if no brace is found (e.g. a one-line arrow function). This is what
 * lets a large helper be "referenced" in the slice without paying for its
 * full implementation in tokens.
 */
const SIGNATURE_FALLBACK_CHAR_LIMIT = 80;

function summarizeSignature(sourceText: string): string {
  const braceIndex = sourceText.indexOf("{");
  if (braceIndex !== -1) {
    return `${sourceText.slice(0, braceIndex).trim()} { /* body omitted for brevity */ }`;
  }
  // No brace — e.g. a one-line arrow function. Its "first line" isn't
  // guaranteed to be short (it could be the entire huge single-line source),
  // so cap it explicitly rather than assuming.
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
  return Math.ceil(text.length / 4);
}

export interface TokenSavingsReport {
  fullFileChars: number;
  sliceChars: number;
  estimatedFullFileTokens: number;
  estimatedSliceTokens: number;
  reductionPercent: number;
}

/**
 * Compares the slice actually sent to the LLM against a naive baseline of
 * "every declaration in the file" — the alternative most simple tools use.
 * Used for logging/demo purposes to make the token savings concrete rather
 * than an unverified claim.
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