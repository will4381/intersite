// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isScriptFile, isTestFile, walk } from "../shared.mjs";

/** A stored state column: `status`, `state`, `paymentStatus`, `syncState`. */
const STATE_KEY = /^(?:status|state|[a-z]+(?:Status|State))$/;
/** A transition guard by name: `movableTo(...)`, `canTransition(...)`, `transitionGuard`. */
const GUARD = /movable|transition/i;

/** The state keys an object literal writes. @param {any} values */
const stateKeys = (values) =>
  values.properties.flatMap((/** @type {any} */ p) => {
    const key = p.type === "Property" && !p.computed ? p.key.name ?? String(p.key.value) : "";
    return STATE_KEY.test(key) ? [key] : [];
  });

/**
 * Whether a where clause checks the row's current state: it reads one of the state columns being written
 * (`eq(orders.status, "paid")`, `inArray(t.state, from)`) or calls a guard named for transitions.
 * @param {any} where @param {string[]} keys
 */
function guards(where, keys) {
  let found = false;
  walk(where, (n) => {
    if (found) return false;
    const name = n.type === "Identifier" ? n.name : n.type === "MemberExpression" && !n.computed ? n.property.name : undefined;
    if (name && (keys.includes(name) || GUARD.test(name))) found = true;
  });
  return found;
}

export const id = "no-unguarded-status-write";
export const pack = "orm";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      unguarded: "This update sets {{key}} without checking what it is now, so two requests can race and a row can jump to a state it should never reach from its current one (a canceled order marked shipped). Add the allowed current states to the where clause, as in .where(and(eq(t.id, id), inArray(t.{{key}}, ['paid']))), and check that a row was updated.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isScriptFile(context) && !isTestFile(context),
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        const values = /** @type {any} */ (node.arguments[0]);
        // Drizzle's `db.update(table).set({ status })`, with `.where(...)` straight after. With no where at all,
        // no-unscoped-write reports it.
        if (callee.type !== "MemberExpression" || callee.property.name !== "set" || values?.type !== "ObjectExpression") return;
        if (callee.object.type !== "CallExpression" || callee.object.callee.property?.name !== "update") return;
        const keys = stateKeys(values);
        const member = node.parent;
        if (!keys.length || member?.type !== "MemberExpression" || member.property.name !== "where" || member.parent?.type !== "CallExpression") return;
        if (!guards(member.parent.arguments[0], keys)) context.report({ node, messageId: "unguarded", data: { key: keys[0] } });
      },
    };
  },
});

export const bad = [
  "await db.update(orders).set({ status: 'shipped' }).where(eq(orders.id, id));",
  "await tx.update(campaigns).set({ deliveryState: next, updatedAt: new Date() }).where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)));",
  "export const cancel = (id: string) => db.update(subscriptions).set({ status: 'canceled' }).where(eq(subscriptions.id, id)).returning();",
];

export const good = [
  "await db.update(orders).set({ status: 'shipped' }).where(and(eq(orders.id, id), eq(orders.status, 'paid')));",
  "await db.update(orders).set({ status: next }).where(and(eq(orders.id, id), inArray(orders.status, sourcesOf(next))));",
  "await db.update(users).set({ status: 'active' }).where(and(eq(users.id, id), movableTo(users.status, userMachine, 'active')));",
  "await db.update(users).set({ status: 'active' }).where(and(eq(users.id, id), canTransitionToActive()));",
  "await db.update(users).set({ name, email }).where(eq(users.id, id));",
];
