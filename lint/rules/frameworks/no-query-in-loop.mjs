// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isScriptFile, unwrap, walk } from "../shared.mjs";
import { chainMethods, chainRoot } from "./syntax.mjs";

const PRISMA_READ = /^(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count)$/;
const DRIZZLE_CLIENT = /^(db|tx|trx|database)$|Db$/;

/**
 * The filter of a Prisma or Drizzle read keyed on one value, the shape an `in` list replaces: Prisma
 * `prisma.user.findUnique({ where: { id: x } })`, Drizzle `db.select().from(t).where(eq(t.id, x))` or
 * `db.query.users.findFirst({ where: eq(users.id, x) })`. Row-locking reads (`.for('update')`) are left alone: locking
 * one row at a time is deliberate.
 * @param {any} call
 */
function keyedFilter(call) {
  if (call?.type !== "CallExpression" || call.callee.type !== "MemberExpression") return undefined;
  const methods = chainMethods(call);
  if (methods.includes("for")) return undefined;
  if (PRISMA_READ.test(call.callee.property.name) && call.callee.object.type === "MemberExpression") {
    const where = call.arguments[0]?.properties?.find((/** @type {any} */ p) => p.key?.name === "where")?.value;
    if (where?.type === "CallExpression" && where.callee.name === "eq") return where.arguments[1]; // Drizzle relational query
    const only = where?.type === "ObjectExpression" && where.properties.length === 1 ? where.properties[0] : undefined;
    return only?.type === "Property" && only.value.type !== "ObjectExpression" ? only.value : undefined;
  }
  const root = chainRoot(call);
  if (!methods.includes("select") || !methods.includes("from") || !(root?.type === "ThisExpression" || DRIZZLE_CLIENT.test(root?.name ?? ""))) return undefined;
  /** @type {any} */
  let filter;
  for (let n = call; n?.type === "CallExpression"; n = n.callee.object) {
    if (n.callee.property?.name === "where" && n.arguments[0]?.type === "CallExpression" && n.arguments[0].callee.name === "eq") filter = n.arguments[0].arguments[1];
  }
  return filter;
}

/** Names a `for (const … of …)` binds. @param {any} pattern */
function boundNames(pattern) {
  /** @type {string[]} */
  const names = [];
  walk(pattern, (n, parent) => {
    // Property keys in `{ id: userId }` are not bindings; values and shorthand are.
    if (n.type === "Identifier" && !(parent?.type === "Property" && parent.key === n && !parent.shorthand)) names.push(n.name);
  });
  return names;
}

export const id = "no-query-in-loop";
export const pack = "orm";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      loop: "This awaits one query per item of the loop (`{{item}}`), so a list of 200 makes 200 round trips in a row. Load them in one query before the loop (Prisma `where: { id: { in: ids } }` or `include`; Drizzle `inArray(...)` or a join) and look each one up from a Map.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return !isScriptFile(context);
      },
      ForOfStatement(node) {
        const left = /** @type {any} */ (node.left);
        const right = /** @type {any} */ (node.right);
        if (right.type === "ArrayExpression") return; // A fixed handful written out by hand.
        const names = new Set(boundNames(left.type === "VariableDeclaration" ? left.declarations[0].id : left));
        walk(node.body, (n) => {
          // A loop inside this one is checked on its own, against its own item.
          if (n.type === "ForOfStatement") return false;
          const filter = n.type === "AwaitExpression" && keyedFilter(unwrap(n.argument));
          if (!filter) return;
          let uses = false;
          walk(filter, (m, parent) => {
            const key = (parent?.type === "MemberExpression" && parent.property === m && !parent.computed) || (parent?.type === "Property" && parent.key === m && !parent.shorthand);
            uses ||= m.type === "Identifier" && names.has(m.name) && !key;
          });
          if (uses) context.report({ node: n, messageId: "loop", data: { item: [...names].join(", ") } });
        });
      },
    };
  },
});

export const bad = [
  "async function authors(posts: Post[]) {\n  const out = [];\n  for (const post of posts) {\n    out.push(await prisma.user.findUnique({ where: { id: post.authorId } }));\n  }\n  return out;\n}",
  "async function totals(orderIds: string[]) {\n  for (const id of orderIds) {\n    const [order] = await db.select().from(orders).where(eq(orders.id, id));\n    sum += order.total;\n  }\n}",
  "async function load(members: Member[]) {\n  for (const { userId } of members) {\n    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });\n    if (user) names.push(user.name);\n  }\n}",
];

export const good = [
  "async function authors(posts: Post[]) {\n  const users = await prisma.user.findMany({ where: { id: { in: posts.map((p) => p.authorId) } } });\n  const byId = new Map(users.map((u) => [u.id, u]));\n  return posts.map((p) => byId.get(p.authorId));\n}",
  "async function save(rows: Row[]) {\n  for (const row of rows) {\n    await db.insert(items).values(row);\n  }\n}",
  "async function warm() {\n  for (const table of ['users', 'orders']) {\n    await prisma.user.count({ where: { kind: table } });\n  }\n}",
  "async function pages() {\n  for (const page of [1, 2, 3]) await fetchPage(page);\n}",
  "async function lock(ids: string[]) {\n  for (const id of ids) {\n    const [row] = await tx.select().from(accounts).where(eq(accounts.id, id)).for('update');\n    await settle(tx, row);\n  }\n}",
  "async function search(terms: string[]) {\n  for (const term of terms) {\n    hits.push(await prisma.post.findMany({ where: { title: { contains: term } } }));\n  }\n}",
  "async function stats(ids: string[]) {\n  for (const id of ids) {\n    const total = await prisma.order.count();\n    log(id, total);\n  }\n}",
];
