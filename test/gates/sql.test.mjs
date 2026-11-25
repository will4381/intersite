// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { sql } from "../../gates/sql.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { tempPostgres } from "./postgres.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await sql({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [], protected: [] })).findings.map((f) => f.message);

const schema = "CREATE TABLE users (id uuid PRIMARY KEY, email text);\nCREATE TABLE orders (id uuid PRIMARY KEY, total int);\n";

test("a migration that locks or breaks a live table is reported, each with the safe way to do it", async () => {
  const r = repo({ "db/001_init.sql": schema });
  r.write({ "db/002_more.sql": "ALTER TABLE users ADD COLUMN plan text NOT NULL;\nCREATE INDEX users_email ON users (email);\nALTER TABLE orders ADD COLUMN user_id uuid REFERENCES users(id);\nALTER TABLE users DROP COLUMN legacy;\n" });
  assert.deepEqual(await check(r.cwd), [
    "db/002_more.sql:1 adds users.plan NOT NULL with no DEFAULT, which fails on a table that has rows: add a DEFAULT, or add it nullable, backfill, then SET NOT NULL",
    "db/002_more.sql:2 CREATE INDEX on users blocks every write to it until the index is built: use CREATE INDEX CONCURRENTLY (outside a transaction). Before launch, with no writes to block, acknowledge it instead",
    "db/002_more.sql:4 drops a column of users while the deployed code may still read it: ship the code that stops using it first, then drop it in a later migration",
    "db/002_more.sql:3 orders(user_id) references users but no index starts with (user_id), so deleting a users row or joining scans orders: CREATE INDEX CONCURRENTLY ON orders (user_id)",
  ]);
});

test("a table created in the same migration is not live yet, and old migrations are not this change's", async () => {
  const r = repo({ "db/001_init.sql": `${schema}ALTER TABLE users DROP COLUMN legacy;\n` });
  r.write({ "db/002_new.sql": "CREATE TABLE plans (id uuid PRIMARY KEY, name text NOT NULL);\nCREATE INDEX plans_name ON plans (name);\nALTER TABLE plans ADD COLUMN code text NOT NULL;\n" });
  assert.deepEqual(await check(r.cwd), []);
});

test("queries in code that scan, return wrong answers or run once per loop item are reported", async () => {
  const r = repo({ "db/001_init.sql": `${schema}CREATE INDEX users_email ON users (email);\n` });
  r.write({
    "src/users.ts": [
      "export const find = (q) => db.query(`SELECT id FROM users WHERE email LIKE '%' || ${q}`);",
      "export const byEmail = (e) => db.query(`SELECT id FROM users WHERE lower(email) = ${e}`);",
      "export const wipe = () => sql`DELETE FROM orders`;",
      "export async function totals(ids) {",
      "  for (const id of ids) {",
      "    await prisma.order.findUnique({ where: { id } });",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  assert.deepEqual(await check(r.cwd), [
    "src/users.ts:1 LIKE '%' || $1 starts with a wildcard, so no b-tree index can serve it and every row is read: anchor the pattern at the start, or add a pg_trgm GIN index",
    "src/users.ts:2 lower(email) in a comparison cannot use the index on users(email), so every row is read: index the expression (CREATE INDEX CONCURRENTLY ON users (lower(email))) or compare the column itself",
    "src/users.ts:3 DELETE with no WHERE removes every row of the table: add the WHERE that picks the rows meant",
    "src/users.ts:6 prisma.order.findUnique runs once per item of the loop at line 5, a round trip each: fetch them all in one query before the loop (an IN list, findMany, or a join), or batch the writes into one statement",
  ]);
});

test("with INTERSITE_DATABASE_URL, a new query the planner would answer by scanning a large table names the index to add", async (t) => {
  const pg = await tempPostgres();
  if (!pg) return t.skip("Postgres (initdb) is not installed");
  t.after(pg.stop);
  pg.psql("CREATE TABLE orders (id serial PRIMARY KEY, customer_id int, total int); INSERT INTO orders (customer_id, total) SELECT g % 500, g FROM generate_series(1, 20000) g; ANALYZE orders;");
  const r = repo({});
  r.write({ "src/orders.ts": 'export const byCustomer = (id) => pool.query("SELECT id, total FROM orders WHERE customer_id = $1", [id]);\n' });
  process.env.INTERSITE_DATABASE_URL = pg.url;
  t.after(() => delete process.env.INTERSITE_DATABASE_URL);
  assert.deepEqual(await check(r.cwd), ["src/orders.ts:1 the planner reads all ~20000 rows of orders for this query (Seq Scan, Filter: (customer_id = $1)): CREATE INDEX CONCURRENTLY ON orders (customer_id)"]);
  assert.equal(pg.psql("SELECT count(*) FROM orders"), "20000", "planning never ran the query");
});

test("a database reset added to a script that runs unattended, and a Supabase table without row level security, are reported", async () => {
  const r = repo({ "package.json": JSON.stringify({ name: "x", scripts: { build: "next build" } }, null, 2), "supabase/migrations/001_init.sql": "create table public.notes (id uuid primary key);\nalter table public.notes enable row level security;\n" });
  r.write({
    "package.json": JSON.stringify({ name: "x", scripts: { build: "prisma db push --accept-data-loss && next build", "db:reset": "prisma migrate reset" } }, null, 2),
    "supabase/migrations/002_tags.sql": "create table public.tags (id uuid primary key, name text);\n",
    "src/notes.ts": "export const clear = () => supabase.from('notes').delete();\n",
  });
  assert.deepEqual(await check(r.cwd), [
    "src/notes.ts:1 .delete() on notes has no filter, so it targets every row (Supabase refuses it with \"requires a WHERE clause\"; other clients run it): add .eq(...) or .in(...) for the rows meant",
    "package.json:4 `prisma db push --accept-data-loss` deletes the database's data, and the `build` script, which runs on its own, runs it against whatever database it points at, production included: deploy with `prisma migrate deploy`, `drizzle-kit migrate` or `supabase db push`, and run resets by hand against a local database only",
    "supabase/migrations/002_tags.sql:1 creates tags in the public schema without row level security, so anyone with the anon key the app ships can read and change every row through the API: ALTER TABLE tags ENABLE ROW LEVEL SECURITY, with policies for who may read and write",
  ]);
});
