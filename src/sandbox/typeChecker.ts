/**
 * Type-checks one file by asking the ts-morph Project for its pre-emit
 * diagnostics — in-process, not by shelling out to a `tsc` subprocess.
 * We already have a ts-morph Project loaded from Station 1 (astEngine.ts),
 * and the TypeScript compiler API gives structured diagnostics directly,
 * so there's no text to parse and no extra process to spawn.
 */
import { Project, ts } from "ts-morph";
import type { CompilerDiagnostic, StageResult } from "../types/verification.types.js";

/**
 * A SEPARATE project constructor from astEngine.createProject(). That one
 * deliberately sets checkJs:false — it only needs to extract declarations,
 * not validate types. This one needs checkJs:true, or TypeScript silently
 * skips type-checking every .js file entirely (JSDoc annotations and all),
 * which would make this whole verification stage a no-op on a plain-JS
 * codebase — exactly the kind of target this project is built for. This
 * was caught by actually running typeCheckFile against a deliberately
 * broken patch and seeing zero diagnostics come back; it is not a
 * hypothetical concern.
 */
export function createVerificationProject(tsConfigFilePath?: string): Project {
  return tsConfigFilePath
    ? new Project({ tsConfigFilePath, compilerOptions: { checkJs: true } })
    : new Project({
        useInMemoryFileSystem: false,
        compilerOptions: { allowJs: true, checkJs: true, strict: false, noImplicitAny: false },
      });
}

/**
 * Type-checks a single file within an already-loaded Project. Only
 * diagnostics belonging to THIS file are returned — getPreEmitDiagnostics()
 * on the whole project would otherwise also surface pre-existing errors
 * elsewhere in the codebase that have nothing to do with this patch.
 */
export function typeCheckFile(project: Project, filePath: string): StageResult {
  const sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    return {
      stage: "typecheck",
      passed: false,
      exitCode: 1,
      rawOutput: `No source file loaded in the project for ${filePath}`,
      diagnostics: [],
    };
  }

  const allDiagnostics = project.getPreEmitDiagnostics();
  const fileDiagnostics = allDiagnostics.filter((d) => d.getSourceFile()?.getFilePath() === sourceFile.getFilePath());

  // Only ERRORS fail the stage — warnings/suggestions (e.g. unused variable
  // hints) shouldn't block a refactor from being accepted.
  const errorDiagnostics = fileDiagnostics.filter((d) => d.getCategory() === ts.DiagnosticCategory.Error);

  const diagnostics: CompilerDiagnostic[] = errorDiagnostics.map((d) => ({
    code: `TS${d.getCode()}`,
    // .compilerObject gets the raw (unwrapped) compiler diagnostic — ts-morph's
    // own Diagnostic/DiagnosticMessageChain wrapper classes aren't type- or
    // structurally-compatible with ts.flattenDiagnosticMessageText's expected input.
    message: ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n"),
    filePath,
    line: (d.getLineNumber() ?? 0),
  }));

  const rawOutput = diagnostics.map((d) => `${d.filePath}:${d.line} — ${d.code}: ${d.message}`).join("\n");

  return {
    stage: "typecheck",
    passed: diagnostics.length === 0,
    exitCode: diagnostics.length === 0 ? 0 : 1,
    diagnostics,
    rawOutput: rawOutput || "No type errors.",
  };
}