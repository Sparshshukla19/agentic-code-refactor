/**
 * Finds the source files in a target directory that are worth analyzing —
 * production JS/TS, not dependencies, build output, tests, or type stubs.
 * Test files are excluded on purpose: they're the safety net the pipeline
 * verifies against, not something it should rewrite.
 */
import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage", "__tests__"]);

function isSourceFile(fileName: string): boolean {
  if (!SOURCE_EXTENSIONS.has(path.extname(fileName))) return false;
  if (fileName.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(fileName)) return false;
  return true;
}

/** Returns absolute paths of analyzable source files under `target` (or `target` itself if it's a file). */
export function discoverFiles(target: string): string[] {
  const resolved = path.resolve(target);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];

  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (isSourceFile(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(resolved);
  return found.sort();
}