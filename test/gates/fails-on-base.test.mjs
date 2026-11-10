// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

/**
 * A repo whose base commit has a buggy `add`, and whose HEAD fixes it and adds `testSource` as test/add.test.mjs.
 * @param {string} testSource
 */
function fixed(testSource) {
  const r = repo({ "add.mjs": "export const add = (a, b) => a - b;\n" });
  r.write({
    "add.mjs": "export const add = (a, b) => a + b;\n",
    "test/add.test.mjs": `import assert from "node:assert/strict";\nimport { add } from "../add.mjs";\n${testSource}\n`,
  });
  r.commit("fix add");
  return r;
}

const args = ["fails-on-base", "--cmd", "node test/add.test.mjs", "--paths", "test/**"];

test("exits 0 when the new test fails on the base commit, and removes the worktree", async () => {
  const r = fixed("assert.equal(add(2, 2), 4);");
  assert.equal((await run(r.cwd, args)).code, 0);
  assert.equal(r.worktrees(), 1);
});

test("exits 1 when the new test passes on the base commit, and removes the worktree", async () => {
  const r = fixed("assert.equal(typeof add, 'function');");
  const { code, out } = await run(r.cwd, args);
  assert.equal(code, 1);
  assert.match(out[0], /^test\/add\.test\.mjs passes on base without the change, so it does not test it; rerun: node test\/add\.test\.mjs \| to accept: /);
  assert.equal(r.worktrees(), 1);
});

test("exits 2 when no changed file matches --paths", async () => {
  const r = fixed("assert.equal(add(2, 2), 4);");
  assert.equal((await run(r.cwd, ["fails-on-base", "--cmd", "true", "--paths", "spec/**"])).code, 2);
});

test("takes the command and paths from intersite.yml, the test from the working tree, and links node_modules", async () => {
  const r = repo({ "add.mjs": "export const add = (a, b) => a - b;\n", ".gitignore": "node_modules\n" }, { testCmd: "node test/dep.test.mjs" });
  r.write({ "node_modules/dep/package.json": '{ "name": "dep", "main": "index.js" }', "node_modules/dep/index.js": "module.exports = 2;\n" });
  // Uncommitted, and passes on base only if `dep` resolves there.
  r.write({ "test/dep.test.mjs": 'import assert from "node:assert/strict";\nimport dep from "dep";\nassert.equal(dep, 2);\n' });
  const { code, out } = await run(r.cwd, ["fails-on-base"]);
  assert.equal(code, 1);
  assert.match(out[0], /^test\/dep\.test\.mjs passes on base/);
  assert.equal(r.worktrees(), 1);
});
