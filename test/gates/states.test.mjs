// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);
const orders = "create table orders (\n  id uuid primary key,\n  status text not null check (status in ('new', 'paid', 'refunded'))\n);\n";
const setStatus = (/** @type {string} */ status) => `export const settle = (db, id) => db.query("UPDATE orders SET status = '${status}' WHERE id = $1", [id]);\n`;

test("a status the change writes that the column's check does not allow is reported, and is not once it is one the column has", async () => {
  const r = repo({ "supabase/migrations/001_init.sql": orders });
  r.write({ "src/orders.ts": setStatus("canceled") });
  const first = await run(r.cwd, ["states"]);
  assert.equal(first.code, 1);
  assert.deepEqual(lines(first.out), [
    "src/orders.ts:1 writes 'canceled' to orders.status, which the check on orders.status does not allow (new, paid, refunded): the database refuses the write.",
  ]);
  assert.match(first.out[0], /"target": "states:unknown:orders\.status=canceled"/);
  r.write({ "src/orders.ts": setStatus("refunded") });
  const second = await run(r.cwd, ["states"]);
  assert.equal(second.code, 0, second.out.join("\n"));
  assert.match(second.out[0], /^ok gate states: 1 values in code checked against 1 closed sets of values, 0 not allowed and 0 suggestions$/);
});

test("a fixture, a mock or an end-to-end helper may make a status up, and a script may not", async () => {
  const r = repo({
    "supabase/migrations/001_init.sql": orders,
    "lint/__fixtures__/bad.ts": setStatus("canceled"),
    "src/orders.mock.ts": setStatus("canceled"),
    "e2e/support/api.ts": setStatus("canceled"),
    "scripts/repair.ts": setStatus("canceled"),
  });
  const { code, out } = await run(r.cwd, ["states", "--all"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), [
    "scripts/repair.ts:1 writes 'canceled' to orders.status, which the check on orders.status does not allow (new, paid, refunded): the database refuses the write.",
  ]);
});

test("judging everything suggests naming a list of statuses tested in three files and a step written in four functions, in product code", async () => {
  const prisma = ["enum Status {", "  open", "  held", "  closed", "}", "", "model Ticket {", "  id     String @id", "  status Status", "}", ""].join("\n");
  const waiting = (/** @type {string} */ name) => `export const ${name} = (db) => db.ticket.findMany({ where: { status: { in: ["open", "held"] } } });\n`;
  const close = (/** @type {string} */ name) => `export const ${name} = (db, id) => db.ticket.update({ where: { id }, data: { status: "closed" } });\n`;
  const r = repo({
    "prisma/schema.prisma": prisma,
    "src/a.ts": waiting("waitingA") + close("closeA") + close("closeAgain"),
    "src/b.ts": waiting("waitingB") + close("closeB"),
    "src/c.ts": waiting("waitingC") + close("closeC"),
    // A script is held to the values a column allows, and is not a copy of the product's rule.
    "scripts/repair.ts": waiting("waitingRepair") + close("closeRepair"),
  });
  assert.equal((await run(r.cwd, ["states"])).code, 0, "nothing added, nothing judged");
  const { code, out } = await run(r.cwd, ["states", "--all"]);
  assert.equal(code, 0, "a rule written many times is suggested, and fails nothing");
  assert.deepEqual(lines(out), [
    "ok gate states: 13 values in code checked against 1 closed sets of values, 0 not allowed and 2 suggestions",
    "suggestion: src/a.ts:1 ticket.status is tested against (held, open) in 3 files (also src/b.ts:1, src/c.ts:1): one rule, which values count, written 3 times, and the next value has to be added to each. Name the list once and use that.",
    "suggestion: src/a.ts:2 ticket.status is set to 'closed' in 4 functions in 3 files (also src/a.ts:3, src/b.ts:2, src/c.ts:2): one step of the workflow written 4 times, each free to forget what the others do with it. Give the step one function and call it.",
  ]);
});
