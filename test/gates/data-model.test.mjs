// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);
const shop = "create table customers (id uuid primary key, name text not null);\ncreate table orders (id uuid primary key, total_cents bigint not null);\n";

test("a column the change adds that names a table with no foreign key is reported, and is not once the key is there", async () => {
  const r = repo({ "supabase/migrations/001_init.sql": shop });
  r.write({ "supabase/migrations/002_customer.sql": "alter table orders add column customer_id uuid;\n" });
  const first = await run(r.cwd, ["data-model"]);
  assert.equal(first.code, 1);
  assert.deepEqual(lines(first.out), [
    "supabase/migrations/002_customer.sql:1 orders.customer_id names the customers table and has its key's type, but no foreign key holds it there: it can name a row that is gone. Add the foreign key, or acknowledge why the link is left open",
  ]);
  assert.match(first.out[0], /"target": "data-model:open-link:orders\.customer_id"/);
  r.write({ "supabase/migrations/002_customer.sql": "alter table orders add column customer_id uuid references customers (id);\n" });
  const second = await run(r.cwd, ["data-model"]);
  assert.equal(second.code, 0, second.out.join("\n"));
  assert.match(second.out[0], /^ok gate data-model: 2 tables read, 0 flaws in the data model/);
});

test("judging everything lists what the schema already holds: a fact kept twice, a list of ids, a covered index", async () => {
  const prisma = [
    "model Post {",
    "  id          String    @id @db.Uuid",
    "  authorId    String    @db.Uuid",
    "  isPublished Boolean   @default(false)",
    "  publishedAt DateTime? @db.Timestamptz(6)",
    "  tagIds      String[]  @db.Uuid",
    "",
    "  @@index([authorId, publishedAt])",
    "  @@index([authorId])",
    "}",
    "",
  ].join("\n");
  const r = repo({ "prisma/schema.prisma": prisma });
  assert.equal((await run(r.cwd, ["data-model"])).code, 0, "nothing added, nothing judged");
  const { code, out } = await run(r.cwd, ["data-model", "--all"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), [
    "prisma/schema.prisma:4 post.isPublished and post.publishedAt record one fact twice, a flag and the time it happened: nothing stops them disagreeing. Keep the time and read the flag from it (`publishedAt IS NOT NULL`)",
    "prisma/schema.prisma:6 post.tagIds keeps a list of ids in one column: no foreign key can check them, and a join on them uses no index. A table of its own, one row per id, holds the same link",
    "prisma/schema.prisma:9 the index on post(authorId) is the start of the index on (authorId, publishedAt), which answers the same lookups: every write pays for both. Drop it",
  ]);
});
