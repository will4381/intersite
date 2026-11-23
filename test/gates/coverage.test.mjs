// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const price = `export function parsePrice(text) {\n  return Number(text.replace("$", ""));\n}\n\nexport const formatPrice = (n) => {\n  return "$" + n.toFixed(2);\n};\n\nexport class Cart {\n  total(items) {\n    return items.reduce((sum, i) => sum + i, 0);\n  }\n}\n`;

test("a changed function no test runs is reported; ones the tests call are not", async () => {
  const r = repo({ "src/price.mjs": "export const unused = 1;\n", "package.json": '{ "type": "module" }' }, { testCmd: "node --test" });
  r.write({
    "src/price.mjs": price,
    "test/price.test.mjs": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { parsePrice, Cart } from "../src/price.mjs";\ntest("p", () => { assert.equal(parsePrice("$3"), 3); assert.equal(new Cart().total([1, 2]), 3); });\n',
  });
  const { code, out } = await run(r.cwd, ["coverage"]);
  assert.equal(code, 1);
  assert.deepEqual(out.map((line) => line.split(" | ")[0]), ["src/price.mjs:5 formatPrice runs in no test: add a test that calls it and checks what it returns or does"]);
  assert.match(out[0], /"target": "src\/price\.mjs:formatPrice"/);
});

test("a test command that runs no project code under coverage is a setup error, not a finding per function", async () => {
  const r = repo({ "src/price.mjs": "export const unused = 1;\n" }, { testCmd: "true" });
  r.write({ "src/price.mjs": price });
  const { code, err } = await run(r.cwd, ["coverage"]);
  assert.equal(code, 2);
  assert.match(err[0], /^gate coverage: the test command ran none of the project's code under V8 coverage/);
});

test("without a test command it says how to give one", async () => {
  const r = repo({ "src/price.mjs": "export const unused = 1;\n" });
  r.write({ "src/price.mjs": price });
  const { code, err } = await run(r.cwd, ["coverage"]);
  assert.equal(code, 2);
  assert.match(err[0], /needs a test command/);
});
