import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverFiles } from "../src/cli/fileDiscovery.js";

let root: string;

function touch(rel: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "// x\n");
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "discover-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("discoverFiles", () => {
  it("finds js/ts/jsx/tsx files, including nested ones", () => {
    ["a.js", "b.ts", "nested/c.jsx", "nested/deep/d.tsx"].forEach(touch);
    const found = discoverFiles(root).map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(found).toEqual(["a.js", "b.ts", "nested/c.jsx", "nested/deep/d.tsx"]);
  });

  it("skips node_modules, dist, build, coverage, __tests__ and hidden directories", () => {
    ["src/keep.js", "node_modules/pkg/x.js", "dist/x.js", "build/x.js", "coverage/x.js", "src/__tests__/x.js", ".git/x.js", ".cache/x.js"].forEach(touch);
    const found = discoverFiles(root).map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(found).toEqual(["src/keep.js"]);
  });

  it("skips test files, spec files, and .d.ts declarations", () => {
    ["keep.ts", "a.test.js", "b.spec.ts", "types.d.ts"].forEach(touch);
    expect(discoverFiles(root).map((f) => path.basename(f))).toEqual(["keep.ts"]);
  });

  it("ignores non-source files", () => {
    ["keep.js", "README.md", "data.json", "style.css"].forEach(touch);
    expect(discoverFiles(root).map((f) => path.basename(f))).toEqual(["keep.js"]);
  });

  it("returns a single file as-is when the target is a file", () => {
    touch("only.js");
    expect(discoverFiles(path.join(root, "only.js"))).toEqual([path.join(root, "only.js")]);
  });

  it("returns an empty list for an empty directory", () => {
    expect(discoverFiles(root)).toEqual([]);
  });
});