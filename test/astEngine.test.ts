import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseFiles } from "../src/parser/astEngine.js";

const targetPath = (name: string) => path.resolve("test-target/src", name);

describe("astEngine.parseFiles", () => {
  it("extracts CommonJS exports even for a file nothing else imports", () => {
    const [result] = parseFiles([targetPath("legacyCallback.js")]);
    expect(result.exports).toEqual(["fetchUserData"]);
  });

  it("extracts multiple named CommonJS exports", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    expect(result.exports.sort()).toEqual(["add", "average", "clamp"]);
  });

  it("resolves a require() import specifier", () => {
    const [result] = parseFiles([targetPath("userController.js")]);
    expect(result.imports).toContain("./mathUtils");
  });

  it("flags untyped-signature on every plain-JS function", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    const addFn = result.nodes.find((n) => n.name === "add");
    expect(addFn?.smells.map((s) => s.type)).toContain("untyped-signature");
  });

  it("flags callback-hell on deeply nested callback functions", () => {
    const [result] = parseFiles([targetPath("legacyCallback.js")]);
    const fetchFn = result.nodes.find((n) => n.name === "fetchUserData");
    expect(fetchFn?.smells.map((s) => s.type)).toContain("callback-hell");
  });

  it("flags var-usage inside a function body", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    const avgFn = result.nodes.find((n) => n.name === "average");
    expect(avgFn?.smells.map((s) => s.type)).toContain("var-usage");
  });

  it("does not flag no-error-handling on plain synchronous functions", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    const clampFn = result.nodes.find((n) => n.name === "clamp");
    expect(clampFn?.smells.map((s) => s.type)).not.toContain("no-error-handling");
  });
});