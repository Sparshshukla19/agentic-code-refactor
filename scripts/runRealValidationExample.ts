import path from "node:path";
import { ingestWorkspace } from "../src/parser/workspace.js";
import { analyzeWorkspace } from "../src/parser/astEngine.js";
import { buildOptimizedPayload } from "../src/planner/contextSlicer.js";
import { routeAndRefactor } from "../src/refactor/refactoringRouter.js";
import { validateRefactoring } from "../src/validation/validator.js";

async function main() {
  const targetDir = path.resolve("test-target");
  console.log(`Ingesting workspace from: ${targetDir}`);

  // Stage 1: Workspace Ingestion
  const workspace = await ingestWorkspace(targetDir, { includeJs: true });

  // Stage 2: AST Analysis
  const parsedFiles = analyzeWorkspace(workspace);
  const mathUtils = parsedFiles.find((f) => f.filePath.endsWith("mathUtils.js"));

  if (!mathUtils) {
    throw new Error("Could not find mathUtils.js in test-target");
  }

  // Find target node: 'add' function
  const addNode = mathUtils.nodes.find((n) => n.name === "add");
  if (!addNode) {
    throw new Error("Could not find add function in mathUtils.js");
  }

  console.log(`Found target node '${addNode.name}' with ${addNode.smells.length} smell(s):`, addNode.smells.map((s) => s.type));

  // Build Stage 4 Optimized Payload for TypeScript migration
  const payload = buildOptimizedPayload({
    targetNode: addNode,
    file: mathUtils,
    smells: addNode.smells,
  });

  // Stage 5 Refactoring: Proposed TypeScript annotated function
  const proposedTsCode = `/**\n * Adds two numbers.\n */\nfunction add(a: number, b: number): number {\n  return a + b;\n}`;
  const mockLlmResponse = {
    success: true,
    refactoredCode: proposedTsCode,
    explanation: "Added TypeScript types and explicit return type to add function",
    changes: [
      { type: "untyped-signature", description: "Annotated parameters a: number, b: number" },
      { type: "missing-return-type", description: "Annotated return type : number" },
    ],
  };

  const refactorResult = await routeAndRefactor(payload, { mockLlmResponse });

  // Stage 6 Validation: Validate proposed transformation
  const validation = await validateRefactoring(payload, refactorResult, workspace, {
    targetFile: "src/mathUtils.ts",
    fullFileContent: mathUtils.fullText,
  });

  console.log("\n==================================================");
  console.log("STAGE 6 REAL VALIDATION RUN AGAINST test-target");
  console.log("==================================================");
  console.log("Original code:\n" + validation.originalCode);
  console.log("\nProposed code:\n" + validation.refactoredCode);
  console.log("\nSyntax validation:", validation.syntaxValid ? "PASS" : "FAIL");
  console.log("Type validation:", validation.typeSafe ? "PASS" : "FAIL");
  console.log("Trivia validation:", validation.triviaPreserved ? "PASS" : "FAIL");
  console.log("AST reconciliation:", validation.astReconciled ? "PASS" : "FAIL");
  console.log("Before smell count:", validation.beforeSmellCount);
  console.log("After smell count:", validation.afterSmellCount);
  console.log("Fixed smell count:", validation.fixedSmellCount);
  console.log("Remaining smell count:", validation.remainingSmellCount);
  console.log("Smell reduction percentage:", `${validation.smellReductionPercentage}%`);
  console.log("Final validation status:", validation.valid ? "VALID" : "REJECTED");
  console.log("Strategy:", validation.strategy);
  console.log("==================================================\n");
}

main().catch((err) => {
  console.error("Error executing real validation run:", err);
  process.exit(1);
});
