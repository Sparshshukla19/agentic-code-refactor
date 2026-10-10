/**
 * End-to-End Integration Audit Script
 * Runs all 7 stages against the required temporary TypeScript fixture.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRefactoringPipeline } from "../src/reporting/pipelineRunner.js";

async function runAudit() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-audit-fixture-"));
  const artifactsDir = path.join(fixtureDir, "artifacts");

  try {
    console.log("==================================================");
    console.log("END-TO-END INTEGRATION AUDIT: 7-STAGE PIPELINE RUN");
    console.log("==================================================");
    console.log(`Temporary Fixture Directory: ${fixtureDir}`);

    // Create helpers.ts
    const helpersContent = `/**
 * Adds two numbers.
 */
export function add(a: number, b: number): number {
  return a + b;
}
`;
    fs.writeFileSync(path.join(fixtureDir, "helpers.ts"), helpersContent, "utf-8");

    // Create calculator.ts with all 5 required elements:
    // 1. var usage
    // 2. untyped function
    // 3. missing return type
    // 4. simple import dependency
    // 5. documentation comment
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

    const origCalcContent = fs.readFileSync(path.join(fixtureDir, "calculator.ts"), "utf-8");
    const origHelpersContent = fs.readFileSync(path.join(fixtureDir, "helpers.ts"), "utf-8");

    // Mock LLM response for semantic smell transformation
    const mockLlmResponse = {
      success: true,
      refactoredCode: `/**\n * Calculates sum of values in an array.\n */\nexport function calculateSum(items: number[]): number {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) {\n    total = add(total, items[i]);\n  }\n  return total;\n}`,
      explanation: "Added TypeScript types and modern variable declarations",
      changes: [
        { type: "untyped-signature", description: "Annotated items: number[]" },
        { type: "missing-return-type", description: "Annotated return type : number" },
        { type: "var-usage", description: "Replaced var with let" },
      ],
    };

    console.log("\nExecuting pipeline runner across Stages 1 through 7...");
    const result = await runRefactoringPipeline({
      projectRoot: fixtureDir,
      mockLlmResponse,
      outputDir: artifactsDir,
      overwrite: true,
    });

    console.log("\nPipeline execution completed.");
    console.log("--------------------------------------------------");
    console.log("MEASURED AUDIT METRICS:");
    console.log("--------------------------------------------------");
    console.log(`Source files analyzed:        ${result.report.project.filesAnalyzed}`);
    console.log(`Files processed:              ${result.report.project.filesProcessed}`);
    console.log(`Total source characters:      ${result.report.project.totalCharacters}`);
    console.log(`Initial code smell count:     ${result.report.technicalDebt.beforeSmellCount}`);
    console.log(`Final code smell count:       ${result.report.technicalDebt.afterSmellCount}`);
    console.log(`Fixed code smell count:       ${result.report.technicalDebt.fixedSmellCount}`);
    console.log(`Smell reduction percentage:   ${result.report.technicalDebt.smellReductionPercentage}%`);
    console.log(`Original context characters:  ${result.report.tokenOptimization.originalContextCharacters}`);
    console.log(`Optimized context characters: ${result.report.tokenOptimization.optimizedContextCharacters}`);
    console.log(`Estimated original tokens:    ~${result.report.tokenOptimization.estimatedOriginalTokens}`);
    console.log(`Estimated optimized tokens:   ~${result.report.tokenOptimization.estimatedOptimizedTokens}`);
    console.log(`Estimated tokens saved:       ~${result.report.tokenOptimization.estimatedTokensSaved}`);
    console.log(`Estimated token reduction:    ${result.report.tokenOptimization.tokenReductionPercentage}%`);
    console.log(`Targets analyzed:             ${result.report.refactoringActivity.targetsAnalyzed}`);
    console.log(`Successful transformations:   ${result.report.refactoringActivity.successfulTransformations}`);
    console.log(`Rejected transformations:     ${result.report.refactoringActivity.rejectedTransformations}`);
    console.log(`Syntax validation:            ${result.report.validation.syntaxValid ? "PASS" : "FAIL"}`);
    console.log(`Type validation:              ${result.report.validation.typeSafe ? "PASS" : "FAIL"}`);
    console.log(`Trivia preservation:          ${result.report.validation.triviaPreserved ? "PASS" : "FAIL"}`);
    console.log(`Overall execution status:     ${result.report.executionSummary.overallExecutionStatus.toUpperCase()}`);
    console.log("\nValidation diagnostics:", JSON.stringify(result.validationResults.map(v => ({ valid: v.valid, diagnostics: v.diagnostics, originalCode: v.originalCode, refactoredCode: v.refactoredCode, error: v.error })), null, 2));

    // Verify Safety
    console.log("\n--------------------------------------------------");
    console.log("SAFETY VERIFICATION:");
    console.log("--------------------------------------------------");
    const currentCalc = fs.readFileSync(path.join(fixtureDir, "calculator.ts"), "utf-8");
    const currentHelpers = fs.readFileSync(path.join(fixtureDir, "helpers.ts"), "utf-8");
    const calcUnmodified = currentCalc === origCalcContent;
    const helpersUnmodified = currentHelpers === origHelpersContent;
    console.log(`Original calculator.ts unmodified in source: ${calcUnmodified ? "YES (SAFE)" : "NO (MODIFIED!)"}`);
    console.log(`Original helpers.ts unmodified in source:    ${helpersUnmodified ? "YES (SAFE)" : "NO (MODIFIED!)"}`);

    const refactoredCalcPath = path.join(artifactsDir, "refactored", "calculator.ts");
    const refactoredCalcExists = fs.existsSync(refactoredCalcPath);
    console.log(`Refactored artifact written in artifacts/:   ${refactoredCalcExists ? "YES" : "NO"}`);
    if (refactoredCalcExists) {
      console.log("\nRefactored artifact content preview:");
      console.log(fs.readFileSync(refactoredCalcPath, "utf-8"));
    }

    console.log("\nJSON report written:     " + fs.existsSync(path.join(artifactsDir, "report.json")));
    console.log("Markdown report written: " + fs.existsSync(path.join(artifactsDir, "report.md")));
    console.log("==================================================\n");
  } finally {
    if (fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
}

runAudit().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
