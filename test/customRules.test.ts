import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { lintFile } from "../src/sandbox/linterRunner.js";

vi.mock("../src/agent/reactLoop.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/reactLoop.js")>("../src/agent/reactLoop.js");
  return { ...actual, runRefactorTask: vi.fn() };
});
const { runRefactorTask } = await import("../src/agent/reactLoop.js");
const { runPipeline } = await import("../src/index.js");

const RULE = "autorefactor/no-callback-double-call";
let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "customrule-")); });
afterEach(() => { vi.clearAllMocks(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function ruleViolations(source: string) {
  const file = path.join(tmpDir, "case.js");
  fs.writeFileSync(file, source);
  const result = await lintFile(file);
  return { result, hits: (result.violations ?? []).filter((v) => v.ruleId === RULE) };
}

// Copied verbatim from the patch real Gemini produced for fetchUserData.
const GEMINI_PATCH = `/**
 * @param {number|string} userId
 * @param {Function} callback
 * @returns {Promise<void>}
 */
async function fetchUserData(userId, callback) {
  try {
    const user = await new Promise((resolve, reject) => {
      getUserFromDb(userId, (err, res) => (err ? reject(err) : resolve(res)));
    });
    const orders = await new Promise((resolve, reject) => {
      getOrdersForUser(user.id, (err, res) => (err ? reject(err) : resolve(res)));
    });
    const payments = await new Promise((resolve, reject) => {
      getPaymentsForOrders(orders, (err, res) => (err ? reject(err) : resolve(res)));
    });
    callback(null, { user, orders, payments });
  } catch (err) {
    callback(err);
  }
}
`;

describe("no-callback-double-call", () => {
  it("flags the exact patch real Gemini produced, and fails the lint stage", async () => {
    const { result, hits } = await ruleViolations(GEMINI_PATCH);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("error");
    expect(hits[0].message).toContain("'callback'");
    expect(hits[0].message).toContain("Move the success call outside the try block");
    expect(result.passed).toBe(false);
  });

  it("accepts the corrected shape: success call outside the try", async () => {
    const { hits } = await ruleViolations(`
async function load(id, callback) {
  let value;
  try {
    value = await Promise.resolve(id);
  } catch (err) {
    callback(err);
    return;
  }
  callback(null, value);
}
`);
    expect(hits).toEqual([]);
  });

  it("leaves a try that calls the callback but a catch that doesn't alone", async () => {
    const { hits } = await ruleViolations("async function f(cb) {\n  try {\n    cb(null, 1);\n  } catch (err) {\n    console.error(err);\n  }\n}\n");
    expect(hits).toEqual([]);
  });

  it("leaves a catch that calls the callback but a try that doesn't alone", async () => {
    const { hits } = await ruleViolations("async function f(cb) {\n  try {\n    await work();\n  } catch (err) {\n    cb(err);\n  }\n}\n");
    expect(hits).toEqual([]);
  });

  it("ignores calls to something that isn't a parameter of the enclosing function", async () => {
    const { hits } = await ruleViolations("function log() {}\nasync function f() {\n  try {\n    log('a');\n  } catch (err) {\n    log(err);\n  }\n}\n");
    expect(hits).toEqual([]);
  });

  it("ignores a catch that calls the callback without passing the caught error", async () => {
    const { hits } = await ruleViolations("async function f(cb) {\n  try {\n    cb(null, 1);\n  } catch (err) {\n    cb(new Error('wrapped'));\n  }\n}\n");
    expect(hits).toEqual([]);
  });

  it("does not count calls inside nested functions, which run at other times", async () => {
    const { hits } = await ruleViolations("function f(cb) {\n  try {\n    setTimeout(function () { cb(null); }, 1);\n  } catch (err) {\n    cb(err);\n  }\n}\n");
    expect(hits).toEqual([]);
  });

  it("does not flag the original sample files", async () => {
    for (const name of ["legacyCallback.js", "mathUtils.js", "userController.js"]) {
      const result = await lintFile(path.resolve("test-target/src", name));
      expect((result.violations ?? []).filter((v) => v.ruleId === RULE)).toEqual([]);
    }
  });
});

describe("the retry loop self-corrects the double-callback mistake (LLM mocked)", () => {
  it("rejects the bad patch, sends the rule's message back, and accepts the corrected one", async () => {
    const file = path.join(tmpDir, "load.js");
    fs.writeFileSync(file, "function load(id, callback) {\n  Promise.resolve(id).then(function (v) { callback(null, v); });\n}\n");
    const patch = (newSourceText: string) => ({
      tool: "propose_patch" as const,
      payload: { taskId: "t", targetNodeId: "n", newSourceText, explanation: "x" },
    });
    const jsdoc = "/**\n * @param {number} id\n * @param {Function} callback\n * @returns {Promise<void>}\n */\n";
    vi.mocked(runRefactorTask)
      .mockResolvedValueOnce(patch(`${jsdoc}async function load(id, callback) {\n  try {\n    const v = await Promise.resolve(id);\n    callback(null, v);\n  } catch (err) {\n    callback(err);\n  }\n}`))
      .mockResolvedValueOnce(patch(`${jsdoc}async function load(id, callback) {\n  let v;\n  try {\n    v = await Promise.resolve(id);\n  } catch (err) {\n    callback(err);\n    return;\n  }\n  callback(null, v);\n}`));

    const result = await runPipeline({ targetDir: tmpDir, filePaths: [file], minRefactorScore: 0, skipGit: true });

    expect(result.taskOutcomes[0].passed).toBe(true);
    expect(runRefactorTask).toHaveBeenCalledTimes(2);
    const feedback = (vi.mocked(runRefactorTask).mock.calls[1][2]?.priorTurns ?? []).map((t) => t.content).join("\n");
    expect(feedback).toContain(RULE);
    expect(feedback).toContain("Move the success call outside the try block");
    expect(fs.readFileSync(file, "utf-8")).toContain("callback(null, v);\n}");
  });
});