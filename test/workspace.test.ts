import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ingestWorkspace,
  ingestWorkspaceSync,
  WorkspaceIngestionError,
} from "../src/parser/workspace.js";

const tempDirs: string[] = [];

function createTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-refactor-test-"));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in test teardown
    }
  }
  tempDirs.length = 0;
});

describe("Stage 1 — Workspace Ingestion", () => {
  it("1. Loads .ts files", async () => {
    const projectDir = createTempProject({
      "src/math.ts": "export function add(a: number, b: number): number { return a + b; }",
      "src/index.ts": "export * from './math';",
    });

    const result = await ingestWorkspace(projectDir);
    const relativePaths = result.files.map((f) => f.relativePath);

    expect(relativePaths).toContain("src/index.ts");
    expect(relativePaths).toContain("src/math.ts");
    expect(result.fileCount).toBe(2);
  });

  it("2. Loads .tsx files", async () => {
    const projectDir = createTempProject({
      "src/Button.tsx": "export const Button = () => <button>Click</button>;",
      "src/App.tsx": "import { Button } from './Button'; export const App = () => <div><Button /></div>;",
    });

    const result = await ingestWorkspace(projectDir);
    const relativePaths = result.files.map((f) => f.relativePath);

    expect(relativePaths).toContain("src/App.tsx");
    expect(relativePaths).toContain("src/Button.tsx");
    expect(result.fileCount).toBe(2);
  });

  it("3. Excludes node_modules", async () => {
    const projectDir = createTempProject({
      "src/index.ts": "export const ok = true;",
      "node_modules/pkg/index.ts": "export const bad = true;",
      "node_modules/@types/pkg/index.d.ts": "export declare const bad2: boolean;",
    });

    const result = await ingestWorkspace(projectDir);
    const relativePaths = result.files.map((f) => f.relativePath);

    expect(relativePaths).toEqual(["src/index.ts"]);
    expect(result.files.some((f) => f.relativePath.includes("node_modules"))).toBe(false);
  });

  it("4. Excludes test files (*.test.ts, *.test.tsx, *.spec.ts, *.spec.tsx, __tests__, test, tests)", async () => {
    const projectDir = createTempProject({
      "src/service.ts": "export class Service {}",
      "src/service.test.ts": "describe('service', () => {});",
      "src/service.spec.ts": "describe('service', () => {});",
      "src/component.test.tsx": "describe('component', () => {});",
      "src/component.spec.tsx": "describe('component', () => {});",
      "src/__tests__/helper.ts": "export function setup() {}",
      "test/integration.ts": "export function run() {}",
      "tests/e2e.ts": "export function e2e() {}",
    });

    const result = await ingestWorkspace(projectDir);
    const relativePaths = result.files.map((f) => f.relativePath);

    expect(relativePaths).toEqual(["src/service.ts"]);
    expect(result.fileCount).toBe(1);
  });

  it("5. Excludes dist, build, coverage, and .git directories", async () => {
    const projectDir = createTempProject({
      "src/main.ts": "console.log('main');",
      "dist/main.ts": "console.log('dist');",
      "build/main.ts": "console.log('build');",
      "coverage/lcov-report/index.ts": "console.log('coverage');",
      ".git/hooks/pre-commit.ts": "console.log('git');",
    });

    const result = await ingestWorkspace(projectDir);
    const relativePaths = result.files.map((f) => f.relativePath);

    expect(relativePaths).toEqual(["src/main.ts"]);
    expect(result.fileCount).toBe(1);
  });

  it("6. Preserves relative paths with consistent forward slash normalization", async () => {
    const projectDir = createTempProject({
      "src/nested/deep/module.ts": "export const deep = true;",
      "lib/utils/string.ts": "export const str = 'ok';",
    });

    const result = await ingestWorkspace(projectDir);
    const relativePaths = result.files.map((f) => f.relativePath);

    expect(relativePaths).toContain("lib/utils/string.ts");
    expect(relativePaths).toContain("src/nested/deep/module.ts");
    expect(relativePaths.every((p) => !p.includes("\\"))).toBe(true);
  });

  it("7. Preserves source text exactly without modification", async () => {
    const rawCode = `/**
 * Complex banner comment
 * @author Test
 */
export function calculate(val: number): number {
  // Inline comment
  const x = "Unicode 🚀 ✨";
  return val * 42;
}
`;
    const projectDir = createTempProject({
      "src/calculate.ts": rawCode,
    });

    const result = await ingestWorkspace(projectDir);
    const file = result.files.find((f) => f.relativePath === "src/calculate.ts");

    expect(file).toBeDefined();
    expect(file?.sourceText).toBe(rawCode);
  });

  it("8. Correctly counts files", async () => {
    const projectDir = createTempProject({
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;",
      "src/c.ts": "export const c = 3;",
      "src/d.tsx": "export const d = 4;",
    });

    const result = await ingestWorkspace(projectDir);

    expect(result.fileCount).toBe(4);
    expect(result.files.length).toBe(4);
  });

  it("9. Correctly calculates total characters across all ingested source files", async () => {
    const codeA = "const a = 1;";
    const codeB = "function b() { return 2; }";
    const codeC = "export const c = 3;";

    const projectDir = createTempProject({
      "src/a.ts": codeA,
      "src/b.ts": codeB,
      "src/c.ts": codeC,
    });

    const result = await ingestWorkspace(projectDir);
    const expectedTotal = codeA.length + codeB.length + codeC.length;

    expect(result.totalCharacters).toBe(expectedTotal);
  });

  it("10. Creates a valid ts-morph Project with queryable AST nodes", async () => {
    const projectDir = createTempProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext" },
      }),
      "src/user.ts": `
        export interface User {
          id: string;
          name: string;
        }
        export function getUser(id: string): User {
          return { id, name: "Alice" };
        }
      `,
    });

    const result = await ingestWorkspace(projectDir);
    expect(result.project).toBeDefined();

    const sourceFiles = result.project.getSourceFiles();
    expect(sourceFiles.length).toBe(1);

    const sf = sourceFiles[0];
    const interfaces = sf.getInterfaces();
    expect(interfaces.map((i) => i.getName())).toEqual(["User"]);

    const functions = sf.getFunctions();
    expect(functions.map((f) => f.getName())).toEqual(["getUser"]);
  });

  it("11. Handles a missing project directory with a descriptive error", async () => {
    const nonExistentPath = path.join(os.tmpdir(), "non_existent_workspace_xyz_98765");

    await expect(ingestWorkspace(nonExistentPath)).rejects.toThrowError(
      WorkspaceIngestionError,
    );
    await expect(ingestWorkspace(nonExistentPath)).rejects.toThrowError(
      /Project directory does not exist/,
    );
  });

  it("12. Handles a project without tsconfig.json gracefully", async () => {
    const projectDir = createTempProject({
      "src/fallback.ts": "export const fallback = 100;",
    });

    const result = await ingestWorkspace(projectDir);

    expect(result.tsConfigFilePath).toBeUndefined();
    expect(result.fileCount).toBe(1);
    expect(result.files[0].relativePath).toBe("src/fallback.ts");

    const sf = result.project.getSourceFile(result.files[0].absolutePath);
    expect(sf).toBeDefined();
    expect(sf?.getText()).toContain("export const fallback = 100;");
  });

  it("13. Handles an empty project directory without errors", async () => {
    const projectDir = createTempProject({});

    const result = await ingestWorkspace(projectDir);

    expect(result.fileCount).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.totalCharacters).toBe(0);
    expect(result.project.getSourceFiles()).toEqual([]);
  });

  it("14. Ingests the sample test-target directory properly", async () => {
    const result = await ingestWorkspace("test-target");

    expect(result.fileCount).toBe(3);
    const relativePaths = result.files.map((f) => f.relativePath);
    expect(relativePaths).toEqual([
      "src/legacyCallback.js",
      "src/mathUtils.js",
      "src/userController.js",
    ]);
    expect(result.totalCharacters).toBe(2035);
    expect(result.tsConfigFilePath).toBeDefined();

    const mathFile = result.project.getSourceFile(result.files[1].absolutePath);
    expect(mathFile).toBeDefined();
    expect(mathFile?.getFunctions().map((fn) => fn.getName())).toEqual(["add", "average", "clamp"]);
  });

  it("15. Supports synchronous ingestion via ingestWorkspaceSync", () => {
    const result = ingestWorkspaceSync("test-target");

    expect(result.fileCount).toBe(3);
    expect(result.totalCharacters).toBe(2035);
    expect(result.files.length).toBe(3);
  });

  it("16. Rejects when project path is a file rather than a directory", async () => {
    const projectDir = createTempProject({
      "file.ts": "export const x = 1;",
    });
    const filePath = path.join(projectDir, "file.ts");

    await expect(ingestWorkspace(filePath)).rejects.toThrowError(
      /Project path is not a directory/,
    );
  });
});
