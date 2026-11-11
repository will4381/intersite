// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const rules = { protected: [{ paths: ["src/money/**"], why: "money code changes with a test" }] };

test("a change to a protected path fails until a test changes with it", async () => {
  const r = repo({ "src/money/pay.mjs": "export const fee = 1;\n", "src/other.mjs": "export const o = 1;\n", "test/pay.test.mjs": "// tests\n" }, rules);
  r.write({ "src/other.mjs": "export const o = 2;\n" });
  assert.deepEqual((await run(r.cwd, ["protected"])).out, ["ok gate protected: 1 protected path rules checked against 1 changed files"]);

  r.write({ "src/money/pay.mjs": "export const fee = 2;\n" });
  const failed = await run(r.cwd, ["protected"]);
  assert.equal(failed.code, 1);
  assert.match(failed.out[0], /^src\/money\/pay\.mjs changed with no change under .*: money code changes with a test \| to accept: add \{ "gate": "protected", "target": "src\/money\/\*\*"/);

  r.write({ "test/pay.test.mjs": "// tests\n// one more\n" });
  assert.equal((await run(r.cwd, ["protected"])).code, 0);
});

test("needs names what must change instead of a test", async () => {
  const r = repo({ "api/routes.mjs": "export const r = 1;\n", "openapi.json": "{}\n" }, { protected: [{ paths: ["api/**"], needs: ["openapi.json"] }] });
  r.write({ "api/routes.mjs": "export const r = 2;\n" });
  assert.equal((await run(r.cwd, ["protected"])).code, 1);
  r.write({ "openapi.json": "{ }\n" });
  assert.equal((await run(r.cwd, ["protected"])).code, 0);
});
