import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  calculateSmellReductionPercentage,
  calculateTokenReductionPercentage,
  generateJsonReport,
  generateMarkdownReport,
  generateReport,
} from "../src/reporting/reportGenerator.js";
import {
  FileExistsError,
  PathTraversalError,
  assertSafeOutputPath,
  writeArtifacts,
} from "../src/reporting/artifactWriter.js";
import { runRefactoringPipeline } from "../src/reporting/pipelineRunner.js";
import type { CodeSmell, FileParseResult, ParsedNode } from "../src/types/ast.types.js";
import type { RefactoringResult } from "../src/types/refactor.types.js";
import type { OptimizedPayload } from "../src/types/slicer.types.js";
import type { ValidationResult } from "../src/types/validation.types.js";
import type { WorkspaceResult } from "../src/types/workspace.types.js";

function makeSmell(type: CodeSmell["type"], message = "Smell detected"): CodeSmell {
  return {
    type,
    message,
    line: 1,
    column: 1,
    filePath: "src/sample.ts",
  };
}

function makeParsedNode(name: string, smells: CodeSmell[] = []): ParsedNode {
  return {
    id: `src/sample.ts::${name}`,
    kind: "function",
    name,
    filePath: "src/sample.ts",
    startLine: 1,
    endLine: 10,
    sourceText: `function ${name}() {}`,
    complexity: 1,
    smells,
  };
}

function makeFileParseResult(
  filePath: string,
  nodes: ParsedNode[],
  sourceText = "function foo() {}",
): FileParseResult {
  return {
    filePath,
    language: "ts",
    nodes,
    imports: [],
    exports: [],
    fullText: sourceText,
    sourceText,
    smells: nodes.flatMap((n) => n.smells),
  };
}

function makeValidationResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    syntaxValid: true,
    typeSafe: true,
    triviaPreserved: true,
    astReconciled: true,
    diagnostics: [],
    beforeSmells: [makeSmell("var-usage")],
    afterSmells: [],
    fixedSmells: [makeSmell("var-usage")],
    remainingSmells: [],
    beforeSmellCount: 1,
    afterSmellCount: 0,
    fixedSmellCount: 1,
    remainingSmellCount: 0,
    smellReductionPercentage: 100,
    refactoredCode: "const x = 10;",
    originalCode: "var x = 10;",
    strategy: "mechanical",
    targetFile: "src/sample.ts",
    tokenMetrics: {
      originalCharacters: 100,
      optimizedCharacters: 50,
      estimatedOriginalTokens: 25,
      estimatedOptimizedTokens: 13,
      estimatedTokenSavings: 12,
      tokenReductionPercentage: 48,
    },
    ...overrides,
  };
}

describe("Stage 7: Reporting, Dashboard & Artifact Output", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage7-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 1. JSON report generation
  it("1. generates a valid, machine-readable JSON report matching expected schema", () => {
    const node = makeParsedNode("testFn", [makeSmell("var-usage")]);
    const file = makeFileParseResult("src/test.ts", [node]);
    const valResult = makeValidationResult({
      targetFile: "src/test.ts",
      beforeSmellCount: 2,
      afterSmellCount: 0,
      fixedSmellCount: 2,
    });

    const report = generateReport({
      parseResults: [file],
      validationResults: [valResult],
      processingTimeMs: 120,
    });

    const json = generateJsonReport(report, true);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("project");
    expect(parsed).toHaveProperty("technicalDebt");
    expect(parsed).toHaveProperty("tokenOptimization");
    expect(parsed).toHaveProperty("validation");
    expect(parsed).toHaveProperty("executionSummary");
    expect(parsed).toHaveProperty("refactoringActivity");
    expect(parsed).toHaveProperty("researchMetrics");

    expect(parsed.project.filesAnalyzed).toBe(1);
    expect(parsed.technicalDebt.beforeSmellCount).toBe(1);
    expect(parsed.tokenOptimization.estimatedOriginalTokens).toBe(25);
    expect(parsed.validation.syntaxValid).toBe(true);
    expect(parsed.validation.acceptedTransformations).toBe(1);
    expect(parsed.validation.rejectedTransformations).toBe(0);
  });

  // 2. Markdown report generation
  it("2. generates a structured Markdown report with all required sections", () => {
    const node = makeParsedNode("calculateTotal", [makeSmell("untyped-signature")]);
    const file = makeFileParseResult("src/math.ts", [node]);
    const valResult = makeValidationResult({ targetFile: "src/math.ts" });

    const report = generateReport({
      parseResults: [file],
      validationResults: [valResult],
      processingTimeMs: 45,
    });

    const md = generateMarkdownReport(report);

    expect(md).toContain("# Agentic Code Refactor Report");
    expect(md).toContain("## Project Summary");
    expect(md).toContain("## Architecture Execution Summary");
    expect(md).toContain("## Technical Debt");
    expect(md).toContain("## Token Optimization");
    expect(md).toContain("## Refactoring Strategy Distribution");
    expect(md).toContain("## Validation Results");
    expect(md).toContain("## Compiler Diagnostics");
    expect(md).toContain("## Individual Refactoring Results");
    expect(md).toContain("## Unresolved Issues");
    expect(md).toContain("Syntax Validation");
    expect(md).toContain("PASS");
  });

  // 3. Smell count calculations
  it("3. calculates exact before, after, fixed, and remaining smell counts", () => {
    const smells = [
      makeSmell("var-usage"),
      makeSmell("var-usage"),
      makeSmell("untyped-signature"),
    ];
    const node = makeParsedNode("multiSmell", smells);
    const file = makeFileParseResult("src/multi.ts", [node]);

    const valResult = makeValidationResult({
      targetFile: "src/multi.ts",
      beforeSmells: smells,
      afterSmells: [makeSmell("untyped-signature")],
      fixedSmells: [makeSmell("var-usage"), makeSmell("var-usage")],
      beforeSmellCount: 3,
      afterSmellCount: 1,
      fixedSmellCount: 2,
    });

    const report = generateReport({
      parseResults: [file],
      validationResults: [valResult],
    });

    expect(report.technicalDebt.beforeSmellCount).toBe(3);
    expect(report.technicalDebt.afterSmellCount).toBe(1);
    expect(report.technicalDebt.fixedSmellCount).toBe(2);
    expect(report.technicalDebt.smellReductionPercentage).toBe(66.67);
  });

  // 4. Smell reduction percentage
  it("4. accurately calculates smell reduction percentage including edge cases and regressions", () => {
    // Normal reduction
    expect(calculateSmellReductionPercentage(10, 2)).toBe(80);
    expect(calculateSmellReductionPercentage(4, 0)).toBe(100);

    // Zero baseline
    expect(calculateSmellReductionPercentage(0, 0)).toBe(0);

    // Negative reduction (debt increased) — must not claim success
    expect(calculateSmellReductionPercentage(5, 7)).toBe(-40);
    expect(calculateSmellReductionPercentage(0, 2)).toBe(-100);
  });

  // 5. Token reduction percentage
  it("5. accurately calculates token reduction percentage and prevents false positive claims", () => {
    // Normal reduction
    expect(calculateTokenReductionPercentage(4000, 1200)).toBe(70);
    expect(calculateTokenReductionPercentage(100, 25)).toBe(75);

    // Zero baseline
    expect(calculateTokenReductionPercentage(0, 0)).toBe(0);

    // Negative reduction (context expanded)
    expect(calculateTokenReductionPercentage(1000, 1250)).toBe(-25);

    // Null/undefined inputs return null
    expect(calculateTokenReductionPercentage(null, 100)).toBeNull();
    expect(calculateTokenReductionPercentage(100, null)).toBeNull();
  });

  // 6. Zero-smell projects
  it("6. correctly handles clean zero-smell projects without fabricating metrics", () => {
    const node = makeParsedNode("cleanFn", []);
    const file = makeFileParseResult("src/clean.ts", [node]);

    const report = generateReport({
      parseResults: [file],
      tasks: [],
      validationResults: [],
    });

    expect(report.technicalDebt.beforeSmellCount).toBe(0);
    expect(report.technicalDebt.afterSmellCount).toBe(0);
    expect(report.technicalDebt.fixedSmellCount).toBe(0);
    expect(report.technicalDebt.smellReductionPercentage).toBe(0);
    expect(report.tokenOptimization.estimatedOriginalTokens).toBeNull();
    expect(report.executionSummary.overallExecutionStatus).toBe("no-op");
  });

  // 7. Missing metrics
  it("7. marks missing metrics as null or unavailable without generating fake values", () => {
    const node = makeParsedNode("unmeasuredFn", [makeSmell("var-usage")]);
    const file = makeFileParseResult("src/unmeasured.ts", [node]);

    // Omit TokenMetrics
    const valResult = makeValidationResult({
      targetFile: "src/unmeasured.ts",
      tokenMetrics: undefined,
    });

    const report = generateReport({
      parseResults: [file],
      validationResults: [valResult],
    });

    expect(report.tokenOptimization.estimatedOriginalTokens).toBeNull();
    expect(report.tokenOptimization.estimatedOptimizedTokens).toBeNull();
    expect(report.tokenOptimization.tokenReductionPercentage).toBeNull();

    const md = generateMarkdownReport(report);
    expect(md).toContain("Unavailable");
  });

  // 8. Rejected transformations
  it("8. records rejected transformations and their diagnostic reasons in summary", () => {
    const acceptedVal = makeValidationResult({
      targetFile: "src/good.ts",
      valid: true,
      fixedSmellCount: 1,
    });
    const rejectedVal = makeValidationResult({
      targetFile: "src/bad.ts",
      valid: false,
      syntaxValid: false,
      error: "SyntaxError: Unexpected token",
      fixedSmellCount: 0,
      fixedSmells: [],
    });

    const report = generateReport({
      validationResults: [acceptedVal, rejectedVal],
    });

    expect(report.validation.acceptedTransformations).toBe(1);
    expect(report.validation.rejectedTransformations).toBe(1);
    expect(report.validation.syntaxValid).toBe(false);
    expect(report.executionSummary.overallExecutionStatus).toBe("partial");
    expect(report.validation.rejectedReasons).toHaveLength(1);
    expect(report.validation.rejectedReasons[0].reason).toContain("Unexpected token");
    expect(report.unresolvedIssues.some((issue) => issue.includes("Unexpected token"))).toBe(true);
  });

  // 9. Invalid transformations not written
  it("9. ensures invalid/rejected transformations are never written to disk", async () => {
    const report = generateReport({
      validationResults: [
        makeValidationResult({ targetFile: "src/good.ts", valid: true }),
        makeValidationResult({ targetFile: "src/bad.ts", valid: false }),
      ],
    });

    const fileEntries = [
      { filePath: "src/good.ts", content: "const good = 1;", valid: true },
      { filePath: "src/bad.ts", content: "invalid syntax ++", valid: false },
    ];

    const writeResult = await writeArtifacts(report, fileEntries, {
      outputDir: tempDir,
      overwrite: true,
    });

    expect(writeResult.refactoredFiles.some((f) => f.includes("good.ts"))).toBe(true);
    expect(writeResult.refactoredFiles.some((f) => f.includes("bad.ts"))).toBe(false);
    expect(writeResult.skippedFiles).toContain("src/bad.ts");
    expect(fs.existsSync(path.join(tempDir, "refactored", "src", "bad.ts"))).toBe(false);
  });

  // 10. Output directory creation
  it("10. automatically creates non-existent output directory structure", async () => {
    const nestedOutputDir = path.join(tempDir, "nested", "reports", "run-1");
    const report = generateReport({});

    expect(fs.existsSync(nestedOutputDir)).toBe(false);

    await writeArtifacts(report, [], { outputDir: nestedOutputDir });

    expect(fs.existsSync(nestedOutputDir)).toBe(true);
    expect(fs.existsSync(path.join(nestedOutputDir, "report.json"))).toBe(true);
    expect(fs.existsSync(path.join(nestedOutputDir, "report.md"))).toBe(true);
  });

  // 11. Existing files not overwritten by default
  it("11. prevents overwriting existing artifacts unless explicit overwrite option is provided", async () => {
    const report = generateReport({});

    // First write succeeds
    await writeArtifacts(report, [], { outputDir: tempDir });

    // Second write without overwrite flag must throw FileExistsError
    await expect(writeArtifacts(report, [], { outputDir: tempDir })).rejects.toThrow(
      FileExistsError,
    );

    // Write with overwrite: true succeeds
    await expect(
      writeArtifacts(report, [], { outputDir: tempDir, overwrite: true }),
    ).resolves.toBeDefined();
  });

  // 12. Relative path preservation
  it("12. preserves relative folder structure inside refactored artifacts directory", async () => {
    const report = generateReport({
      projectRoot: tempDir,
    });

    const fileEntries = [
      {
        filePath: "src/controllers/userController.ts",
        content: "export const user = {};",
        valid: true,
      },
      {
        filePath: "src/utils/math/algebra.ts",
        content: "export const add = (a: number, b: number) => a + b;",
        valid: true,
      },
    ];

    await writeArtifacts(report, fileEntries, { outputDir: tempDir });

    const dest1 = path.join(tempDir, "refactored", "src", "controllers", "userController.ts");
    const dest2 = path.join(tempDir, "refactored", "src", "utils", "math", "algebra.ts");

    expect(fs.existsSync(dest1)).toBe(true);
    expect(fs.existsSync(dest2)).toBe(true);
    expect(fs.readFileSync(dest1, "utf-8")).toBe("export const user = {};");
  });

  // 13. Path traversal prevention
  it("13. prevents directory traversal attacks and rejects paths escaping outputDir", async () => {
    const report = generateReport({});

    expect(() => assertSafeOutputPath(tempDir, path.join(tempDir, "../../../evil.ts"))).toThrow(
      PathTraversalError,
    );

    const maliciousEntries = [
      {
        filePath: "../../outside.ts",
        content: "malicious payload",
        valid: true,
      },
    ];

    await expect(
      writeArtifacts(report, maliciousEntries, { outputDir: tempDir }),
    ).rejects.toThrow(PathTraversalError);
  });

  // 14. Report generation with no LLM key
  it("14. completes mechanical refactoring and report generation with zero LLM API keys", async () => {
    // Delete any existing LLM key in environment for this test
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await runRefactoringPipeline({
        projectRoot: "./test-target",
        mechanicalOnly: true,
        outputDir: path.join(tempDir, "artifacts"),
        overwrite: true,
      });

      expect(result.report).toBeDefined();
      expect(result.report.refactoringActivity.mechanicalTransformations).toBeGreaterThanOrEqual(1);
      expect(result.report.refactoringActivity.llmTransformations).toBe(0);
      expect(result.report.executionSummary.overallExecutionStatus).toBe("success");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  // 15. Report generation with partial pipeline results
  it("15. successfully creates valid reports from partial pipeline results", () => {
    const file = makeFileParseResult("src/partial.ts", [
      makeParsedNode("fnA", [makeSmell("var-usage")]),
    ]);

    // Only Stages 1 & 2 results passed; Stages 3–6 omitted
    const report = generateReport({
      parseResults: [file],
    });

    expect(report.project.filesAnalyzed).toBe(1);
    expect(report.technicalDebt.beforeSmellCount).toBe(1);
    expect(report.tokenOptimization.estimatedOriginalTokens).toBeNull();
    expect(report.validation.acceptedTransformations).toBe(0);
    expect(report.executionSummary.overallExecutionStatus).toBe("no-op");
  });

  // 16. Report values derived from actual data
  it("16. ensures all report metrics are derived from actual stage outputs without hardcoding", () => {
    const customMetrics = {
      originalCharacters: 3456,
      optimizedCharacters: 1234,
      estimatedOriginalTokens: 864,
      estimatedOptimizedTokens: 308,
      estimatedTokenSavings: 556,
      tokenReductionPercentage: 64.35,
    };

    const valResult = makeValidationResult({
      beforeSmellCount: 4,
      afterSmellCount: 1,
      fixedSmellCount: 3,
      tokenMetrics: customMetrics,
    });

    const report = generateReport({
      validationResults: [valResult],
      processingTimeMs: 88,
    });

    expect(report.tokenOptimization.originalContextCharacters).toBe(3456);
    expect(report.tokenOptimization.optimizedContextCharacters).toBe(1234);
    expect(report.tokenOptimization.estimatedOriginalTokens).toBe(864);
    expect(report.tokenOptimization.estimatedOptimizedTokens).toBe(308);
    expect(report.tokenOptimization.estimatedTokensSaved).toBe(556);
    expect(report.tokenOptimization.tokenReductionPercentage).toBe(64.35);
    expect(report.technicalDebt.fixedSmellCount).toBe(3);
    expect(report.executionSummary.processingTimeMs).toBe(88);
  });
});
