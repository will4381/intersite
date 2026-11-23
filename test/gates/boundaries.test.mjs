// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const base = {
  "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "packages/*"] }),
  "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
  "packages/ui/src/index.ts": "export * from './button';\n",
  "packages/ui/src/button.ts": "export const Button = () => 'button';\n",
  "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { "@acme/ui": "workspace:*", next: "15", pg: "8" } }),
  "apps/web/lib/db.ts": "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
  "apps/web/lib/data.ts": "import { pool } from './db';\nexport const load = () => pool.query('select 1');\n",
  "apps/web/lib/format.ts": "export const fmt = (n: number) => String(n);\nexport function key() { return process.env.SECRET_KEY; }\n",
  "apps/web/lib/actions.ts": "'use server';\nimport { pool } from './db';\nexport async function save() { await pool.query('select 1'); }\n",
  "apps/admin/package.json": JSON.stringify({ name: "admin" }),
  "apps/admin/src/a.ts": "export const a = 1;\n",
};
const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

test("a relative import into another workspace package and an undeclared workspace package are reported", async () => {
  const r = repo(base);
  r.write({
    "apps/web/app/page.tsx": "import { Button } from '../../../packages/ui/src/button';\nimport { Button as B } from '@acme/ui';\nexport default function Page() { return [Button, B]; }\n",
    "apps/admin/src/b.ts": "import { Button } from '@acme/ui';\nimport type { Button as T } from '@acme/ui';\nexport const b: T = Button;\n",
    "apps/web/scripts/seed.ts": "import { Button } from '../../../packages/ui/src/button';\nconsole.log(Button);\n",
  });
  const { code, out } = await run(r.cwd, ["boundaries"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "apps/admin/src/b.ts:1 imports workspace package @acme/ui, which apps/admin/package.json does not declare: add \"@acme/ui\": \"workspace:*\" (or its version) to its dependencies, so installs, builds and caches know this package needs it",
    "apps/web/app/page.tsx:1 imports \"../../../packages/ui/src/button\", a file inside package @acme/ui (packages/ui), by relative path: import it by its package name and declare it in apps/web/package.json; a relative path skips that package's build, exports and dependencies",
  ]);
});

test("a new barrel file is reported, a package entry is not, and neither is one where the project keeps barrels", async () => {
  const r = repo(base);
  r.write({ "apps/web/components/a.ts": "export const a = 1;\n", "apps/web/components/b.ts": "export const b = 2;\n", "apps/web/components/index.ts": "export * from './a';\nexport { b } from './b';\n" });
  const first = await run(r.cwd, ["boundaries"]);
  assert.equal(first.code, 1, first.out.join("\n"));
  assert.deepEqual(lines(first.out), ["apps/web/components/index.ts is a new barrel file, made only of re-exports: every import of it loads all it re-exports (slower builds, tests and pages, and import cycles through it): import the files directly; do not add index files to group exports"]);

  const kept = repo({ ...base, "apps/web/x/index.ts": "export * from '../lib/format';\n", "apps/web/y/index.ts": "export * from '../lib/format';\n", "apps/web/z/index.ts": "export * from '../lib/format';\n" });
  kept.write({ "apps/web/components/a.ts": "export const a = 1;\n", "apps/web/components/index.ts": "export * from './a';\n" });
  const second = await run(kept.cwd, ["boundaries"]);
  assert.equal(second.code, 0, second.out.join("\n"));
});

test("a client module reaching server-only code is reported with the chain; browser-safe code and server actions are not", async () => {
  const r = repo(base);
  r.write({
    "apps/web/components/menu.tsx": "'use client';\nimport { load } from '../lib/data';\nimport { fmt } from '../lib/format';\nimport { save } from '../lib/actions';\nexport function Menu() { return [load, fmt, save]; }\n",
  });
  const { code, out } = await run(r.cwd, ["boundaries"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "apps/web/components/menu.tsx:2 imports \"../lib/data\" into client code: apps/web/components/menu.tsx → apps/web/lib/data.ts → apps/web/lib/db.ts (imports pg), so server-only code ships to the browser bundle, where it breaks or leaks: keep the server part behind a server action or route and import only browser-safe modules here; do not mark the server module \"use client\"",
  ]);
});

test("configured layers and features report an import upward or across features", async () => {
  const r = repo({ ...base, "apps/web/src/shared/ui.ts": "export const ui = 1;\n", "apps/web/src/features/cart/cart.ts": "export const cart = 1;\n", "apps/web/src/app/page.ts": "export const page = 1;\n" }, {
    layers: [{ name: "app", paths: ["apps/web/src/app/**"] }, { name: "features", paths: ["apps/web/src/features/**"] }, { name: "shared", paths: ["apps/web/src/shared/**"] }],
    features: "apps/web/src/features/*",
  });
  r.write({
    "apps/web/src/shared/helpers.ts": "import { page } from '../app/page';\nexport const h = page;\n",
    "apps/web/src/features/orders/orders.ts": "import { cart } from '../cart/cart';\nimport { ui } from '../../shared/ui';\nexport const o = [cart, ui];\n",
  });
  const { code, out } = await run(r.cwd, ["boundaries"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "apps/web/src/features/orders/orders.ts:1 imports apps/web/src/features/cart/cart.ts from feature cart into feature orders: features do not import each other; move what both need into a shared folder",
    "apps/web/src/shared/helpers.ts:1 imports apps/web/src/app/page.ts from layer app, above its own layer shared: layers import only downward (app > features > shared); move what both need down a layer, or pass it in from above",
  ]);
});

test("an untouched repository passes", async () => {
  const { code, out } = await run(repo(base).cwd, ["boundaries"]);
  assert.equal(code, 0, out.join("\n"));
  assert.deepEqual(out, ["ok gate boundaries: no changed code"]);
});
