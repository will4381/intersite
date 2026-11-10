// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isScriptFile, walk } from "../shared.mjs";
import { memberBase } from "./syntax.mjs";

export const id = "no-outer-client-in-transaction";
export const pack = "orm";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      outer: "This query runs on `{{client}}`, not on the transaction `{{tx}}`, so it commits on its own: it is not rolled back when the transaction fails and it cannot see the transaction's uncommitted writes. Call it on `{{tx}}` (and pass `{{tx}}` into any helper that queries).",
    },
  },
  createOnce(context) {
    return {
      // A test may use the outer client on purpose, to commit a racing write mid-transaction.
      before() {
        return !isScriptFile(context);
      },
      // `db.transaction(async (tx) => …)`, `prisma.$transaction(async (tx) => …)`, `knex.transaction(async (trx) => …)`
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        const callback = /** @type {any} */ (node.arguments[0]);
        if (callee.type !== "MemberExpression" || !/^\$?transaction$/.test(callee.property.name ?? "")) return;
        if (!callback?.type.endsWith("FunctionExpression") || callback.params[0]?.type !== "Identifier") return;
        const client = context.sourceCode.getText(callee.object);
        const tx = callback.params[0].name;
        if (tx === client) return; // `database.transaction(async (database) => …)` shadows the client with the transaction.
        walk(callback.body, (n) => {
          if (n.type !== "CallExpression") return;
          // `knex('stock')` calls the client itself.
          if (n.callee.type === "Identifier") {
            if (n.callee.name === client) context.report({ node: n, messageId: "outer", data: { client, tx } });
            return;
          }
          // Only the start of a chain (`db.insert`), not `db.insert(t).values` again; not a nested `db.transaction`.
          if (n.callee.type !== "MemberExpression" || memberBase(n.callee).type === "CallExpression" || /^\$?transaction$/.test(n.callee.property.name ?? "")) return;
          for (let m = n.callee.object; ; m = m.object) {
            // `prisma` and `this.prisma` name the same client.
            const text = context.sourceCode.getText(m);
            if (text === client || text === `this.${client}` || `this.${text}` === client) return context.report({ node: n, messageId: "outer", data: { client, tx } });
            if (m.type !== "MemberExpression") return;
          }
        });
      },
    };
  },
});

export const bad = [
  "await db.transaction(async (tx) => {\n  await tx.insert(orders).values(order);\n  await db.update(stock).set({ count: sql`count - 1` }).where(eq(stock.id, order.itemId));\n});",
  "await prisma.$transaction(async (tx) => {\n  const user = await tx.user.create({ data });\n  await prisma.account.create({ data: { userId: user.id } });\n});",
  "await this.db.transaction(async (trx) => {\n  await trx.delete(sessions).where(eq(sessions.userId, id));\n  await this.db.delete(users).where(eq(users.id, id));\n});",
  "await knex.transaction(async (trx) => {\n  await trx('orders').insert(order);\n  await knex('stock').decrement('count', 1);\n});",
  "await prisma.$transaction(async (tx) => {\n  await tx.order.create({ data });\n  await this.prisma.stock.update({ where: { id }, data: { count: { decrement: 1 } } });\n});",
];

export const good = [
  "await db.transaction(async (tx) => {\n  await tx.insert(orders).values(order);\n  await tx.update(stock).set({ count: sql`count - 1` }).where(eq(stock.id, order.itemId));\n});",
  "await prisma.$transaction(async (tx) => {\n  const user = await tx.user.create({ data });\n  await createAccount(tx, user.id);\n});",
  "await prisma.$transaction([prisma.user.create({ data }), prisma.audit.create({ data: log })]);",
  "await sequelize.transaction(async (t) => {\n  await User.create(data, { transaction: t });\n});",
  "await db.transaction(async (tx) => {\n  await tx.insert(orders).values(order);\n});\nawait db.insert(audit).values(entry);",
  "await database.transaction(async (database) => {\n  await database.insert(orders).values(order);\n});",
];
