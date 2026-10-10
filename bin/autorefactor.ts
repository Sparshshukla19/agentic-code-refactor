#!/usr/bin/env tsx
/**
 * CLI entrypoint. Usage:
 *   npm run cli -- analyze <target>
 *   npm run cli -- run <target> [--no-git] [--run-tests] [--max-retries n] [--min-score n]
 *
 * dotenv is loaded BEFORE the commands module is imported, on purpose:
 * agent/llmClient.ts reads LLM_PROVIDER when it first loads, so the .env
 * file has to be in process.env by then.
 */
import "dotenv/config";

const { buildProgram } = await import("../src/cli/commands.js");
await buildProgram().parseAsync(process.argv);