/**
 * Types for the sandboxed verification pipeline: tsc -> eslint -> jest/vitest.
 */

export interface CompilerDiagnostic {
  code: string; // e.g. "TS2345"
  message: string;
  filePath: string;
  line: number;
}

export interface LintViolation {
  ruleId: string;
  message: string;
  filePath: string;
  line: number;
  severity: "warning" | "error";
}

export interface TestFailure {
  testName: string;
  filePath: string;
  errorMessage: string;
  stackTrace: string;
}

export interface StageResult {
  stage: "typecheck" | "lint" | "test";
  passed: boolean;
  exitCode: number;
  diagnostics?: CompilerDiagnostic[];
  violations?: LintViolation[];
  failures?: TestFailure[];
  rawOutput: string;
}

export interface VerificationResult {
  taskId: string;
  stages: StageResult[];
  overallPassed: boolean;
}
