/**
 * Runs the target project's own test suite via Jest's `--json` reporter
 * and parses the structured output into TestFailure records.
 *
 * SCOPED LIMITATION, stated honestly: this assumes the target project
 * uses Jest (true for our sample test-target/, and common for legacy JS
 * codebases) — it is not a generic multi-framework test runner. A target
 * using Vitest, Mocha, etc. would need a different parser for that tool's
 * own JSON output format, which isn't built here given the time budget.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runCommand } from "./processRunner.js";
import type { StageResult, TestFailure } from "../types/verification.types.js";

interface JestAssertionResult {
  status: "passed" | "failed" | "pending" | "skipped" | "todo";
  title: string;
  fullName: string;
  failureMessages: string[];
}

interface JestTestResult {
  name: string; // the test file's path — confirmed against real Jest --json output, NOT "testFilePath"
  assertionResults: JestAssertionResult[];
}

interface JestJsonOutput {
  success: boolean;
  testResults: JestTestResult[];
}

export interface RunTestsOptions {
  cwd: string; // the target project's root (where its package.json/node_modules live)
  testPathPattern?: string; // optional: scope to tests relevant to the changed file
  timeoutMs?: number;
}

/** Finds the target project's own Jest entry script, or undefined if Jest isn't installed. */
function resolveJestBin(cwd: string): string | undefined {
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    const pkgPath = require.resolve("jest/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.jest;
    return bin ? path.join(path.dirname(pkgPath), bin) : undefined;
  } catch {
    return undefined;
  }
}

export async function runTests(options: RunTestsOptions): Promise<StageResult> {
  const jestBin = resolveJestBin(options.cwd);
  if (!jestBin) {
    return {
      stage: "test",
      passed: false,
      exitCode: -1,
      rawOutput: `Jest not found from ${options.cwd}. Run \`npm install\` in the target project first.`,
      failures: [],
    };
  }

  const args = [jestBin, "--json"];
  if (options.testPathPattern) {
    args.push("--testPathPattern", options.testPathPattern);
  }

  // Runs Jest's own script with the current Node binary, rather than via
  // `npx`: on Windows npx is an npx.cmd shim that can't be spawned without
  // a shell, and a shell mangles arguments and changes exit-code semantics.
  const result = await runCommand(process.execPath, args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 30_000 });

  if (result.timedOut) {
    return {
      stage: "test",
      passed: false,
      exitCode: -1,
      rawOutput: "Test run timed out.",
      failures: [],
    };
  }

  let parsed: JestJsonOutput;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Jest failing to even start (e.g. a syntax error in a test file) can
    // produce non-JSON stderr output instead of the expected JSON report.
    return {
      stage: "test",
      passed: false,
      exitCode: result.exitCode,
      rawOutput: result.stderr || result.stdout || "Jest produced no parseable output.",
      failures: [],
    };
  }

  const failures: TestFailure[] = [];
  for (const fileResult of parsed.testResults) {
    for (const assertion of fileResult.assertionResults) {
      if (assertion.status === "failed") {
        failures.push({
          testName: assertion.fullName || assertion.title,
          filePath: fileResult.name,
          errorMessage: assertion.failureMessages[0] ?? "Test failed with no message.",
          stackTrace: assertion.failureMessages.join("\n\n"),
        });
      }
    }
  }

  const rawOutput = failures.map((f) => `${path.basename(f.filePath)} :: ${f.testName}\n${f.errorMessage}`).join("\n\n");

  return {
    stage: "test",
    passed: parsed.success,
    exitCode: parsed.success ? 0 : 1,
    failures,
    rawOutput: rawOutput || "All tests passed.",
  };
}