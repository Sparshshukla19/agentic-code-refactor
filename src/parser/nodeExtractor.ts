/**
 * Finds the real ts-morph node corresponding to a ParsedNode, and applies
 * a patch to it. This is the missing link between "the agent proposed new
 * source text" and "the file on disk actually has that new text in it" —
 * astEngine.ts only ever READS declarations into ParsedNode records; this
 * module is what writes a replacement back.
 */
import type { Project, Node as TsMorphNode } from "ts-morph";
import type { NodeKind, ParsedNode } from "../types/ast.types.js";

/**
 * Re-locates the ts-morph declaration a ParsedNode was extracted from, by
 * kind + name in its file — mirroring astEngine.parseSourceFile's own
 * extraction logic in reverse. Returns undefined if the file isn't loaded
 * in this project, or nothing matching is found (e.g. the node was
 * already replaced and renamed by an earlier patch in this same run).
 */
export function findNodeInProject(project: Project, parsedNode: ParsedNode): TsMorphNode | undefined {
  const sourceFile = project.getSourceFile(parsedNode.filePath);
  if (!sourceFile) return undefined;

  const byKind: Record<NodeKind, () => TsMorphNode | undefined> = {
    function: () => sourceFile.getFunctions().find((f) => f.getName() === parsedNode.name),
    class: () => sourceFile.getClasses().find((c) => c.getName() === parsedNode.name),
    method: () => {
      for (const cls of sourceFile.getClasses()) {
        const method = cls.getMethods().find((m) => m.getName() === parsedNode.name);
        if (method) return method;
      }
      return undefined;
    },
    interface: () => sourceFile.getInterfaces().find((i) => i.getName() === parsedNode.name),
    "type-alias": () => sourceFile.getTypeAliases().find((t) => t.getName() === parsedNode.name),
    variable: () =>
      sourceFile.getVariableStatements().find((v) => v.getDeclarations().map((d) => d.getName()).join(", ") === parsedNode.name),
  };

  return byKind[parsedNode.kind]();
}

export interface ApplyPatchResult {
  applied: boolean;
  reason?: string;
}

/**
 * IMPORTANT, found by actually testing this against a real file with a
 * JSDoc comment, not assumed: a plain `//` leading comment is free-floating
 * trivia and survives replaceWithText() untouched — but a /** JSDoc *\/
 * block is structurally ATTACHED to the node in the compiler's AST, so
 * it's part of what replaceWithText() overwrites, even though getText()
 * (what astEngine captures and sends to the LLM) excludes it from the
 * string. Left alone, this would silently delete every function's JSDoc
 * the moment it got refactored. Fixed by capturing it ourselves here and
 * re-prepending it to the replacement text — the LLM never needs to see
 * or reproduce it at all, which also keeps it out of the token count.
 */
function getLeadingJsDocText(node: TsMorphNode): string {
  const maybeJsDocable = node as unknown as { getJsDocs?: () => Array<{ getText(): string }> };
  const jsDocs = maybeJsDocable.getJsDocs?.() ?? [];
  return jsDocs.map((d) => d.getText()).join("\n");
}

/**
 * Replaces the node's text with newSourceText (plus any JSDoc the node
 * had, reattached) and saves the file to disk.
 */
export async function applyPatch(project: Project, parsedNode: ParsedNode, newSourceText: string): Promise<ApplyPatchResult> {
  const node = findNodeInProject(project, parsedNode);
  if (!node) {
    return { applied: false, reason: `Could not re-locate ${parsedNode.kind} "${parsedNode.name}" in ${parsedNode.filePath}` };
  }

  const leadingJsDoc = getLeadingJsDocText(node);
  const fullReplacement = leadingJsDoc ? `${leadingJsDoc}\n${newSourceText}` : newSourceText;

  node.replaceWithText(fullReplacement);
  await project.getSourceFile(parsedNode.filePath)!.save();

  return { applied: true };
}