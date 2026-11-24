// @ts-check
import { defineRule } from "@oxlint/plugins";

/** The reduce callback whose accumulator `name` is, when the node sits in one. @param {any} node @param {string} name */
function reducerOf(node, name) {
  for (let n = node.parent; n; n = n.parent) {
    if (!/Function/.test(n.type)) continue;
    const call = n.parent;
    const reduces = call?.type === "CallExpression" && call.arguments[0] === n && /^reduce(?:Right)?$/.test(call.callee?.property?.name ?? "");
    return reduces && n.params[0]?.type === "Identifier" && n.params[0].name === name;
  }
  return false;
}

/** The accumulator a copy is made of: `Object.assign({}, acc, …)`, `acc.concat(…)`, `acc.slice()`, `Array.from(acc)`, `new Map(acc)`, `structuredClone(acc)`. @param {any} node */
function copied(node) {
  const callee = node.callee;
  const arg = (/** @type {number} */ i) => (node.arguments[i]?.type === "Identifier" ? node.arguments[i].name : undefined);
  if (node.type === "NewExpression") return /^(Map|Set)$/.test(callee.name) ? arg(0) : undefined;
  if (callee.type === "Identifier") return callee.name === "structuredClone" ? arg(0) : undefined;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  const [object, method] = [callee.object, callee.property.name];
  if (object.name === "Object" && method === "assign" && node.arguments[0]?.type === "ObjectExpression" && !node.arguments[0].properties.length) {
    return node.arguments.slice(1).find((/** @type {any} */ a) => a.type === "Identifier")?.name;
  }
  if (object.name === "Array" && method === "from") return arg(0);
  if (object.type === "Identifier" && (method === "concat" || (method === "slice" && !node.arguments.length))) return object.name;
  return undefined;
}

export const id = "no-reduce-accumulator-copy";
export const pack = "perf";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "This copies the whole accumulator `{{ name }}` on every step of the reduce, so the work grows with the square of the list: 10,000 items copy 50 million entries. Add to the accumulator and return it (`{{ name }}.push(x); return {{ name }};`, `{{ name }}[key] = x`), or build the result with one `map`, `flatMap` or `Object.fromEntries`.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    const check = (node) => {
      const name = copied(node);
      if (name && reducerOf(node, name)) context.report({ node, messageId: "found", data: { name } });
    };
    return { CallExpression: check, NewExpression: check };
  },
});

export const bad = [
  "export const byId = (rows: Row[]) => rows.reduce((acc, r) => Object.assign({}, acc, { [r.id]: r }), {});",
  "export const all = (pages: Page[]) => pages.reduce((acc, p) => acc.concat(p.items), [] as Item[]);",
  "export const seen = (ids: string[]) => ids.reduce((acc, id) => { const next = new Set(acc); next.add(id); return next; }, new Set<string>());",
  "export const grown = (xs: number[]) => xs.reduce(function (acc, x) { const copy = acc.slice(); copy.push(x); return copy; }, [] as number[]);",
];

export const good = [
  "export const byId = (rows: Row[]) => rows.reduce((acc, r) => { acc[r.id] = r; return acc; }, {} as Record<string, Row>);",
  "export const all = (pages: Page[]) => pages.flatMap((p) => p.items);",
  "export const total = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0);",
  "export const merged = (a: Item[], b: Item[]) => a.concat(b);",
  "export const sorted = (list: number[]) => { const copy = list.slice(); copy.sort(); return copy; };",
];
