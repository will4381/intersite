// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, isRequestValue, notShipped, unwrap } from "../shared.mjs";

const PAGE_KEY = /^(limit|take|first|pageSize|page_size|perPage|per_page)$/;
const NUMBER_SCHEMA = /\b(number|int|integer|numeric|Integer|Number)\(/;
// A query schema coerces or defaults the page size; a response schema (`limit: z.number().int()`) only describes it.
const REQUEST_SCHEMA = /coerce|\.default\(|transform|toNumber|optional\(\)/;
const CAPPED = /\.(max|lte|lt|maxValue)\(|maxValue\(|maximum|Math\.min|clamp/;
const FIND = /^(find|findMany|findAll|findAndCountAll|select|aggregate|search|list)$/;

/** The value under conversions and fallbacks: Number(x), parseInt(x, 10), x || 20, a ? parseInt(a) : undefined. @param {any} node */
function core(node) {
  node = unwrap(node);
  for (;;) {
    if (node?.type === "LogicalExpression") node = unwrap(node.left);
    else if (node?.type === "ConditionalExpression") node = unwrap(node.consequent);
    else if (node?.type === "CallExpression" && /^(Number|parseInt|parseFloat)$/.test(calleeName(node))) node = unwrap(node.arguments[0]);
    else if (node?.type === "UnaryExpression" && node.operator === "+") node = unwrap(node.argument);
    else return node;
  }
}

/**
 * A page size the client picks with nothing capping it: request input under any conversion, directly or through a
 * `const` whose references never meet Math.min or a comparison.
 * @param {any} value @param {any} context
 */
function uncapped(value, context) {
  if (CAPPED.test(context.sourceCode.getText(value))) return false;
  const inner = core(value);
  if (isRequestValue(inner)) return true;
  if (inner?.type !== "Identifier") return false;
  const init = constInit(inner, context.sourceCode);
  if (!init || CAPPED.test(context.sourceCode.getText(init)) || !isRequestValue(core(init))) return false;
  const variable = context.sourceCode.getScope(inner).references.find((/** @type {any} */ r) => r.identifier === inner)?.resolved;
  return !variable?.references.some((/** @type {any} */ r) => /^[<>]=?$/.test(r.identifier.parent.operator ?? "") || calleeName(r.identifier.parent) === "min");
}

export const id = "require-pagination-cap";
export const pack = "validation";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      query: "The client picks this page size and nothing caps it, so ?limit=1000000 reads the whole table in one request (OWASP API4, unrestricted resource consumption). Cap it: Math.min(limit, 100), or a schema with .max(100).",
      schema: "This page size schema has no maximum, so a client can ask for a million rows in one request (OWASP API4). Add one: z.coerce.number().int().min(1).max(100).default(20).",
    },
  },
  createOnce(context) {
    return {
      before: () => !notShipped(context),
      // Prisma `take`, Sequelize/TypeORM `limit` in a find call.
      Property(node) {
        const key = /** @type {any} */ (node.key).name ?? /** @type {any} */ (node.key).value;
        if (!PAGE_KEY.test(key ?? "")) return;
        const value = /** @type {any} */ (node.value);
        // z.object({ limit: z.coerce.number() }), v.object({ limit: v.number() }), Joi/yup
        if (value.type === "CallExpression" && /^(z|v|Joi|yup|t|Type)\b/.test(context.sourceCode.getText(value)) && NUMBER_SCHEMA.test(context.sourceCode.getText(value))) {
          if (!REQUEST_SCHEMA.test(context.sourceCode.getText(value))) return;
          if (!CAPPED.test(context.sourceCode.getText(value))) context.report({ node, messageId: "schema" });
          return;
        }
        const call = /** @type {any} */ (node).parent?.parent;
        const inQuery = key === "take" || (call?.type === "CallExpression" && FIND.test(calleeName(call)));
        if (inQuery && uncapped(value, context)) context.report({ node, messageId: "query" });
      },
      // Drizzle, Knex, Mongo, Supabase: .limit(n)
      CallExpression(node) {
        if (/^(limit|take)$/.test(calleeName(node)) && node.callee.type === "MemberExpression" && node.arguments.length === 1 && uncapped(node.arguments[0], context)) context.report({ node, messageId: "query" });
      },
    };
  },
});

export const bad = [
  "app.get('/posts', async (req, res) => { res.json(await prisma.post.findMany({ take: Number(req.query.limit) || 20 })); });",
  "app.get('/posts', async (req, res) => { const limit = parseInt(req.query.limit as string, 10) || 20; res.json(await db.select().from(posts).limit(limit)); });",
  "const ListQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().positive().default(20) });",
  "app.get('/users', async (req, res) => { res.json(await User.findAll({ limit: req.query.limit ? parseInt(req.query.limit) : undefined })); });",
  "const Query = v.object({ pageSize: v.pipe(v.string(), v.transform(Number), v.number()) });",
  "app.get('/x', async (c) => { const limit = Number(c.req.query('limit') ?? 20); return c.json(await db.select().from(posts).limit(limit)); });",
];

export const good = [
  "app.get('/posts', async (req, res) => { const limit = Math.min(Number(req.query.limit) || 20, 100); res.json(await prisma.post.findMany({ take: limit })); });",
  "const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });",
  "app.get('/posts', async (req, res) => { const limit = Number(req.query.limit) || 20; if (limit > 100) return res.status(400).end(); res.json(await db.select().from(posts).limit(limit)); });",
  "const rows = await prisma.post.findMany({ take: PAGE_SIZE + 1 });",
  "const Query = v.object({ pageSize: v.pipe(v.number(), v.maxValue(100)) });",
  "const latest = await db.select().from(posts).limit(10);",
  "const Stats = z.object({ count: z.number().int() });",
  "const PageInfo = z.object({ hasMore: z.boolean(), limit: z.number().int().positive() });",
];
