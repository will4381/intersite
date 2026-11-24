// @ts-check
import { defineRule } from "@oxlint/plugins";

import { notShipped } from "../shared.mjs";

/** Initialisers whose type the compiler already knows exactly. */
const KNOWN = /^(Literal|ObjectExpression|ArrayExpression|TemplateLiteral)$/;

export const id = "no-widened-const";
export const pack = "types";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ name }}` is a {{ what }} the compiler knows exactly, but it is declared `{{ wide }}`, so every use has to cast or check what was already known. Drop the annotation and let it be inferred, or write `satisfies {{ wide }}` to check it without forgetting its type.",
    },
  },
  createOnce(context) {
    return {
      before: () => !notShipped(context),
      VariableDeclarator(/** @type {any} */ node) {
        const type = node.id.typeAnnotation?.typeAnnotation;
        // `unknown` and `object` only: `any` is no-explicit-any's, and a `Record<string, unknown>` is a bag filled later.
        if (node.parent.kind !== "const" || node.id.type !== "Identifier" || !node.init || !KNOWN.test(node.init.type) || !/^TS(Unknown|Object)Keyword$/.test(type?.type)) return;
        // An empty `{}` or `[]` needs its annotation to be filled.
        if ((node.init.properties ?? node.init.elements)?.length === 0) return;
        // An exported value's annotation is its public contract, chosen on purpose.
        if (node.parent.parent?.type === "ExportNamedDeclaration") return;
        if (node.init.type === "Literal" && node.init.value === null) return;
        const what = { ObjectExpression: "object", ArrayExpression: "array" }[/** @type {string} */ (node.init.type)] ?? "value";
        context.report({ node: node.id, messageId: "found", data: { name: node.id.name, what, wide: context.sourceCode.getText(type).slice(0, 40) } });
      },
    };
  },
});

export const bad = [
  "export function headers() {\n  const base: object = { accept: 'application/json', retries: 3 };\n  return send(base);\n}",
  "export function limits() {\n  const max: unknown = 50;\n  return max;\n}",
  "export function list() {\n  const ids: unknown = ['a', 'b'];\n  return ids;\n}",
  "export function body() {\n  const payload: object = { kind: 'order' };\n  return payload;\n}",
];

export const good = [
  "export function headers() {\n  const base = { accept: 'application/json', retries: 3 };\n  return send(base);\n}",
  "export function limits() {\n  const max = 50 satisfies number;\n  return max * 2;\n}",
  "export const DEFAULTS: Record<string, unknown> = { retries: 3 };",
  "export async function load() {\n  const data: unknown = await fetchJson();\n  return Schema.parse(data);\n}",
  "export function empty() {\n  const none: unknown = null;\n  return none;\n}",
  "export function collect(rows: Row[]) {\n  const out: Record<string, unknown> = {};\n  for (const r of rows) out[r.key] = r.value;\n  return out;\n}",
  "export function fields() {\n  const bag: object = {};\n  return bag;\n}",
];
