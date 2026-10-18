/**
 * Lints a file via ESLint's own Node API (not a shelled-out `eslint` CLI
 * process) — faster, typed, and doesn't depend on the target project
 * having its own ESLint config on disk. A small built-in ruleset is used
 * as a fallback (flat-config style, since ESLint v9's API dropped the
 * legacy useEslintrc/overrideConfig shape this project would otherwise
 * need) so this works even against a bare legacy codebase like
 * test-target/, which has no ESLint config of its own.
 */
import path from "node:path";
import { ESLint } from "eslint";
import type { LintViolation, StageResult } from "../types/verification.types.js";
import { noCallbackDoubleCall } from "./customRules.js";

// Deliberately small and non-opinionated: this is a safety net for
// obviously bad patterns, not a full style guide. A real lint config the
// target project already has would be layered on top of this in a fuller
// implementation; for now this fallback is what keeps the stage usable
// against test-target out of the box.
const FALLBACK_RULES = {
  "no-var": "error",
  eqeqeq: "warn",
  "no-unused-vars": "warn",
} as const;

export async function lintFile(filePath: string): Promise<StageResult> {
  const eslint = new ESLint({
    // ESLint 9 silently ignores any file outside its working directory (with
    // only a warning), which made this whole stage a no-op for any target not
    // under wherever the CLI was launched. Rooting it at the file's own
    // directory means the file is always in scope.
    cwd: path.dirname(path.resolve(filePath)),
    overrideConfigFile: true, // ignore any config file on disk — use only what's passed below
    overrideConfig: [
      {
        plugins: { autorefactor: { rules: { "no-callback-double-call": noCallbackDoubleCall } } },
        rules: { ...FALLBACK_RULES, "autorefactor/no-callback-double-call": "error" },
      },
    ],
  });

  const [fileResult] = await eslint.lintFiles([filePath]);

  // ESLint reports a file it refused to lint as a rule-less warning. That must
  // not read as "clean": say it was skipped. It still doesn't BLOCK the task,
  // since otherwise every file type this config doesn't cover (.ts, .jsx)
  // would fail verification forever.
  const ignored = fileResult?.messages.find((m) => m.ruleId === null && /ignored/i.test(m.message));
  if (ignored) {
    return { stage: "lint", passed: true, skipped: true, exitCode: 0, violations: [], rawOutput: `Lint skipped: ${ignored.message}` };
  }

  const violations: LintViolation[] = (fileResult?.messages ?? []).map((m) => ({
    ruleId: m.ruleId ?? "unknown",
    message: m.message,
    filePath,
    line: m.line,
    severity: m.severity === 2 ? "error" : "warning",
  }));

  const errorCount = violations.filter((v) => v.severity === "error").length;
  const rawOutput = violations.map((v) => `${filePath}:${v.line} — [${v.severity}] ${v.ruleId}: ${v.message}`).join("\n");

  return {
    stage: "lint",
    passed: errorCount === 0, // warnings don't fail the stage, only errors do
    exitCode: errorCount === 0 ? 0 : 1,
    violations,
    rawOutput: rawOutput || "No lint violations.",
  };
}