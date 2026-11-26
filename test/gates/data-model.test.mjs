// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { tempPostgres } from "./postgres.mjs";
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

test("judging everything lists what the schema already holds: a covered index fails, a fact kept twice and a list of ids are suggested", async () => {
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
    "prisma/schema.prisma:9 the index on post(authorId) is the start of the index on (authorId, publishedAt), which answers the same lookups: every write pays for both. Drop it",
    "suggestion: prisma/schema.prisma:4 post.isPublished and post.publishedAt record one fact twice, a flag and the time it happened: nothing stops them disagreeing. Keep the time and read the flag from it (`publishedAt IS NOT NULL`)",
    "suggestion: prisma/schema.prisma:6 post.tagIds keeps a list of ids in one column: no foreign key can check them, and a join on them uses no index. A table of its own, one row per id, holds the same link",
  ]);
});

test("a matter of design is a suggestion: it is printed, fails nothing, and is not shown once acknowledged", async () => {
  const ship = { "supabase/migrations/002_ship.sql": "alter table orders add column is_shipped boolean not null default false, add column shipped_at timestamptz;\n" };
  const r = repo({ "supabase/migrations/001_init.sql": shop });
  r.write(ship);
  const { code, out } = await run(r.cwd, ["data-model"]);
  assert.equal(code, 0, out.join("\n"));
  assert.equal(out[0], "ok gate data-model: 2 tables read, 0 flaws in the data model and 1 suggestions");
  assert.equal(
    out[1],
    "suggestion: supabase/migrations/002_ship.sql:1 orders.is_shipped and orders.shipped_at record one fact twice, a flag and the time it happened: nothing stops them disagreeing. Keep the time and read the flag from it (`shipped_at IS NOT NULL`) | it fails nothing; to stop seeing it: add { \"gate\": \"data-model\", \"target\": \"data-model:twice-told:orders.is_shipped\", \"why\": \"…\" } to gates.acknowledged in intersite.yml",
  );
  const json = JSON.parse((await run(r.cwd, ["data-model", "--json"])).out[0]);
  assert.equal(json.ok, true);
  assert.deepEqual(json.findings, []);
  assert.deepEqual(json.suggestions.map((/** @type {{ target: string }} */ s) => s.target), ["data-model:twice-told:orders.is_shipped"]);

  const known = repo({ "supabase/migrations/001_init.sql": shop }, { acknowledged: [{ gate: "data-model", target: "data-model:twice-told:orders.is_shipped", why: "the flag is what the report reads" }] });
  known.write(ship);
  assert.deepEqual((await run(known.cwd, ["data-model"])).out, ["ok gate data-model: 2 tables read, 0 flaws in the data model and 1 suggestions"]);
});

test("with INTERSITE_DATABASE_URL, judging everything suggests what the planner's statistics say of the columns", async (t) => {
  const pg = await tempPostgres();
  if (!pg) return t.skip("Postgres (initdb) is not installed");
  t.after(pg.stop);
  const orders = "create table orders (\n  id serial primary key,\n  kind text not null,\n  note text,\n  paid boolean not null,\n  paid_at timestamptz,\n  tier text not null\n);\n";
  // The database holds `tier` to two values with a CHECK no migration in the repository shows: it is not suggested.
  // A CHECK that only names `kind` beside another column does not hold it to its values.
  pg.psql(`${orders} ALTER TABLE orders ADD CONSTRAINT orders_tier_check CHECK (tier IN ('gold', 'plain')); ALTER TABLE orders ADD CONSTRAINT orders_paid_kind_check CHECK (NOT paid OR kind <> 'none'); INSERT INTO orders (kind, paid, paid_at, tier) SELECT (array['retail','retail','retail','trade','trade','gift'])[1 + g % 6], g % 10 < 3, CASE WHEN g % 4 = 0 THEN now() END, CASE WHEN g % 2 = 0 THEN 'gold' ELSE 'plain' END FROM generate_series(1, 6000) g; ANALYZE orders;`);
  const r = repo({ "supabase/migrations/001_init.sql": orders });
  process.env.INTERSITE_DATABASE_URL = pg.url;
  t.after(() => delete process.env.INTERSITE_DATABASE_URL);
  const { code, out } = await run(r.cwd, ["data-model", "--all"]);
  assert.equal(code, 0, out.join("\n"));
  assert.deepEqual(lines(out), [
    "ok gate data-model: 1 tables read, 0 flaws in the data model and 3 suggestions, the statistics of 6 columns read",
    "suggestion: supabase/migrations/001_init.sql:3 orders.kind holds only 3 values in the rows the planner sampled, of about 6000 (retail, trade, gift), and nothing holds it to them: a typo is a new value. Make it an enum, or a CHECK that lists them",
    "suggestion: supabase/migrations/001_init.sql:4 orders.note is NULL in every row the planner sampled, of about 6000: nothing seems to fill it. If nothing is about to, drop it",
    "suggestion: supabase/migrations/001_init.sql:5 orders.paid and orders.paid_at record one fact twice, a flag and the time it happened: nothing stops them disagreeing. Keep the time and read the flag from it (`paid_at IS NOT NULL`). In the data they already disagree: the flag is true in about 30% of the rows and the time is set in about 25%",
  ]);
  assert.equal(pg.psql("SELECT count(*) FROM orders"), "6000");
  // A change is judged on what it declares: no connection is opened, and no statistics are read.
  r.write({ "supabase/migrations/002_region.sql": "alter table orders add column region text;\n" });
  assert.deepEqual((await run(r.cwd, ["data-model"])).out, ["ok gate data-model: 1 tables read, 0 flaws in the data model and 0 suggestions"]);
});
