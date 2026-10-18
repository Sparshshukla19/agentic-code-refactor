/**
 * Diagnostic: makes ONE small LLM call using your .env settings and prints
 * exactly what happens — provider, model, how long it took, and the full
 * result or error. Use it to separate "my key/model/network is the problem"
 * from "the pipeline is the problem".
 *
 * Usage: npx tsx scripts/checkLlm.ts [cheap|capable]   (default: cheap)
 */
import "dotenv/config";

const { describeModel, generateRefactorPatch, getLlmConfigProblem } = await import("../src/agent/llmClient.js");

const problem = getLlmConfigProblem();
if (problem) {
  console.error(`Config problem: ${problem}`);
  process.exit(1);
}

const tier = process.argv[2] === "capable" ? "capable" : "cheap";
console.log(`Calling ${describeModel(tier)} (${tier} tier; this can take a while on a free tier)...`);
const started = Date.now();
try {
  const result = await generateRefactorPatch(
    {
      taskId: "check",
      targetNodeId: "check::add",
      instruction: "Add explicit parameter and return types.",
      contextSlice: "function add(a, b) {\n  return a + b;\n}",
    },
    tier,
    [],
    { onRetry: (r) => console.log(`  ⏳ ${r.reason} — waiting ${Math.ceil(r.waitMs / 1000)}s (retry ${r.attempt}/${r.maxRetries})`) },
  );
  console.log(`OK after ${((Date.now() - started) / 1000).toFixed(1)}s:`);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s:`);
  const e = err as Error & { statusCode?: number; responseBody?: string; cause?: unknown };
  console.error("message:", e.message);
  if (e.statusCode) console.error("HTTP status:", e.statusCode);
  if (e.responseBody) console.error("response body:", e.responseBody.slice(0, 800));
  if (e.cause) console.error("cause:", e.cause);
  process.exit(1);
}