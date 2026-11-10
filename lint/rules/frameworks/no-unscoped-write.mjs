// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isScriptFile } from "../shared.mjs";
import { chainMethods } from "./syntax.mjs";

/** A Drizzle client: `db`, `tx`, `trx`, `database`, `this.db`, `ctx.db`, `userDb`. */
const CLIENT = /^(db|tx|trx|database)$|Db$/;

/** The outermost call above `node` in its chain, following `.x(...)` links. @param {any} node */
function outermost(node) {
  let top = node;
  while (top.parent?.type === "MemberExpression" && top.parent.object === top && top.parent.parent?.type === "CallExpression" && top.parent.parent.callee === top.parent) top = top.parent.parent;
  return top;
}

/** `{}` or an object with no `where`, or nothing at all. @param {any} arg */
const unfiltered = (arg) => !arg || (arg.type === "ObjectExpression" && !arg.properties.some((/** @type {any} */ p) => p.type === "SpreadElement" || p.key?.name === "where"));

export const id = "no-unscoped-write";
export const pack = "orm";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      drizzle: "This {{method}} has no .where(), so it changes every row in the table. Add .where(...) with the rows you mean; if every row really is intended, say so with .where(sql`true`).",
      prisma: "This {{method}} has no `where`, so it changes every row of the model. Add `where: { ... }` with the rows you mean; if every row really is intended, pass `where: {}` explicitly.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return !isScriptFile(context);
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const method = callee.property.name;
        // Prisma `deleteMany()` / `updateMany({ data })`, Mongo `deleteMany({})`.
        if (method === "deleteMany" || method === "updateMany") {
          const [arg] = /** @type {any[]} */ (node.arguments);
          if (callee.object.type !== "MemberExpression" || !unfiltered(arg)) return;
          if (method === "updateMany" && !arg?.properties.some((/** @type {any} */ p) => p.key?.name === "data")) return;
          return context.report({ node, messageId: "prisma", data: { method } });
        }
        // Drizzle `db.update(table).set(values)` and `db.delete(table)`.
        if ((method !== "update" && method !== "delete") || node.arguments.length !== 1) return;
        const client = callee.object.type === "Identifier" ? callee.object.name : callee.object.property?.name;
        if (!CLIENT.test(client ?? "")) return;
        const top = outermost(node);
        const methods = chainMethods(top);
        // A query kept in a variable or made `$dynamic()` gets its where later.
        if (methods.includes("$dynamic") || top.parent?.type === "VariableDeclarator" || top.parent?.type === "AssignmentExpression") return;
        if (method === "update" && !methods.includes("set")) return;
        // Drizzle's delete takes a table and runs when awaited; `store.delete(key)` on a map or cache is not awaited.
        if (method === "delete" && (!["Identifier", "MemberExpression"].includes(node.arguments[0].type) || !["AwaitExpression", "ReturnStatement", "ArrowFunctionExpression"].includes(top.parent?.type))) return;
        if (!methods.includes("where")) context.report({ node, messageId: "drizzle", data: { method: `${method}(${context.sourceCode.getText(node.arguments[0])})` } });
      },
    };
  },
});

export const bad = [
  "await db.update(users).set({ plan: 'pro' });",
  "export async function clear(userId: string) {\n  await db.delete(sessions);\n}",
  "await prisma.user.updateMany({ data: { verified: true } });",
  "await prisma.session.deleteMany();",
  "await this.db.update(orders).set({ status: 'shipped' }).returning();",
  "await tx.post.deleteMany({});",
];

export const good = [
  "await db.update(users).set({ plan: 'pro' }).where(eq(users.id, userId));",
  "await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));",
  "await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });",
  "await prisma.user.updateMany({ where: { orgId }, data: { verified: true } });",
  "cache.delete(key);",
  "await env.KV.delete(key);",
  "const q = db.update(users).set({ plan: 'pro' });\nawait q.where(eq(users.id, id));",
  "params.delete('page');",
  "await db.friends.delete(friendId);",
];
