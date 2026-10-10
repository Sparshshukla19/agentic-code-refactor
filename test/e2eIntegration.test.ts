import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRefactoringPipeline } from "../src/reporting/pipelineRunner.js";
import { normalizePath } from "../src/planner/dependencyGraph.js";

describe("End-to-End Integration Audit: 7-Stage Pipeline", () => {
  let fixtureDir: string;
  let artifactsDir: string;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fixture-"));
    artifactsDir = path.join(fixtureDir, "artifacts");

    // 1. Create helpers.ts
    const helpersContent = `/**
 * Adds two numeric values together.
 */
export function add(a: number, b: number): number {
  return a + b;
}
`;
    fs.writeFileSync(path.join(fixtureDir, "helpers.ts"), helpersContent, "utf-8");

    // 2. Create calculator.ts with required smell features:
    // - var usage
    // - untyped function
    // - missing return type
    // - simple import dependency
    // - documentation comment
    const calculatorContent = `import { add } from "./helpers.js";

/**
 * Calculates sum of values in an array.
 */
export function calculateSum(items) {
  var total = 0;
  for (var i = 0; i < items.length; i++) {
    total = add(total, items[i]);
  }
  return total;
}
`;
    fs.writeFileSync(path.join(fixtureDir, "calculator.ts"), calculatorContent, "utf-8");
  });

  afterEach(() => {
    if (fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("executes Stages 1–7 end-to-end with mechanical refactoring without altering original sources", async () => {
    const origCalcContent = fs.readFileSync(path.join(fixtureDir, "calculator.ts"), "utf-8");
    const origHelpersContent = fs.readFileSync(path.join(fixtureDir, "helpers.ts"), "utf-8");

    const result = await runRefactoringPipeline({
      projectRoot: fixtureDir,
      mechanicalOnly: true,
      outputDir: artifactsDir,
      overwrite: true,
    });

    // 1. Source files discovered
    expect(result.workspace.fileCount).toBe(2);
    expect(result.parseResults).toHaveLength(2);

    // 2. Code smells detected
    const calcParse = result.parseResults.find((f) => f.filePath.includes("calculator.ts"));
    expect(calcParse).toBeDefined();
    const detectedSmellTypes = calcParse!.nodes.flatMap((n) => n.smells.map((s) => s.type));
    expect(detectedSmellTypes).toContain("var-usage");
    expect(detectedSmellTypes).toContain("untyped-signature");
    expect(detectedSmellTypes).toContain("missing-return-type");

    // 3. Dependencies resolved
    const normalizedCalcPath = normalizePath(path.join(fixtureDir, "calculator.ts"));
    expect(result.graph.nodes.has(normalizedCalcPath)).toBe(true);
    expect(result.queue.files).toContain(normalizedCalcPath);

    // 4. Target node extracted and scheduled
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);

    // 5. Context optimization metrics measured
    expect(result.payloads.length).toBeGreaterThanOrEqual(1);
    const payload = result.payloads[0];
    expect(payload.metrics.originalCharacters).toBeGreaterThan(0);
    expect(payload.metrics.optimizedCharacters).toBeGreaterThan(0);
    expect(payload.metrics.estimatedOriginalTokens).toBeGreaterThan(0);

    // 6. Mechanical routing executed
    expect(result.refactorResults.length).toBeGreaterThanOrEqual(1);
    expect(result.refactorResults[0].strategy).toBe("mechanical");

    // 7. Validation passed
    expect(result.validationResults.length).toBeGreaterThanOrEqual(1);
    expect(result.validationResults[0].valid).toBe(true);
    expect(result.validationResults[0].syntaxValid).toBe(true);
    expect(result.validationResults[0].typeSafe).toBe(true);

    // 8. Technical debt reduced
    expect(result.report.technicalDebt.fixedSmellCount).toBeGreaterThanOrEqual(1);

    // 9. Reports generated
    expect(fs.existsSync(path.join(artifactsDir, "report.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "report.md"))).toBe(true);

    // 10. Safety: Original source files NOT modified
    expect(fs.readFileSync(path.join(fixtureDir, "calculator.ts"), "utf-8")).toBe(origCalcContent);
    expect(fs.readFileSync(path.join(fixtureDir, "helpers.ts"), "utf-8")).toBe(origHelpersContent);

    // 11. Artifact written
    const refactoredCalc = path.join(artifactsDir, "refactored", "calculator.ts");
    expect(fs.existsSync(refactoredCalc)).toBe(true);
    const refactoredContent = fs.readFileSync(refactoredCalc, "utf-8");
    expect(refactoredContent).toContain("let total = 0;");
  });

  it("executes Stages 1–7 end-to-end with mocked LLM transformation for semantic smells", async () => {
    const mockLlmResponse = {
      success: true,
      refactoredCode: `/**\n * Calculates sum of values in an array.\n */\nexport function calculateSum(items: number[]): number {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) {\n    total = add(total, items[i]);\n  }\n  return total;\n}`,
      explanation: "Added TypeScript types and modern variable declarations",
      changes: [
        { type: "untyped-signature", description: "Added parameter type items: number[]" },
        { type: "missing-return-type", description: "Added return type : number" },
        { type: "var-usage", description: "Replaced var with let" },
      ],
    };

    const result = await runRefactoringPipeline({
      projectRoot: fixtureDir,
      mechanicalOnly: false,
      mockLlmResponse,
      outputDir: artifactsDir,
      overwrite: true,
    });

    // Semantic smell routed to LLM
    expect(result.refactorResults.some((r) => r.strategy === "llm")).toBe(true);

    // Validation
    const acceptedLlm = result.validationResults.find((v) => v.strategy === "llm");
    expect(acceptedLlm).toBeDefined();
    expect(acceptedLlm!.valid).toBe(true);
    expect(acceptedLlm!.syntaxValid).toBe(true);
    expect(acceptedLlm!.typeSafe).toBe(true);
    expect(acceptedLlm!.triviaPreserved).toBe(true);

    // Smell reduction confirmed
    expect(result.report.technicalDebt.fixedSmellCount).toBeGreaterThanOrEqual(2);
    expect(result.report.refactoringActivity.llmTransformations).toBeGreaterThanOrEqual(1);

    // Validated artifact written
    const refactoredCalc = path.join(artifactsDir, "refactored", "calculator.ts");
    expect(fs.existsSync(refactoredCalc)).toBe(true);
    const content = fs.readFileSync(refactoredCalc, "utf-8");
    expect(content).toContain("items: number[]");
    expect(content).toContain(": number");
  });

  it("ensures rejected transformations are not written to output artifacts", async () => {
    // Provide a broken mock response that causes type errors
    const invalidMockLlmResponse = {
      success: true,
      refactoredCode: `export function calculateSum(items: string): boolean {\n  return items + 123;\n}`,
      explanation: "Broken transformation returning incompatible type",
      changes: [{ type: "untyped-signature", description: "Broken type" }],
    };

    const result = await runRefactoringPipeline({
      projectRoot: fixtureDir,
      mechanicalOnly: false,
      mockLlmResponse: invalidMockLlmResponse,
      outputDir: artifactsDir,
      overwrite: true,
    });

    // The invalid transformation should be rejected during validation
    const llmValidation = result.validationResults.find((v) => v.strategy === "llm");
    if (llmValidation) {
      expect(llmValidation.valid).toBe(false);
    }
    expect(result.report.validation.rejectedTransformations).toBeGreaterThanOrEqual(1);

    // Rejected content must NOT be written as the refactored output
    const refactoredCalc = path.join(artifactsDir, "refactored", "calculator.ts");
    if (fs.existsSync(refactoredCalc)) {
      const content = fs.readFileSync(refactoredCalc, "utf-8");
      expect(content).not.toContain("return items + 123;");
    }
  });
});
