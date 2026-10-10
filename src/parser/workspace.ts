/**
 * Stage 1: Workspace Ingestion Layer
 *
 * Discovers TypeScript source files, validates repository structure,
 * filters test/build artifacts, and builds an in-memory ts-morph virtual Project
 * without modifying any files on disk.
 */
import fs from "node:fs";
import path from "node:path";
import {
  Project,
  ScriptTarget,
  ModuleKind,
  ModuleResolutionKind,
} from "ts-morph";
import { normalizePath } from "./dependencyGraph.js";
import type {
  WorkspaceFile,
  WorkspaceResult,
  WorkspaceIngestOptions,
} from "../types/workspace.types.js";

export type { WorkspaceFile, WorkspaceResult, WorkspaceIngestOptions };

/**
 * Standard directories excluded from ingestion to prevent scanning
 * dependencies, build outputs, version control internals, and test suites.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = Object.freeze([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "test",
  "tests",
  "__tests__",
]);

/**
 * Custom error class for workspace ingestion failures.
 */
export class WorkspaceIngestionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "WorkspaceIngestionError";
  }
}

/**
 * Checks whether a directory name matches the exclusion list.
 */
export function isExcludedDirectory(dirName: string, additionalDirs: string[] = []): boolean {
  const lower = dirName.toLowerCase();
  if (DEFAULT_EXCLUDED_DIRECTORIES.includes(lower)) {
    return true;
  }
  return additionalDirs.some((d) => d.toLowerCase() === lower);
}

/**
 * Checks whether a file name matches test or spec patterns.
 * Excludes *.test.ts, *.test.tsx, *.spec.ts, *.spec.tsx, and js equivalents.
 */
export function isTestOrSpecFile(fileName: string): boolean {
  return /(^|\.)(test|spec)\.[jt]sx?$/i.test(fileName);
}

/**
 * Creates an in-memory ts-morph Project, preserving tsconfig compiler options
 * when available, or supplying standard modern defaults when no tsconfig exists.
 */
export function createWorkspaceProject(tsConfigFilePath?: string): Project {
  if (tsConfigFilePath) {
    try {
      return new Project({
        tsConfigFilePath,
        skipAddingFilesFromTsConfig: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WorkspaceIngestionError(
        `Failed to load TypeScript configuration at "${tsConfigFilePath}": ${msg}`,
        err,
      );
    }
  }

  return new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      allowJs: true,
      checkJs: false,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });
}

function validateProjectRoot(projectRoot: string): string {
  if (!projectRoot || typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new WorkspaceIngestionError("Project directory path must be a non-empty string.");
  }

  const resolved = path.resolve(projectRoot);
  if (!fs.existsSync(resolved)) {
    throw new WorkspaceIngestionError(`Project directory does not exist: "${normalizePath(resolved)}"`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new WorkspaceIngestionError(`Project path is not a directory: "${normalizePath(resolved)}"`);
  }

  return normalizePath(resolved);
}

function resolveTsConfigPath(resolvedRoot: string, options?: WorkspaceIngestOptions): string | undefined {
  if (options?.skipTsConfig) {
    return undefined;
  }

  if (options?.tsConfigFilePath) {
    const customPath = path.resolve(options.tsConfigFilePath);
    if (!fs.existsSync(customPath)) {
      throw new WorkspaceIngestionError(
        `Specified tsconfig file does not exist: "${normalizePath(customPath)}"`,
      );
    }
    return normalizePath(customPath);
  }

  const defaultTsConfig = path.join(resolvedRoot, "tsconfig.json");
  if (fs.existsSync(defaultTsConfig)) {
    return normalizePath(defaultTsConfig);
  }

  return undefined;
}

function resolveAllowedExtensions(
  project: Project,
  hasTsConfig: boolean,
  options?: WorkspaceIngestOptions,
): Set<string> {
  if (options?.extensions && options.extensions.length > 0) {
    return new Set(
      options.extensions.map((ext) =>
        ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
      ),
    );
  }

  const extensions = new Set<string>([".ts", ".tsx"]);

  let includeJs = options?.includeJs;
  if (includeJs === undefined) {
    if (hasTsConfig) {
      includeJs = Boolean(project.getCompilerOptions().allowJs);
    } else {
      includeJs = false;
    }
  }

  if (includeJs) {
    extensions.add(".js");
    extensions.add(".jsx");
  }

  return extensions;
}

async function discoverFilesAsync(
  dir: string,
  root: string,
  allowedExtensions: Set<string>,
  excludedDirs: string[],
  collected: WorkspaceFile[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceIngestionError(`Failed to read directory "${normalizePath(dir)}": ${msg}`, err);
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.promises.stat(fullPath);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }

    if (isDir) {
      if (isExcludedDirectory(entry.name, excludedDirs)) {
        continue;
      }
      await discoverFilesAsync(fullPath, root, allowedExtensions, excludedDirs, collected);
    } else if (isFile) {
      if (isTestOrSpecFile(entry.name)) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) {
        continue;
      }

      let sourceText: string;
      try {
        sourceText = await fs.promises.readFile(fullPath, "utf-8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new WorkspaceIngestionError(
          `Failed to read source file "${normalizePath(fullPath)}": ${msg}`,
          err,
        );
      }

      const normalizedAbs = normalizePath(path.resolve(fullPath));
      const normalizedRel = normalizePath(path.relative(root, fullPath));

      collected.push({
        absolutePath: normalizedAbs,
        relativePath: normalizedRel,
        sourceText,
      });
    }
  }
}

function discoverFilesSync(
  dir: string,
  root: string,
  allowedExtensions: Set<string>,
  excludedDirs: string[],
  collected: WorkspaceFile[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceIngestionError(`Failed to read directory "${normalizePath(dir)}": ${msg}`, err);
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(fullPath);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }

    if (isDir) {
      if (isExcludedDirectory(entry.name, excludedDirs)) {
        continue;
      }
      discoverFilesSync(fullPath, root, allowedExtensions, excludedDirs, collected);
    } else if (isFile) {
      if (isTestOrSpecFile(entry.name)) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) {
        continue;
      }

      let sourceText: string;
      try {
        sourceText = fs.readFileSync(fullPath, "utf-8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new WorkspaceIngestionError(
          `Failed to read source file "${normalizePath(fullPath)}": ${msg}`,
          err,
        );
      }

      const normalizedAbs = normalizePath(path.resolve(fullPath));
      const normalizedRel = normalizePath(path.relative(root, fullPath));

      collected.push({
        absolutePath: normalizedAbs,
        relativePath: normalizedRel,
        sourceText,
      });
    }
  }
}

/**
 * Asynchronously ingests a TypeScript project into an in-memory virtual workspace.
 *
 * @param projectRoot Absolute or relative path to the project root directory
 * @param options Ingestion configuration options
 * @returns Fully populated WorkspaceResult with in-memory ts-morph Project
 */
export async function ingestWorkspace(
  projectRoot: string,
  options?: WorkspaceIngestOptions,
): Promise<WorkspaceResult> {
  const normalizedRoot = validateProjectRoot(projectRoot);
  const tsConfigPath = resolveTsConfigPath(normalizedRoot, options);
  const project = createWorkspaceProject(tsConfigPath);
  const allowedExtensions = resolveAllowedExtensions(project, Boolean(tsConfigPath), options);
  const additionalDirs = options?.additionalExcludeDirs ?? [];

  const files: WorkspaceFile[] = [];
  await discoverFilesAsync(normalizedRoot, normalizedRoot, allowedExtensions, additionalDirs, files);

  // Deterministic sorting across different file systems
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  for (const file of files) {
    project.createSourceFile(file.absolutePath, file.sourceText, { overwrite: true });
  }

  const totalCharacters = files.reduce((acc, f) => acc + f.sourceText.length, 0);

  return {
    projectRoot: normalizedRoot,
    files,
    fileCount: files.length,
    totalCharacters,
    project,
    tsConfigFilePath: tsConfigPath,
    excludedDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES, ...additionalDirs],
  };
}

/**
 * Synchronous variant of ingestWorkspace.
 */
export function ingestWorkspaceSync(
  projectRoot: string,
  options?: WorkspaceIngestOptions,
): WorkspaceResult {
  const normalizedRoot = validateProjectRoot(projectRoot);
  const tsConfigPath = resolveTsConfigPath(normalizedRoot, options);
  const project = createWorkspaceProject(tsConfigPath);
  const allowedExtensions = resolveAllowedExtensions(project, Boolean(tsConfigPath), options);
  const additionalDirs = options?.additionalExcludeDirs ?? [];

  const files: WorkspaceFile[] = [];
  discoverFilesSync(normalizedRoot, normalizedRoot, allowedExtensions, additionalDirs, files);

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  for (const file of files) {
    project.createSourceFile(file.absolutePath, file.sourceText, { overwrite: true });
  }

  const totalCharacters = files.reduce((acc, f) => acc + f.sourceText.length, 0);

  return {
    projectRoot: normalizedRoot,
    files,
    fileCount: files.length,
    totalCharacters,
    project,
    tsConfigFilePath: tsConfigPath,
    excludedDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES, ...additionalDirs],
  };
}
