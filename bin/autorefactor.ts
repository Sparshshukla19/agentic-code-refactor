#!/usr/bin/env tsx
/**
 * Executable CLI entrypoint for AutoRefactor AI.
 * Wires Commander.js commands defined in src/cli/commands.ts.
 */
import { buildCli } from "../src/cli/commands.js";

const program = buildCli();
program.parse(process.argv);
