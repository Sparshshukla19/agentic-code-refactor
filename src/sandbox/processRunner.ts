/**
 * Isolated child_process execution harness with timeouts. Used by
 * testRunner.ts (and anything else that needs to shell out to an external
 * CLI tool) rather than each caller reinventing spawn/timeout/collect
 * logic independently.
 */
import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Runs a command to completion, collecting stdout/stderr. If it hasn't
 * exited within timeoutMs, it's killed and timedOut is set true rather
 * than letting one hung subprocess (a test suite stuck on an infinite
 * loop, say) stall the whole pipeline indefinitely.
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}