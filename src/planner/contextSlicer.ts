/**
 * Extracts the minimal source context the agent needs for one refactor
 * task, plus token-savings measurement.
 */
import type { CodeSmellType, FileParseResult, ParsedNode } from "../types/ast.types.js";
import type { QueuedTask } from "../types/graph.types.js";
import type { RefactorObjective } from "../types/agent.types.js";

const MAX_REFERENCED_SIBLINGS = 5;
const SIBLING_FULL_BODY_CHAR_LIMIT = 300;
const SIGNATURE_FALLBACK_CHAR_LIMIT = 80;

const SMELL_INSTRUCTIONS: Record<CodeSmellType, string> = {
  "untyped-signature": "Add explicit parameter and return types.",
  "callback-hell": "Convert nested callbacks into async/await with a single top-level try/catch.",
  "implicit-any": "Replace implicit `any` types with explicit, accurate types.",
  "var-usage": "Replace `var` declarations with `let` or `const` as appropriate.",
  "no-error-handling": "Add proper error handling (try/catch, or an error-first check) around the async logic.",
  "duplicate-logic": "Extract the duplicated logic into a single shared helper.",
  "high-complexity": "Break this function into smaller pieces to reduce branching complexity.",
};

/**
 * For a plain .js file, types must be JSDoc comments — TypeScript syntax is a
 * hard error there (TS8010), which would fail verification on every attempt.
 * Found by running a real Gemini patch (`function add(a: number): number`)
 * through the type checker, not assumed.
 */
export const JS_FILE_NOTE =
  "This is a plain JavaScript (.js) file, so express types as JSDoc comments (@param {type} name, @returns {type}) " +
  "directly above the function, and include that JSDoc block at the top of newSourceText. " +
  "Do NOT use TypeScript syntax (no `: type` annotations, interfaces, generics, or `as` casts) — it is a syntax error in a .js file.";

export function generateInstruction(node: ParsedNode): string {
  if (node.smells.length === 0) {
    return "Modernize this code without changing its behavior.";
  }
  const uniqueInstructions = Array.from(new Set(node.smells.map((s) => SMELL_INSTRUCTIONS[s.type])));
  return uniqueInstructions.join(" ");
}

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

function renderSibling(sibling: ParsedNode): string {
  const body =
    sibling.sourceText.length <= SIBLING_FULL_BODY_CHAR_LIMIT
      ? sibling.sourceText
      : summarizeSignature(sibling.sourceText);
  return `// Referenced ${sibling.kind}: ${sibling.name}\n${body}`;
}

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

export function estimateTokenSavings(file: FileParseResult, slice: string): TokenSavingsReport {
  const fullFileChars = file.fullText.length;
  const sliceChars = slice.length;
  const estimatedFullFileTokens = estimateTokens(file.fullText);
  const estimatedSliceTokens = estimateTokens(slice);
  const reductionPercent =
    fullFileChars === 0 ? 0 : Math.round(((fullFileChars - sliceChars) / fullFileChars) * 100);
  return { fullFileChars, sliceChars, estimatedFullFileTokens, estimatedSliceTokens, reductionPercent };
}

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

export function buildRefactorObjective(task: QueuedTask, file: FileParseResult): RefactorObjective {
  const targetNode = file.nodes.find((n) => n.id === task.targetNodeId);
  if (!targetNode) {
    throw new Error(`Target node ${task.targetNodeId} not found in parsed file ${file.filePath}`);
  }
  return {
    taskId: task.taskId,
    targetNodeId: task.targetNodeId,
    instruction: file.language === "js" ? `${generateInstruction(targetNode)} ${JS_FILE_NOTE}` : generateInstruction(targetNode),
    contextSlice: buildContextSlice(targetNode, file),
  };
}