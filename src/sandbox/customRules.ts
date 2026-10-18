/**
 * Project-specific lint rules that catch mistakes the type checker can't —
 * each one written after seeing the mistake in a REAL model patch that
 * passed every other check.
 */
import type { Rule } from "eslint";

/* eslint-disable @typescript-eslint/no-explicit-any -- ESTree nodes are walked structurally */

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** Visits every CallExpression under `node`, without descending into nested functions (they run at other times). */
function visitCalls(node: any, onCall: (call: any) => void): void {
  if (!node || typeof node.type !== "string") return;
  if (FUNCTION_TYPES.has(node.type)) return;
  if (node.type === "CallExpression") onCall(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => visitCalls(child, onCall));
    else if (value && typeof value.type === "string") visitCalls(value, onCall);
  }
}

function enclosingFunction(node: any): any | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTION_TYPES.has(current.type)) return current;
  }
  return undefined;
}

/**
 * Flags the converting-callbacks-to-async/await mistake:
 *
 *   async function f(cb) {
 *     try { ...; cb(null, result); }   // success call inside the try
 *     catch (err) { cb(err); }         // error call in the catch
 *   }
 *
 * If cb itself throws, the catch runs and calls cb a SECOND time. Only fires
 * when the callee is a parameter of the enclosing function, is called in the
 * try block, and is called in the catch clause with the caught error — so
 * ordinary try/catch code is left alone.
 */
export const noCallbackDoubleCall: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      doubleCall:
        "'{{name}}' is called inside this try block and again, with the caught error, in its catch clause. " +
        "If the first call throws, '{{name}}' runs twice. Move the success call outside the try block.",
    },
  },
  create(context) {
    return {
      TryStatement(node: any) {
        const handler = node.handler;
        if (!handler || handler.param?.type !== "Identifier") return;
        const fn = enclosingFunction(node);
        if (!fn) return;
        const paramNames = new Set<string>(fn.params.filter((p: any) => p.type === "Identifier").map((p: any) => p.name));
        if (paramNames.size === 0) return;

        const calledInTry = new Set<string>();
        visitCalls(node.block, (call) => {
          if (call.callee.type === "Identifier" && paramNames.has(call.callee.name)) calledInTry.add(call.callee.name);
        });

        const caughtName = handler.param.name;
        const reported = new Set<string>();
        visitCalls(handler.body, (call) => {
          const name = call.callee.type === "Identifier" ? call.callee.name : undefined;
          if (!name || !calledInTry.has(name) || reported.has(name)) return;
          const passesCaughtError = call.arguments.some((a: any) => a.type === "Identifier" && a.name === caughtName);
          if (!passesCaughtError) return;
          reported.add(name);
          context.report({ node, messageId: "doubleCall", data: { name } });
        });
      },
    };
  },
};