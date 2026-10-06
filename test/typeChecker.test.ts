import { describe, expect, it } from "vitest";
import path from "node:path";
import { createVerificationProject, typeCheckFile } from "../src/sandbox/typeChecker.js";

describe("typeCheckFile", () => {
  it("reports no diagnostics for valid TypeScript", () => {
    const project = createVerificationProject();
    const sf = project.createSourceFile("good.ts", "function add(a: number, b: number): number { return a + b; }");
    const result = typeCheckFile(project, sf.getFilePath());
    expect(result.passed).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("catches a real type error with the correct code and line", () => {
    const project = createVerificationProject();
    const sf = project.createSourceFile(
      "bad.ts",
      ['function add(a: number, b: number): number {', '  return a + b;', '}', 'const result = add("1", 2);'].join("\n"),
    );
    const result = typeCheckFile(project, sf.getFilePath());
    expect(result.passed).toBe(false);
    expect(result.diagnostics?.[0].code).toBe("TS2345");
    expect(result.diagnostics?.[0].line).toBe(4);
  });

  it("scopes diagnostics to only the requested file, not the whole project", () => {
    const project = createVerificationProject();
    const good = project.createSourceFile("good2.ts", "function ok(): number { return 1; }");
    project.createSourceFile("bad2.ts", 'const x: number = "not a number";');
    const result = typeCheckFile(project, good.getFilePath());
    expect(result.passed).toBe(true);
  });

  it("actually type-checks .js files via JSDoc annotations (checkJs must be on)", () => {
    // This is the exact bug found during manual testing: with checkJs:false
    // (astEngine's parsing config), a .js file's type errors are silently
    // never reported at all. createVerificationProject must not repeat that.
    const project = createVerificationProject();
    const sf = project.createSourceFile(
      "typed.js",
      ["/**", " * @param {number} a", " * @returns {number}", " */", "function double(a) {", "  return a.toUpperCase();", "}"].join("\n"),
    );
    const result = typeCheckFile(project, sf.getFilePath());
    expect(result.passed).toBe(false);
    expect(result.diagnostics?.length).toBeGreaterThan(0);
  });

  it("returns a failed stage, not a throw, when the file isn't in the project", () => {
    const project = createVerificationProject();
    const result = typeCheckFile(project, "/nonexistent/file.ts");
    expect(result.passed).toBe(false);
    expect(result.rawOutput).toContain("No source file loaded");
  });

  it("catches a real injected bug in the actual sample codebase without affecting a sibling file", () => {
    const project = createVerificationProject();
    const mathUtilsPath = path.resolve("test-target/src/mathUtils.js");
    const userControllerPath = path.resolve("test-target/src/userController.js");
    project.addSourceFileAtPath(mathUtilsPath);
    project.addSourceFileAtPath(userControllerPath);

    const mathUtilsFile = project.getSourceFile(mathUtilsPath)!;
    const addFn = mathUtilsFile.getFunctions().find((f) => f.getName() === "add")!;
    addFn.replaceWithText(
      ["/**", " * @param {number} a", " * @param {number} b", " * @returns {number}", " */", "function add(a, b) {", "  return a.toUpperCase() + b;", "}"].join("\n"),
    );

    const mathResult = typeCheckFile(project, mathUtilsPath);
    expect(mathResult.passed).toBe(false);
    expect(mathResult.diagnostics?.[0].code).toBe("TS2339");

    const controllerResult = typeCheckFile(project, userControllerPath);
    expect(controllerResult.passed).toBe(true);
  });
});