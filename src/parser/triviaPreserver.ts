/**
 * Stage 4: Trivia Preservation Layer
 * Extracts and preserves whitespace, JSDoc, leading, trailing, and inline comments
 * to prevent documentation and developer intent from being lost during slicing and refactoring.
 */
import { Node } from "ts-morph";
import type { TriviaMetadata } from "../types/slicer.types.js";

export type { TriviaMetadata };

/**
 * Extracts all trivia (JSDoc, leading comments, trailing comments, inline comments)
 * from a ts-morph AST Node.
 */
export function extractTrivia(node: Node): TriviaMetadata {
  const jsDoc: string[] = [];
  const leadingComments: string[] = [];
  const trailingComments: string[] = [];
  const inlineComments: string[] = [];

  // Determine if parent has comments (for arrow functions or expressions in variable statements)
  let targetForComments = node;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      const varStatement = parent.getParent()?.getParent();
      if (varStatement) {
        targetForComments = varStatement;
      }
    }
  }

  // 1. JSDoc extraction
  if (Node.isJSDocable(node)) {
    for (const doc of node.getJsDocs()) {
      const text = doc.getText();
      if (!jsDoc.includes(text)) jsDoc.push(text);
    }
  }
  if (targetForComments !== node && Node.isJSDocable(targetForComments)) {
    for (const doc of (targetForComments as unknown as { getJsDocs: () => { getText: () => string }[] }).getJsDocs()) {
      const text = doc.getText();
      if (!jsDoc.includes(text)) jsDoc.push(text);
    }
  }

  // 2. Leading comments
  try {
    const leadingRanges = [
      ...targetForComments.getLeadingCommentRanges(),
      ...(targetForComments !== node ? node.getLeadingCommentRanges() : []),
    ];
    for (const range of leadingRanges) {
      const text = range.getText();
      if (!leadingComments.includes(text)) {
        leadingComments.push(text);
      }
      if (text.startsWith("/**") && !jsDoc.includes(text)) {
        jsDoc.push(text);
      }
    }
  } catch {
    // Ignore range lookup errors on synthetic nodes
  }

  // 3. Trailing comments
  try {
    const trailingRanges = node.getTrailingCommentRanges();
    for (const range of trailingRanges) {
      const text = range.getText();
      if (!trailingComments.includes(text)) {
        trailingComments.push(text);
      }
    }
  } catch {
    // Ignore range lookup errors on synthetic nodes
  }

  // 4. Inline comments within node body
  const rawText = node.getText();
  const commentRegex = /(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g;
  let match: RegExpExecArray | null;

  while ((match = commentRegex.exec(rawText)) !== null) {
    const comment = match[0];
    if (
      !leadingComments.includes(comment) &&
      !trailingComments.includes(comment) &&
      !jsDoc.includes(comment) &&
      !inlineComments.includes(comment)
    ) {
      inlineComments.push(comment);
    }
  }

  return {
    leadingComments,
    trailingComments,
    jsDoc,
    inlineComments,
  };
}

/**
 * Fallback trivia extractor from raw source text when no live AST Node is available.
 * Accurately extracts multiline JSDoc, leading, trailing, and inline comments.
 */
export function extractTriviaFromText(sourceText: string): TriviaMetadata {
  const jsDoc: string[] = [];
  const leadingComments: string[] = [];
  const trailingComments: string[] = [];
  const inlineComments: string[] = [];

  const commentRegex = /(\/\*\*[\s\S]*?\*\/|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g;
  const comments: { text: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = commentRegex.exec(sourceText)) !== null) {
    comments.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Find the first and last non-comment non-whitespace characters in sourceText
  let firstCodeIndex = -1;
  let lastCodeIndex = -1;

  for (let i = 0; i < sourceText.length; i++) {
    const isWhitespace = /\s/.test(sourceText[i]);
    const insideComment = comments.some((c) => i >= c.start && i < c.end);
    if (!isWhitespace && !insideComment) {
      if (firstCodeIndex === -1) {
        firstCodeIndex = i;
      }
      lastCodeIndex = i;
    }
  }

  for (const c of comments) {
    if (firstCodeIndex !== -1 && c.end <= firstCodeIndex) {
      // Leading comment
      if (!leadingComments.includes(c.text)) leadingComments.push(c.text);
      if (c.text.startsWith("/**") && !jsDoc.includes(c.text)) {
        jsDoc.push(c.text);
      }
    } else if (lastCodeIndex !== -1 && c.start > lastCodeIndex) {
      // Trailing comment
      if (!trailingComments.includes(c.text)) trailingComments.push(c.text);
    } else {
      // Inline comment
      if (!inlineComments.includes(c.text)) inlineComments.push(c.text);
      if (c.text.startsWith("/**") && !jsDoc.includes(c.text)) {
        jsDoc.push(c.text);
      }
    }
  }

  // If there was no code at all, treat all comments as leading comments
  if (firstCodeIndex === -1) {
    for (const c of comments) {
      if (!leadingComments.includes(c.text)) leadingComments.push(c.text);
      if (c.text.startsWith("/**") && !jsDoc.includes(c.text)) {
        jsDoc.push(c.text);
      }
    }
  }

  return {
    leadingComments,
    trailingComments,
    jsDoc,
    inlineComments,
  };
}

function normalizeEol(str: string): string {
  return str.replace(/\r\n/g, "\n");
}

/**
 * Reattaches preserved JSDoc and leading comments to refactored code if they were omitted.
 */
export function reconcileTrivia(newSourceText: string, trivia: TriviaMetadata): string {
  const missingLeading: string[] = [];
  const normalizedNew = normalizeEol(newSourceText);

  for (const doc of trivia.jsDoc) {
    const normDoc = normalizeEol(doc.trim());
    if (!normDoc) continue;
    if (!normalizedNew.includes(normDoc)) {
      if (!missingLeading.some((m) => normalizeEol(m.trim()) === normDoc)) {
        missingLeading.push(doc);
      }
    }
  }

  for (const comment of trivia.leadingComments) {
    const normComment = normalizeEol(comment.trim());
    if (!normComment) continue;
    const inJsDoc = trivia.jsDoc.some((d) => normalizeEol(d.trim()) === normComment);
    if (inJsDoc) continue;

    if (!normalizedNew.includes(normComment)) {
      if (!missingLeading.some((m) => normalizeEol(m.trim()) === normComment)) {
        missingLeading.push(comment);
      }
    }
  }

  if (missingLeading.length === 0) {
    return newSourceText;
  }

  return `${missingLeading.join("\n")}\n${newSourceText}`;
}
