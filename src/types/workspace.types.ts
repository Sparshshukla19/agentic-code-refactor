/**
 * Types describing the in-memory workspace and ingested project metadata.
 * Produced by Stage 1 (src/parser/workspace.ts) and consumed by Stage 2 AST parser.
 */
import type { Project } from "ts-morph";

export interface WorkspaceFile {
  absolutePath: string;
  relativePath: string;
  sourceText: string;
}

export interface WorkspaceResult {
  projectRoot: string;
  files: WorkspaceFile[];
  fileCount: number;
  totalCharacters: number;
  project: Project;
  tsConfigFilePath?: string;
  excludedDirectories: string[];
}

export interface WorkspaceIngestOptions {
  /**
   * Whether to include .js and .jsx files.
   * If undefined, automatically detected from tsconfig.json allowJs (defaults to false if no tsconfig).
   */
  includeJs?: boolean;

  /**
   * Path to tsconfig.json file.
   * Defaults to looking for tsconfig.json directly in projectRoot.
   */
  tsConfigFilePath?: string;

  /**
   * If true, ignores any existing tsconfig.json and initializes a default in-memory project.
   */
  skipTsConfig?: boolean;

  /**
   * Additional directory names to exclude during discovery.
   */
  additionalExcludeDirs?: string[];

  /**
   * Custom file extension list to include (e.g. [".ts", ".tsx"]).
   * If supplied, overrides default extension resolution.
   */
  extensions?: string[];
}
