/**
 * Lints a file via ESLint's own Node API (not a shelled-out `eslint` CLI
 * process) — faster, typed, and doesn't depend on the target project
 * having its own ESLint config on disk. A small built-in ruleset is used
 * as a fallback (flat-config style, since ESLint v9's API dropped the
 * legacy useEslintrc/overrideConfig shape this project would otherwise
 * need) so this works even against a bare legacy codebase like
 * test-target/, which has no ESLint config of its own.
 */
import { ESLint } from "eslint";
import type { LintViolation, StageResult } from "../types/verification.types.js";

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
    overrideConfigFile: true, // ignore any config file on disk — use only what's passed below
    overrideConfig: [{ rules: FALLBACK_RULES }],
  });

  const results = await eslint.lintFiles([filePath]);
  const fileResult = results.find((r) => r.filePath === filePath) ?? results[0];

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