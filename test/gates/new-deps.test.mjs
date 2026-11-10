// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const pkg = (/** @type {Record<string, unknown>} */ fields) => JSON.stringify({ name: "x", ...fields }, null, 2);
const files = {
  "package.json": pkg({ dependencies: { kept: "^1.0.0" } }),
  "packages/web/package.json": pkg({ devDependencies: { vite: "^5.0.0" } }),
};

test("a new dependency in the root and in a nested package.json is reported", async () => {
  const r = repo(files);
  r.write({
    "package.json": pkg({ dependencies: { kept: "^1.0.0", "left-pad-ultra": "^1.0.0" } }),
    "packages/web/package.json": pkg({ devDependencies: { vite: "^5.0.0" }, peerDependencies: { react: "^19.0.0" } }),
  });
  const { code, out } = await run(r.cwd, ["new-deps"]);
  assert.equal(code, 1);
  assert.equal(out.length, 2);
  assert.match(out[0], /^package\.json: new dependency "left-pad-ultra": .* \| to accept: add \{ "gate": "new-deps", "target": "left-pad-ultra", "why": "…" \}/);
  assert.match(out[1], /^packages\/web\/package\.json: new dependency "react"/);
});

test("a version bump is not reported", async () => {
  const r = repo(files);
  r.write({ "package.json": pkg({ dependencies: { kept: "^2.0.0" } }) });
  const { code, out } = await run(r.cwd, ["new-deps"]);
  assert.equal(code, 0);
  assert.deepEqual(out, ["ok gate new-deps: 1 changed package.json files checked"]);
});

test("an acknowledged name is not reported", async () => {
  const r = repo(files, { acknowledged: [{ gate: "new-deps", target: "react", why: "the web package renders with React" }] });
  r.write({ "packages/web/package.json": pkg({ devDependencies: { vite: "^5.0.0" }, dependencies: { react: "^19.0.0" } }) });
  assert.equal((await run(r.cwd, ["new-deps"])).code, 0);
});
