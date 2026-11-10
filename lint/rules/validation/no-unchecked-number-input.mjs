// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, isEnvRead, isRequestValue, notShipped, unwrap } from "../shared.mjs";

// Calls that catch NaN: the standard checks, an allowlist lookup (WIDTHS.includes(w)), helpers named for checking.
const NAN_CHECK = /^(isNaN|isFinite|isInteger|isSafeInteger|includes|has)$|valid|assert|check|clamp|ensure|require/i;

/** The value under `x || 'default'` and `x ?? 'default'`. @param {any} node */
function operand(node) {
  node = unwrap(node);
  while (node?.type === "LogicalExpression") node = unwrap(node.left);
  return node;
}

/** Request input or an environment variable, read here or through a `const` alias. @param {any} node @param {any} sourceCode */
function isInput(node, sourceCode) {
  // A NaN port fails loudly at listen(), so PORT variables are left alone.
  const source = (/** @type {any} */ n) => isRequestValue(n) || (isEnvRead(n) && !(n.property.name ?? "").endsWith("PORT"));
  node = operand(node);
  if (source(node)) return true;
  const init = constInit(node, sourceCode);
  return init !== undefined && source(operand(init));
}

/** The string a conversion turns into a number: Number(x), parseInt(x), parseFloat(x), +x. @param {any} node */
function converted(node) {
  if (node.type === "UnaryExpression" && node.operator === "+") return node.argument;
  if (node.type !== "CallExpression") return undefined;
  const name = calleeName(node);
  const global = node.callee.type === "Identifier" || node.callee.object?.name === "Number";
  return global && /^(Number|parseInt|parseFloat)$/.test(name) ? node.arguments[0] : undefined;
}

/** True when the expression at `node` falls back on NaN (`|| 20`) or sits in a NaN check. @param {any} node */
function guardedUse(node) {
  let n = node;
  while (n.parent?.type === "TSAsExpression" || n.parent?.type === "ParenthesizedExpression") n = n.parent;
  const p = n.parent;
  if (p?.type === "LogicalExpression" && p.operator === "||" && p.left === n) return true;
  if (p?.type === "BinaryExpression" && /^!==?$/.test(p.operator) && selfCompare(p)) return true;
  return p?.type === "CallExpression" && p.arguments.includes(n) && NAN_CHECK.test(calleeName(p));
}

/** `n !== n`, the old NaN test. @param {any} p */
const selfCompare = (p) => p.left.type === "Identifier" && p.right.type === "Identifier" && p.left.name === p.right.name;

/**
 * True when the conversion's result is checked: right here, or through the variable it is stored in.
 * @param {any} node @param {any} sourceCode
 */
function checked(node, sourceCode) {
  if (guardedUse(node)) return true;
  let n = node;
  while (n.parent?.type === "TSAsExpression" || n.parent?.type === "ParenthesizedExpression") n = n.parent;
  if (n.parent?.type !== "VariableDeclarator" || n.parent.id.type !== "Identifier") return false;
  const [variable] = sourceCode.getDeclaredVariables(n.parent);
  return Boolean(variable?.references.some((/** @type {any} */ r) => !r.init && guardedUse(r.identifier)));
}

export const id = "no-unchecked-number-input";
export const pack = "validation";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      nan: "Number(), parseInt() and + turn a missing or malformed value into NaN without an error, and NaN then slips through comparisons (count > NaN is always false) into limits, offsets and amounts. Parse it with a schema (z.coerce.number().int().min(1).max(100)), or check Number.isInteger / Number.isNaN and answer 400 (or fall back on purpose with `|| default`).",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      const arg = converted(node);
      if (arg && isInput(arg, context.sourceCode) && !checked(node, context.sourceCode)) context.report({ node, messageId: "nan" });
    }
    return { before: () => !notShipped(context), CallExpression: check, UnaryExpression: check };
  },
});

export const bad = [
  "app.get('/posts', async (req, res) => { res.json(await db.post.findMany({ take: Number(req.query.limit), skip: Number(req.query.offset) })); });",
  "app.get('/items', (req, res) => { const page = parseInt(req.query.page as string, 10); res.json(list(page)); });",
  "export async function GET(request: Request) { const { searchParams } = new URL(request.url); const limit = +searchParams.get('limit'); return Response.json(await recent(limit)); }",
  "const maxPerMinute = Number(process.env.RATE_LIMIT); if (count > maxPerMinute) throw new TooManyRequests();",
  "app.post('/pay', async (req, res) => { const { amount } = req.body; await charge(parseFloat(amount)); res.end(); });",
  "app.get('/x', (req, res) => { const raw = req.query.n; res.json(compute(Number(raw))); });",
  "app.get('/x', (c) => { const page = parseInt(c.req.query('page')!); return c.json(list(page)); });",
];

export const good = [
  "app.get('/posts', async (req, res) => { const limit = Number(req.query.limit) || 20; res.json(await db.post.findMany({ take: Math.min(limit, 100) })); });",
  "app.get('/items', (req, res) => { const page = Number(req.query.page); if (!Number.isInteger(page) || page < 1) return res.status(400).end(); res.json(list(page)); });",
  "const port = Number(process.env.PORT) || 3000;",
  "const redis = { port: parseInt(process.env.REDIS_PORT || '6379', 10) };",
  "const width = Number(url.searchParams.get('w')); if (!WIDTHS.includes(width)) return notFound();",
  "const { page } = Query.parse(req.query);",
  "const total = Number(order.total);",
  "const n = parseInt(req.query.n as string, 10); if (isNaN(n)) throw new BadRequest('n');",
  "const ttl = parseInt(process.env.TTL ?? '60', 10); if (ttl !== ttl) throw new Error('TTL is not a number');",
];
