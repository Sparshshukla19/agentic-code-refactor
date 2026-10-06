/**
 * Simple-git wrapper: branches, commits, and status checks. Scoped to
 * local-only operations per the locked project scope — no GitHub PR
 * creation, just a branch + commits a human can review and push manually.
 */
// Named import deliberately, not the default export — simple-git ships
// both, and the default export's type resolution is ambiguous under this
// project's NodeNext module resolution (produced a real "not callable"
// type error). The named export sidesteps that entirely.
import { simpleGit, type SimpleGit } from "simple-git";

export function getGit(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const status = await getGit(cwd).status();
  return status.current ?? "HEAD";
}

/** Creates and checks out a new branch named agent/refactor-<timestamp>, returning its name. */
export async function createRefactorBranch(cwd: string, label?: string): Promise<string> {
  const branchName = `agent/refactor-${Date.now()}${label ? `-${label}` : ""}`;
  await getGit(cwd).checkoutLocalBranch(branchName);
  return branchName;
}

/** Stages and commits a single file, returning the new commit's hash. */
export async function commitFile(cwd: string, filePath: string, message: string): Promise<string> {
  const git = getGit(cwd);
  await git.add(filePath);
  const result = await git.commit(message);
  return result.commit;
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const status = await getGit(cwd).status();
  return !status.isClean();
}