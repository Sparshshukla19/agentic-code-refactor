/**
 * Stage 7: Artifact Writer Module
 *
 * Implements safe output of reports and validated TypeScript artifacts.
 *
 * Security & Integrity Guarantees:
 * - Never overwrites original source files by default.
 * - Enforces path traversal prevention to prevent writing outside the output directory.
 * - Rejects writing unvalidated or rejected transformations.
 * - Preserves relative directory structure.
 * - Prevents overwriting existing artifacts unless explicit overwrite option is provided.
 * - Supports dry-run mode for simulation without disk mutations.
 */
import fs from "node:fs";
import path from "node:path";
import type { Stage7Report } from "../types/report.types.js";
import { generateJsonReport, generateMarkdownReport } from "./reportGenerator.js";

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

export class FileExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileExistsError";
  }
}

export interface RefactoredFileEntry {
  filePath: string;
  content: string;
  valid?: boolean;
}

export interface ArtifactWriterOptions {
  outputDir?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  writeRefactoredFiles?: boolean;
  projectRoot?: string;
  originalSourceFiles?: string[];
}

export interface ArtifactWriteResult {
  outputDir: string;
  jsonReportPath: string;
  markdownReportPath: string;
  refactoredFiles: string[];
  skippedFiles: string[];
  dryRun: boolean;
}

/**
 * Validates that targetPath is contained strictly inside baseDir.
 * Throws PathTraversalError on attempts to escape baseDir.
 */
export function assertSafeOutputPath(baseDir: string, targetPath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathTraversalError(
      `Path traversal prevented: target path "${targetPath}" is outside allowed output directory "${baseDir}".`,
    );
  }
}

/**
 * Writes reports and validated refactored files to disk safely.
 */
export async function writeArtifacts(
  report: Stage7Report,
  refactoredFiles?: RefactoredFileEntry[] | Map<string, string>,
  options: ArtifactWriterOptions = {},
): Promise<ArtifactWriteResult> {
  const outputDir = path.resolve(process.cwd(), options.outputDir ?? "artifacts");
  const overwrite = options.overwrite ?? false;
  const dryRun = options.dryRun ?? false;
  const writeRefactored = options.writeRefactoredFiles ?? true;
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : path.resolve(report.project.root);

  // Prevent writing output directory inside identical original source paths if risking overwrite
  if (options.originalSourceFiles) {
    for (const orig of options.originalSourceFiles) {
      const resolvedOrig = path.resolve(orig);
      if (resolvedOrig === path.join(outputDir, "report.json") || resolvedOrig === path.join(outputDir, "report.md")) {
        throw new Error(`Refusing to overwrite original source file: "${orig}".`);
      }
    }
  }

  const jsonReportPath = path.join(outputDir, "report.json");
  const markdownReportPath = path.join(outputDir, "report.md");
  const refactoredBaseDir = path.join(outputDir, "refactored");

  assertSafeOutputPath(outputDir, jsonReportPath);
  assertSafeOutputPath(outputDir, markdownReportPath);

  // Check overwrite conflicts for report files
  if (!overwrite) {
    if (fs.existsSync(jsonReportPath)) {
      throw new FileExistsError(
        `Artifact file already exists: "${jsonReportPath}". Use --overwrite to overwrite.`,
      );
    }
    if (fs.existsSync(markdownReportPath)) {
      throw new FileExistsError(
        `Artifact file already exists: "${markdownReportPath}". Use --overwrite to overwrite.`,
      );
    }
  }

  const writtenRefactored: string[] = [];
  const skippedRefactored: string[] = [];

  // Prepare refactored files
  const fileEntries: RefactoredFileEntry[] = [];
  if (refactoredFiles) {
    if (refactoredFiles instanceof Map) {
      for (const [filePath, content] of refactoredFiles.entries()) {
        fileEntries.push({ filePath, content, valid: true });
      }
    } else if (Array.isArray(refactoredFiles)) {
      fileEntries.push(...refactoredFiles);
    }
  }

  // Pre-validate refactored file destinations
  const planToWrite: Array<{ destPath: string; content: string }> = [];

  for (const entry of fileEntries) {
    // REQUIREMENT: Do not write a rejected transformation!
    if (entry.valid === false) {
      skippedRefactored.push(entry.filePath);
      continue;
    }

    // Determine relative path preserving folder structure
    let relPath = entry.filePath;
    if (path.isAbsolute(entry.filePath)) {
      relPath = path.relative(projectRoot, entry.filePath);
    }

    // Disallow path traversal via relative filename
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      throw new PathTraversalError(
        `Path traversal prevented in refactored file path: "${entry.filePath}".`,
      );
    }

    const destPath = path.join(refactoredBaseDir, relPath);
    assertSafeOutputPath(refactoredBaseDir, destPath);

    // Never overwrite original source files
    if (path.resolve(destPath) === path.resolve(entry.filePath)) {
      throw new Error(
        `Refusing to overwrite original source file directly: "${entry.filePath}". Refactored output must target the artifact directory.`,
      );
    }

    // Check existing artifact file overwrite
    if (!overwrite && fs.existsSync(destPath)) {
      throw new FileExistsError(
        `Refactored artifact already exists: "${destPath}". Use --overwrite to replace existing artifacts.`,
      );
    }

    planToWrite.push({ destPath, content: entry.content });
  }

  if (!dryRun) {
    // 1. Create directory structure
    fs.mkdirSync(outputDir, { recursive: true });

    // 2. Write JSON report
    const jsonContent = generateJsonReport(report, true);
    fs.writeFileSync(jsonReportPath, jsonContent, "utf-8");

    // 3. Write Markdown report
    const mdContent = generateMarkdownReport(report);
    fs.writeFileSync(markdownReportPath, mdContent, "utf-8");

    // 4. Write validated refactored files
    if (writeRefactored && planToWrite.length > 0) {
      fs.mkdirSync(refactoredBaseDir, { recursive: true });
      for (const item of planToWrite) {
        fs.mkdirSync(path.dirname(item.destPath), { recursive: true });
        fs.writeFileSync(item.destPath, item.content, "utf-8");
        writtenRefactored.push(item.destPath);
      }
    }
  } else {
    // Dry-run mode: record intended writes
    for (const item of planToWrite) {
      writtenRefactored.push(item.destPath);
    }
  }

  return {
    outputDir,
    jsonReportPath,
    markdownReportPath,
    refactoredFiles: writtenRefactored,
    skippedFiles: skippedRefactored,
    dryRun,
  };
}
