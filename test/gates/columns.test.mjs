// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);
const migration = "create table public.profiles (\n  id uuid primary key,\n  name text not null,\n  bio text default ''\n);\n";
const code = "export const save = (name: string) => supabase.from('profiles').insert({ id: crypto.randomUUID(), name });\n";

test("a column the change adds that no code writes is reported, and is not once the code writes it", async () => {
  const r = repo({ "supabase/migrations/001_init.sql": migration, "src/profile.ts": code });
  r.write({ "supabase/migrations/002_nickname.sql": "alter table public.profiles add column nickname text;\n" });
  const first = await run(r.cwd, ["columns"]);
  assert.equal(first.code, 1);
  assert.deepEqual(lines(first.out), ["supabase/migrations/002_nickname.sql:1 adds profiles.nickname, but no code writes it, so it stays NULL in every row: set it where profiles rows are created or updated, or leave it out. Do not give it a placeholder default to quiet this"]);
  assert.match(first.out[0], /"target": "columns:profiles\.nickname"/);
  r.write({ "src/profile.ts": "export const save = (name: string, nickname: string) => supabase.from('profiles').insert({ id: crypto.randomUUID(), name, nickname });\n" });
  const second = await run(r.cwd, ["columns"]);
  assert.equal(second.code, 0, second.out.join("\n"));
  assert.match(second.out[0], /^ok gate columns: 1 tables and 4 columns checked/);
});

test("code naming a column or table the schema does not have is reported with the closest real name", async () => {
  const r = repo({ "supabase/migrations/001_init.sql": migration, "src/profile.ts": code });
  r.write({ "src/load.ts": "export const load = () => supabase.from('profiles').select('id, nmae');\nexport const pics = () => supabase.storage.from('avatars').list();\n" });
  const { code: exit, out } = await run(r.cwd, ["columns"]);
  assert.equal(exit, 1);
  assert.deepEqual(lines(out), ["src/load.ts:1 profiles has no column nmae (did you mean name?): use a column the schema has, or add it in a migration"]);
});

test("removing the last write of a column is reported where it was removed", async () => {
  const r = repo({
    "db/migrations/001.sql": "create table orders (id uuid primary key, note text, shipped_at timestamptz);\n",
    "src/orders.ts": "export const ship = (id: string) => db.query('UPDATE orders SET note = $1, shipped_at = now() WHERE id = $2', ['x', id]);\n",
  });
  r.write({ "src/orders.ts": "export const ship = (id: string) => db.query('UPDATE orders SET note = $1 WHERE id = $2', ['x', id]);\n" });
  const { code: exit, out } = await run(r.cwd, ["columns"]);
  assert.equal(exit, 1);
  assert.deepEqual(lines(out), ["src/orders.ts:1 the change removes the last write of orders.shipped_at: nothing writes it any more, so new rows leave it NULL. Keep a write, or drop the column in a migration"]);
});

test("--all lists every nullable column nothing writes and every table nothing uses, and --write records them", async () => {
  const r = repo({
    "supabase/migrations/001_init.sql": `${migration}alter table public.profiles add column nickname text;\ncreate table public.audit (id bigserial primary key);\n`,
    "src/profile.ts": code,
  });
  const all = await run(r.cwd, ["columns", "--all"]);
  assert.equal(all.code, 1);
  assert.deepEqual(lines(all.out), [
    "supabase/migrations/001_init.sql:6 nothing writes profiles.nickname, so it is NULL in every row: set it where profiles rows are created or updated, or ALTER TABLE profiles DROP COLUMN nickname in a new migration",
    "supabase/migrations/001_init.sql:7 nothing in the code reads or writes table audit: use it, or drop it in a new migration",
  ]);
  assert.equal((await run(r.cwd, ["columns", "--all", "--write"])).code, 0);
  assert.equal((await run(r.cwd, ["columns", "--all"])).code, 0);
});
