import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createProject, parseFiles, parseSourceFile } from "../src/parser/astEngine.js";
import { applyPatch } from "../src/parser/nodeExtractor.js";
import { buildRefactorObjective, JS_FILE_NOTE } from "../src/planner/contextSlicer.js";
import { SYSTEM_PROMPT } from "../src/agent/prompts.js";
import type { FileParseResult, ParsedNode } from "../src/types/ast.types.js";

vi.mock("../src/agent/reactLoop.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/reactLoop.js")>("../src/agent/reactLoop.js");
  return { ...actual, runRefactorTask: vi.fn() };
});
const { runRefactorTask } = await import("../src/agent/reactLoop.js");
const { runPipeline } = await import("../src/index.js");

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jstyping-")); });
afterEach(() => { vi.clearAllMocks(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function write(name: string, text: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, text);
  return p;
}

const node = (): ParsedNode => ({
  id: "f::fn", kind: "function", name: "fn", filePath: "f", startLine: 1, endLine: 3,
  sourceText: "function fn(a) {}", complexity: 1, smells: [{ type: "untyped-signature", message: "x", line: 1 }],
});
const fileOf = (language: "js" | "ts"): FileParseResult => ({ filePath: "f", language, nodes: [node()], imports: [], exports: [], fullText: "" });
const task = { taskId: "task-0", filePath: "f", targetNodeId: "f::fn", order: 0, status: "pending" as const };

describe("language-aware instructions", () => {
  it("tells the model to use JSDoc, not TypeScript syntax, for a .js file", () => {
    const objective = buildRefactorObjective(task, fileOf("js"));
    expect(objective.instruction).toContain(JS_FILE_NOTE);
    expect(objective.instruction).toContain("JSDoc");
  });

  it("adds no such note for a TypeScript file", () => {
    const objective = buildRefactorObjective(task, fileOf("ts"));
    expect(objective.instruction).not.toContain("JSDoc");
  });

  it("no longer describes the agent as TypeScript-only", () => {
    expect(SYSTEM_PROMPT).toContain("JavaScript and TypeScript");
    expect(SYSTEM_PROMPT).toContain("never use TypeScript-only syntax");
  });
});

describe("applyPatch with a patch that brings its own JSDoc", () => {
  it("replaces the old JSDoc instead of stacking a second block on top", async () => {
    const file = write("a.js", "/**\n * OLD DOC\n */\nfunction add(a, b) {\n  return a + b;\n}\n");
    const project = createProject();
    const sf = project.addSourceFileAtPath(file);
    const parsed = parseSourceFile(sf).nodes.find((n) => n.name === "add")!;

    await applyPatch(project, parsed, "/**\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nfunction add(a, b) {\n  return a + b;\n}");

    const result = fs.readFileSync(file, "utf-8");
    expect(result).not.toContain("OLD DOC");
    expect(result.match(/\/\*\*/g)).toHaveLength(1);
    expect(result).toContain("@returns {number}");
  });
});

describe("smell detection recognizes JSDoc types in .js files", () => {
  const smellsOf = (name: string, source: string) =>
    parseFiles([write(name, source)])[0].nodes[0].smells.map((s) => s.type);

  it("does not flag a function whose params and return are all typed in JSDoc", () => {
    expect(smellsOf("typed.js", "/**\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nfunction add(a, b) {\n  return a + b;\n}\n")).not.toContain("untyped-signature");
  });

  it("still flags a function with only some params documented", () => {
    expect(smellsOf("partial.js", "/**\n * @param {number} a\n * @returns {number}\n */\nfunction add(a, b) {\n  return a + b;\n}\n")).toContain("untyped-signature");
  });

  it("still flags a function whose JSDoc has no types", () => {
    expect(smellsOf("untyped.js", "/**\n * Adds.\n * @param a\n * @param b\n */\nfunction add(a, b) {\n  return a + b;\n}\n")).toContain("untyped-signature");
  });

  it("still flags an untyped function with no JSDoc at all", () => {
    expect(smellsOf("plain.js", "function add(a, b) {\n  return a + b;\n}\n")).toContain("untyped-signature");
  });
});

describe("end to end on a .js file (LLM mocked)", () => {
  const jsdocPatch = "/**\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nfunction add(a, b) {\n  return a + b;\n}";
  const tsSyntaxPatch = "function add(a: number, b: number): number {\n  return a + b;\n}";
  const call = (newSourceText: string) => ({
    tool: "propose_patch" as const,
    payload: { taskId: "x", targetNodeId: "x", newSourceText, explanation: "typed it" },
  });

  it("accepts a JSDoc-typed patch, and the fixed function is not scheduled again on the next run", async () => {
    const file = write("add.js", "function add(a, b) {\n  return a + b;\n}\n");
    vi.mocked(runRefactorTask).mockResolvedValue(call(jsdocPatch));

    const first = await runPipeline({ targetDir: tmpDir, filePaths: [file], minRefactorScore: 0, skipGit: true });
    expect(first.taskOutcomes[0].passed).toBe(true);

    vi.mocked(runRefactorTask).mockClear();
    const second = await runPipeline({ targetDir: tmpDir, filePaths: [file], minRefactorScore: 0, skipGit: true });
    expect(second.taskOutcomes).toHaveLength(0);
    expect(runRefactorTask).not.toHaveBeenCalled(); // no tokens spent re-fixing finished work
  });

  it("rejects TypeScript syntax in a .js file, restoring the original (the failure real Gemini output would have hit)", async () => {
    const original = "function add(a, b) {\n  return a + b;\n}\n";
    const file = write("add.js", original);
    vi.mocked(runRefactorTask).mockResolvedValue(call(tsSyntaxPatch));

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [file], minRefactorScore: 0, skipGit: true, maxRetries: 2 });

    expect(result.taskOutcomes[0].passed).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
    const retryTurns = vi.mocked(runRefactorTask).mock.calls[1][2]?.priorTurns ?? [];
    expect(retryTurns.some((t) => t.content.includes("TS8010"))).toBe(true); // the real compiler error reaches the retry
  });
});