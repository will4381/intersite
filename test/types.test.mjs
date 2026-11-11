// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("every export a TypeScript project can import has a declaration", async () => {
  for (const module of ["capture", "track"]) {
    const declared = readFileSync(new URL(`../${module}/index.d.mts`, import.meta.url), "utf8");
    for (const name of Object.keys(await import(`../${module}/index.mjs`))) {
      assert.match(declared, new RegExp(`export (?:function|const) ${name}\\b`), `${module}/index.d.mts does not declare ${name}`);
    }
  }
});
