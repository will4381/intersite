// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const base = {
  "package.json": JSON.stringify({ name: "shop", type: "module", dependencies: { zod: "^3" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  "src/money.ts": "export function formatPrice(cents: number) { return `$${cents / 100}`; }\nexport type Currency = 'usd';\nexport default formatPrice;\n",
  "src/index.ts": "export * from './money';\nexport { parse } from './parse.js';\n",
  "src/parse.ts": "export const parse = (s: string) => Number(s);\n",
  "src/legacy.cjs": "module.exports = { old: 1 };\n",
  "src/plain.ts": "export const one = 1;\n",
  "src/cart.ts": "import { formatPrice } from './money';\nexport const total = formatPrice(1);\n",
};
const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

test("an import of a file that does not exist is reported; one that exists, with or without .js, is not", async () => {
  const r = repo(base);
  r.write({ "src/checkout.ts": "import { formatPrice } from './money.js';\nimport { taxFor } from './tax';\nimport { parse } from '@/parse';\nimport { rate } from '@/rates';\nexport const x = [formatPrice, taxFor, parse, rate];\n" });
  const { code, out } = await run(r.cwd, ["imports"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "src/checkout.ts:2 imports \"./tax\", which does not exist: point it at the real file (`intersite search` finds existing code), or create the module; do not add an empty stub just so it resolves",
    "src/checkout.ts:4 imports \"@/rates\", which does not exist: point it at the real file (`intersite search` finds existing code), or create the module; do not add an empty stub just so it resolves",
  ]);
  assert.match(out[0], /"target": "imports:src\/checkout\.ts:\.\/tax"/);
});

test("a name the module does not export is reported with the closest one; names through export * and from CommonJS are not", async () => {
  const r = repo(base);
  r.write({ "src/checkout.ts": "import { formatprice, type Currency, parse } from './index';\nimport { old } from './legacy.cjs';\nimport plain from './plain';\nimport { missing } from './money';\nexport const x = [formatprice, parse, old, plain, missing];\n" });
  const { code, out } = await run(r.cwd, ["imports"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "src/checkout.ts:1 imports `formatprice` from \"./index\", which src/index.ts does not export (did you mean `formatPrice`?): import a name it exports, or export it there; do not add a stub export just to satisfy the import",
    "src/checkout.ts:3 imports a default from \"./plain\", but src/plain.ts has no default export: import one of its named exports with braces",
    "src/checkout.ts:4 imports `missing` from \"./money\", which src/money.ts does not export: import a name it exports, or export it there; do not add a stub export just to satisfy the import",
  ]);
});

test("a package no package.json declares is reported; declared packages, builtins, optional requires and framework modules are not", async () => {
  const r = repo(base);
  r.write({ "src/api.ts": "import { z } from 'zod';\nimport { readFile } from 'node:fs/promises';\nimport path from 'path';\nimport { magic } from 'react-query-helpers-pro';\ntry { require('fsevents'); } catch {}\nimport { ref } from '#imports';\nimport { registerSW } from 'virtual:pwa-register';\nimport { item } from '$lib/items';\nexport const x = [z, readFile, path, magic, ref, registerSW, item];\n" });
  const { code, out } = await run(r.cwd, ["imports"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "src/api.ts:4 imports \"react-query-helpers-pro\", but no package.json declares \"react-query-helpers-pro\" and it is not installed: agents invent package names, so check the real name on npm and add it with the package manager; do not write a local shim under that name",
  ]);
});

test("an unchanged import the change broke, by deleting a file or removing an export, is reported", async () => {
  const r = repo(base);
  r.rm("src/parse.ts");
  r.write({ "src/money.ts": "export function formatCents(cents: number) { return `$${cents / 100}`; }\nexport default formatCents;\n" });
  const { code, out } = await run(r.cwd, ["imports"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "src/cart.ts:1 imports `formatPrice` from \"./money\", which src/money.ts no longer exports (this change removed it): import a name it exports, or export it there; do not add a stub export just to satisfy the import",
    "src/index.ts:2 imports \"./parse.js\", which this change deleted or moved: point the import at its new place",
  ]);
});

test("an untouched repository, and imports of generated files git ignores, pass", async () => {
  const r = repo({ ...base, ".gitignore": "src/codegen/\n" });
  r.write({ "src/db.ts": "import { PrismaClient } from './codegen/client';\nexport const db = new PrismaClient();\n" });
  const { code, out } = await run(r.cwd, ["imports"]);
  assert.equal(code, 0, out.join("\n"));
  assert.match(out[0], /^ok gate imports: \d+ imports in \d+ files checked$/);
});

test("an import whose case differs from the file's is reported, as a case slip where the file system forgives it", async () => {
  const r = repo(base);
  const forgiving = existsSync(join(r.root, "SRC/MONEY.TS"));
  r.write({ "src/checkout.ts": "import { formatPrice } from './Money';\nexport const x = formatPrice;\n" });
  const { code, out } = await run(r.cwd, ["imports"]);
  assert.equal(code, 1, out.join("\n"));
  const expected = forgiving
    ? "src/checkout.ts:1 imports \"./Money\", but the file is src/money.ts: the case differs, which macOS forgives and Linux, CI and production do not; match the file name's case"
    : "src/checkout.ts:1 imports \"./Money\", which does not exist: point it at the real file (`intersite search` finds existing code), or create the module; do not add an empty stub just so it resolves";
  assert.deepEqual(lines(out), [expected]);
});
