// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isGenerated, isTestFile, resolveVariable, walk } from "../shared.mjs";

/** At most this many statements: a longer helper called once is a named step, which max-function-statements asks for. */
const MAX_STATEMENTS = 1;
/** A call inside a function longer than this is a step pulled out of a long function, which is fine. */
const MAX_CALLER_STATEMENTS = 15;
/** A body longer than this reads better under a name than inline at the call. */
const MAX_CHARS = 80;
/** A named predicate explains a condition at the call (`if (isExpired(token))`), which is what a name is for. */
const PREDICATE = /^(is|has|can|should|was|did|needs|allows|includes|matches|looks|fits)[A-Z_]/;

/** A module-level function that is not exported: `function f() {}` or `const f = () => …`. @param {any} statement */
function helperOf(statement) {
  if (statement.type === "FunctionDeclaration" && statement.id) return { name: statement.id.name, id: statement.id, fn: statement };
  if (statement.type !== "VariableDeclaration" || statement.kind !== "const" || statement.declarations.length !== 1) return undefined;
  const [d] = statement.declarations;
  return d.id.type === "Identifier" && FUNCTIONS.has(d.init?.type) ? { name: d.id.name, id: d.id, fn: d.init } : undefined;
}

/** Statements a function body runs, its own and those of callbacks inside it; an expression body is one. @param {any} fn */
function statements(fn) {
  if (fn.body.type !== "BlockStatement") return 1;
  let count = 0;
  walk(fn.body, (n) => void (n.type.endsWith("Statement") && n.type !== "BlockStatement" && count++));
  return count + fn.body.body.filter((/** @type {any} */ s) => s.type === "VariableDeclaration").length;
}

export const id = "no-single-use-helper";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      once: "{{name}} is a {{count}}-statement function called once, at line {{line}}: the reader jumps here and back to read what fits at the call. Write it where it is used, and give it a name again when a second caller needs it.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context) && !isGenerated(context),
      Program(program) {
        const { sourceCode } = context;
        for (const h of program.body.map(helperOf)) {
          // Cheap tests first: most functions are exported, named for a framework, or longer than an inline expression.
          if (!h || /^[A-Z]|^use[A-Z]/.test(h.name) || PREDICATE.test(h.name) || sourceCode.getText(h.fn.body).length > MAX_CHARS || statements(h.fn) > MAX_STATEMENTS) continue;
          // The scope manager already knows every use; `const f = …` counts its own initialisation, which is no use.
          const uses = (resolveVariable(h.id, sourceCode)?.references ?? []).filter((/** @type {any} */ r) => !r.init);
          if (uses.length !== 1) continue;
          const node = uses[0].identifier;
          const parent = node.parent;
          // Passed as a value (items.map(format)) it is a named callback; inside itself it recurses.
          if (parent?.type !== "CallExpression" || parent.callee !== node || (node.start >= h.fn.start && node.end <= h.fn.end)) continue;
          let caller = parent.parent;
          while (caller && !FUNCTIONS.has(caller.type)) caller = caller.parent;
          if (caller && statements(caller) > MAX_CALLER_STATEMENTS) continue;
          const line = sourceCode.getText().slice(0, node.start).split("\n").length;
          context.report({ node: h.id, messageId: "once", data: { name: h.name, count: String(statements(h.fn)), line: String(line) } });
        }
      },
    };
  },
});

export const bad = [
  "const adminRole = (user) => user.role === 'admin';\nexport function canDelete(user, post) { return adminRole(user) || post.authorId === user.id; }",
  "function toCents(amount) { return Math.round(amount * 100); }\nexport async function charge(order) { await stripe.charges.create({ amount: toCents(order.total) }); }",
  "const label = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;\nexport const summary = (items) => `Cart: ${label(items.length)}`;",
];

export const good = [
  "const isAdmin = (user) => user.role === 'admin';\nexport function canDelete(user, post) { return isAdmin(user) || post.authorId === user.id; }",
  "const label = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;\nexport function render(cart) {\n  const a = 1; const b = 2; const c = 3; const d = 4; const e = 5; const f = 6; const g = 7; const h = 8;\n  const i = 9; const j = 10; const k = 11; const l = 12; const m = 13; const n = 14; const o = 15; const p = 16;\n  return `${label(cart.items.length)} ${a + b + c + d + e + f + g + h + i + j + k + l + m + n + o + p}`;\n}",
  "function toCents(amount) { const scaled = amount * 100; return Math.round(scaled); }\nexport async function charge(order) { await stripe.charges.create({ amount: toCents(order.total) }); }",
  "const isAdmin = (user) => user.role === 'admin';\nexport const canDelete = (user) => isAdmin(user);\nexport const canBan = (user) => isAdmin(user);",
  "const format = (n) => n.toFixed(2);\nexport const prices = (list) => list.map(format);",
  "function useCart() { return useContext(CartContext); }\nexport function Cart() { const cart = useCart(); return cart.total; }",
  "function walk(node) { if (!node) return 0; return 1 + walk(node.next); }\nexport const size = (list) => walk(list.head);",
  "export function toCents(amount) { return Math.round(amount * 100); }\nexport const total = (order) => toCents(order.total);",
  "const fetchUser = (id) => db.user.find(id);\nexport { fetchUser };\nexport const load = (id) => fetchUser(id);",
  "function parse(line) {\n  const [key, value] = line.split('=');\n  const name = key.trim().toLowerCase();\n  const cleaned = value.trim().replace(/^\"|\"$/g, '');\n  if (!name) throw new Error(`empty key in ${line}`);\n  return [name, cleaned];\n}\nexport const read = (text) => Object.fromEntries(text.split('\\n').map((l) => parse(l)));",
];
