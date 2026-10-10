/**
 * Diagnostic: runs testRunner against test-target and prints exactly what
 * came back, instead of just pass/fail. Use when `npm test` reports a
 * testRunner failure and you need the underlying error.
 *
 * Usage: npx tsx scripts/debugTestRunner.ts
 */
import path from "node:path";
import fs from "node:fs";
import { runTests } from "../src/sandbox/testRunner.js";

const cwd = path.resolve("test-target");
console.log("platform:", process.platform);
console.log("node:", process.version);
console.log("cwd:", cwd);
console.log("jest installed in test-target:", fs.existsSync(path.join(cwd, "node_modules", "jest")));

const result = await runTests({ cwd });
console.log("\npassed:", result.passed);
console.log("exitCode:", result.exitCode);
console.log("failures:", result.failures?.length);
console.log("rawOutput:\n" + result.rawOutput);