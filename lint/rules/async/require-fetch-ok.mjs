// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestNamed } from "../shared.mjs";

// Only reads of an API-shaped body. `.blob()` and `.arrayBuffer()` mostly turn a data: URL or a bundled asset into
// bytes, where there is no HTTP status to check.
const body = new Set(["json", "text"]);
const checks = new Set(["ok", "status", "statusText"]);
/** A body checked through its own envelope, `if (!data.success)`, is checked too. */
const envelope = new Set(["ok", "success", "error", "errors"]);
const wrappers = new Set(["AwaitExpression", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]);

/** @param {any} node */
const isFetch = (node) => node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "fetch";

/** @param {any} variable @param {(name: string) => boolean} isCheck */
const checkedBy = (variable, isCheck) =>
  variable.references.some((/** @type {any} */ ref) => ref.identifier.parent.type === "MemberExpression" && isCheck(ref.identifier.parent.property.name));

/**
 * True when every use of the response reads its body and nothing checks it. Any other use (passed to a helper,
 * returned, stored) may check it elsewhere, so it counts as checked.
 * @param {any} variable @param {any} sourceCode
 */
function readsUnchecked(variable, sourceCode) {
  let read = false;
  for (const ref of variable.references) {
    if (ref.init) continue;
    const use = ref.identifier.parent;
    if (use.type !== "MemberExpression" || use.object !== ref.identifier || use.property.type !== "Identifier") return false;
    if (checks.has(use.property.name)) return false;
    if (!body.has(use.property.name)) continue;
    read = true;
    // const data = await res.json(); if (!data.success) ...
    let declarator = use.parent.parent;
    while (declarator && wrappers.has(declarator.type)) declarator = declarator.parent;
    if (declarator?.type === "VariableDeclarator" && declarator.id.type === "Identifier") {
      const parsed = sourceCode.getDeclaredVariables(declarator)[0];
      if (parsed && checkedBy(parsed, (name) => envelope.has(name))) return false;
    }
  }
  return read;
}

export const id = "require-fetch-ok";
export const pack = "async";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      unchecked: "fetch resolves on 404 and 500 too, so this reads an error page as if it were the data. Check response.ok (or response.status) before reading the body, and throw or return an error when it fails.",
    },
  },
  createOnce(context) {
    return {
      // In a test, the assertion on the parsed body fails loudly anyway.
      before: () => !isTestNamed(context),
      // const res = await fetch(url); ... res.json()
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init?.type !== "AwaitExpression" || !isFetch(node.init.argument)) return;
        const [variable] = context.sourceCode.getDeclaredVariables(node);
        if (variable && readsUnchecked(variable, context.sourceCode)) context.report({ node, messageId: "unchecked" });
      },
      // (await fetch(url)).json()
      MemberExpression(node) {
        if (node.object.type === "AwaitExpression" && isFetch(node.object.argument) && node.property.type === "Identifier" && body.has(node.property.name)) {
          context.report({ node, messageId: "unchecked" });
        }
      },
      // fetch(url).then((res) => res.json())
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.property.name !== "then" || !isFetch(callee.object)) return;
        const handler = node.arguments[0];
        if (!handler?.type.endsWith("FunctionExpression") || handler.params[0]?.type !== "Identifier") return;
        const variable = context.sourceCode.getDeclaredVariables(handler).find((v) => v.name === handler.params[0].name);
        if (variable && readsUnchecked(variable, context.sourceCode)) context.report({ node: handler, messageId: "unchecked" });
      },
    };
  },
});

export const bad = [
  "async function load(id) { const res = await fetch(`/api/users/${id}`); return res.json(); }",
  "async function load() { const response = await fetch(url); const data = await response.json(); return data.items; }",
  "const data = await (await fetch(url)).json();",
  "fetch(url).then((res) => res.json()).then(render);",
  "async function page() { const res = await fetch(url, { headers }); console.log(res.headers.get('etag')); return await res.text(); }",
];

export const good = [
  "async function load(id) { const res = await fetch(`/api/users/${id}`); if (!res.ok) throw new Error(`users ${res.status}`); return res.json(); }",
  "async function load() { const res = await fetch(url); if (res.status === 404) return null; return res.json(); }",
  "async function load() { const res = await fetch(url); return parseResponse(res); }",
  "async function load() { const res = await fetch(url); assertOk(res); return res.json(); }",
  "fetch(url).then((res) => { if (!res.ok) throw new Error(res.statusText); return res.json(); });",
  "async function load() { const res = await api.fetch(url); return res.json(); }",
  "async function ping() { const res = await fetch(url); return res.ok; }",
  "async function add() { const res = await fetch(api, { method: 'POST' }); const data = (await res.json()) as Reply; if (!data.success) throw new Error(data.errors[0]); return data.result; }",
  "const blob = await fetch(dataUrl).then((r) => r.blob());",
  "const font = await (await fetch(new URL('./Inter.ttf', import.meta.url))).arrayBuffer();",
];
