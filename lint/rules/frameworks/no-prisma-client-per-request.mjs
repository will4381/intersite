// @ts-check
import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, isRequestName } from "../shared.mjs";

/** A request handler: a function taking `req` or `request`, or one passed to `app.get(...)`, `router.post(...)`. @param {any} fn */
function isHandler(fn) {
  if (fn.params.some(isRequestName)) return true;
  // Remix/React Router `action` and `loader`, Next route exports.
  if (fn.parent?.type === "ExportNamedDeclaration" && /^(action|loader|GET|POST|PUT|PATCH|DELETE)$/.test(fn.id?.name ?? "")) return true;
  const call = fn.parent;
  return call?.type === "CallExpression" && call.callee.type === "MemberExpression" && /^(get|post|put|patch|delete|all|route)$/.test(call.callee.property.name ?? "");
}

export const id = "no-prisma-client-per-request";
export const pack = "orm";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      perRequest: "This creates a PrismaClient on every request, and each one opens its own connection pool, so under load the database runs out of connections and every request pays the connect time. Create one client at module scope (globalThis.prisma ??= new PrismaClient() to survive dev reloads) and import it.",
    },
  },
  createOnce(context) {
    return {
      NewExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.name !== "PrismaClient") return;
        // On Workers a client per request with a driver adapter (D1, Hyperdrive, Neon) is the documented pattern.
        const options = /** @type {any} */ (node.arguments[0]);
        if (options?.type === "ObjectExpression" && options.properties.some((/** @type {any} */ p) => p.type === "SpreadElement" || p.key?.name === "adapter")) return;
        const fn = enclosingFunction(node);
        if (fn && isHandler(fn)) context.report({ node, messageId: "perRequest" });
      },
    };
  },
});

export const bad = [
  "app.get('/users', async (req, res) => {\n  const prisma = new PrismaClient();\n  res.json(await prisma.user.findMany());\n});",
  "export async function GET(request: Request) {\n  const prisma = new PrismaClient();\n  return Response.json(await prisma.post.findMany({ take: 20 }));\n}",
  "export async function action() {\n  const prisma = new PrismaClient();\n  await prisma.user.create({ data: {} });\n}",
  "router.post('/orders', async (ctx) => {\n  const db = new PrismaClient({ log: ['error'] });\n  ctx.body = await db.order.create({ data: ctx.request.body });\n});",
];

export const good = [
  "export const prisma = globalThis.prisma ?? new PrismaClient();",
  "export default {\n  async fetch(request: Request, env: Env) {\n    const prisma = new PrismaClient({ adapter: new PrismaD1(env.DB) });\n    return Response.json(await prisma.user.findMany());\n  },\n};",
  "export function createPrisma(url: string) {\n  return new PrismaClient({ datasources: { db: { url } } });\n}",
];
