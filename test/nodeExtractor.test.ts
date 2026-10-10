import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createProject, parseSourceFile } from "../src/parser/astEngine.js";
import { applyPatch, findNodeInProject } from "../src/parser/nodeExtractor.js";

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeextractor-test-"));
  filePath = path.join(tmpDir, "sample.js");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAndParse(source: string) {
  fs.writeFileSync(filePath, source);
  const project = createProject();
  const sourceFile = project.addSourceFileAtPath(filePath);
  const parsed = parseSourceFile(sourceFile);
  return { project, parsed };
}

describe("findNodeInProject", () => {
  it("re-locates a function by name", () => {
    const { project, parsed } = writeAndParse("function add(a, b) { return a + b; }");
    const node = findNodeInProject(project, parsed.nodes[0]);
    expect(node).toBeDefined();
    expect(node!.getKindName()).toBe("FunctionDeclaration");
  });

  it("returns undefined for a file not loaded in the project", () => {
    const { project, parsed } = writeAndParse("function add(a, b) { return a + b; }");
    const fakeNode = { ...parsed.nodes[0], filePath: "/not/loaded.js" };
    expect(findNodeInProject(project, fakeNode)).toBeUndefined();
  });
});

describe("applyPatch", () => {
  it("replaces the target function's text and saves it to disk", async () => {
    const { project, parsed } = writeAndParse("function add(a, b) { return a + b; }");
    const result = await applyPatch(project, parsed.nodes[0], "function add(a: number, b: number): number {\n  return a + b;\n}");
    expect(result.applied).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toContain("function add(a: number, b: number): number");
  });

  it("preserves a leading JSDoc block, even though it wasn't part of the captured sourceText", async () => {
    const { project, parsed } = writeAndParse(
      ["/**", " * Adds two numbers.", " * @param {number} a", " */", "function add(a, b) { return a + b; }"].join("\n"),
    );
    const addNode = parsed.nodes.find((n) => n.name === "add")!;
    expect(addNode.sourceText).not.toContain("Adds two numbers"); // confirms the JSDoc wasn't captured in the first place

    await applyPatch(project, addNode, "function add(a, b) {\n  return a + b; // patched\n}");
    const result = fs.readFileSync(filePath, "utf-8");
    expect(result).toContain("Adds two numbers");
    expect(result).toContain("// patched");
  });

  it("preserves a plain leading line comment", async () => {
    const { project, parsed } = writeAndParse(["// important note", "function add(a, b) { return a + b; }"].join("\n"));
    await applyPatch(project, parsed.nodes[0], "function add(a, b) {\n  return a + b; // patched\n}");
    expect(fs.readFileSync(filePath, "utf-8")).toContain("// important note");
  });

  it("leaves an unrelated sibling function completely untouched", async () => {
    const { project, parsed } = writeAndParse(
      ["function add(a, b) { return a + b; }", "", "function unrelated() { return 42; }"].join("\n"),
    );
    const addNode = parsed.nodes.find((n) => n.name === "add")!;
    await applyPatch(project, addNode, "function add(a, b) {\n  return a + b; // patched\n}");
    const result = fs.readFileSync(filePath, "utf-8");
    expect(result).toContain("function unrelated() { return 42; }");
  });

  it("returns applied:false with a clear reason when the node can't be re-located", async () => {
    const { project, parsed } = writeAndParse("function add(a, b) { return a + b; }");
    const missingNode = { ...parsed.nodes[0], name: "doesNotExist" };
    const result = await applyPatch(project, missingNode, "function doesNotExist() {}");
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("doesNotExist");
  });
});