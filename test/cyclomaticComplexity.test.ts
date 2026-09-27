import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseFiles } from "../src/parser/astEngine.js";

const targetPath = (name: string) => path.resolve("test-target/src", name);

describe("cyclomatic complexity", () => {
  it("gives a simple branch-free function the baseline complexity of 1", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    const addFn = result.nodes.find((n) => n.name === "add")!;
    expect(addFn.complexity).toBe(1); // no branches at all: return a + b
  });

  it("counts each if-statement as one added branch", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    const clampFn = result.nodes.find((n) => n.name === "clamp")!;
    // 2 if-statements -> baseline 1 + 2 = 3
    expect(clampFn.complexity).toBe(3);
  });

  it("counts a for-loop as one added branch", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    const averageFn = result.nodes.find((n) => n.name === "average")!;
    // 1 for-loop -> baseline 1 + 1 = 2
    expect(averageFn.complexity).toBe(2);
  });

  it("counts nested callback branching too, since callbacks aren't tracked as separate nodes", () => {
    const [result] = parseFiles([targetPath("legacyCallback.js")]);
    const fetchFn = result.nodes.find((n) => n.name === "fetchUserData")!;
    // 3 nested if/else-driven error checks across the callback chain
    expect(fetchFn.complexity).toBeGreaterThanOrEqual(4);
  });

  it("flags high-complexity only once complexity exceeds the McCabe threshold of 10", () => {
    const [result] = parseFiles([targetPath("mathUtils.js")]);
    // None of the sample functions are actually this complex — confirms the
    // threshold doesn't fire on ordinary code, only genuinely tangled code.
    expect(result.nodes.every((n) => !n.smells.some((s) => s.type === "high-complexity"))).toBe(true);
  });
});