// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

test("an unknown gate exits 2 with one line", async () => {
  const r = repo({});
  const { code, out, err } = await run(r.cwd, ["no-such-gate"]);
  assert.equal(code, 2);
  assert.deepEqual(out, []);
  assert.equal(err.length, 1);
  assert.match(err[0], /^intersite gate: unknown gate "no-such-gate"; usage: intersite gate <[^>]*\bartifacts\|unused\b/);
});

test("an unknown base ref exits 2 with one line naming it and gates.base", async () => {
  const r = repo({});
  const { code, err } = await run(r.cwd, ["new-deps", "--base", "origin/nope"]);
  assert.equal(code, 2);
  assert.deepEqual(err, ['gate new-deps: base ref "origin/nope" not found: pass --base <ref> or set "gates.base" in intersite.yml, for example "main"']);
});

test("--json prints the findings as one object", async () => {
  const r = repo({ "package.json": "{}" });
  r.write({ "package.json": JSON.stringify({ dependencies: { a: "1" } }) });
  const { code, out } = await run(r.cwd, ["new-deps", "--json"]);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(out[0]).findings.map((/** @type {{ target: string }} */ f) => f.target), ["a"]);
});
