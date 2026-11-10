// @ts-check
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const a = `import assert from "node:assert/strict";
import { test } from "node:test";
// expect(this) is a comment and is not counted
test("adds", () => {
  assert.equal(1 + 1, 2);
  assert.ok("assert(not counted)");
});
test("subtracts", () => {
  assert.equal(2 - 1, 1);
});
`;
const b = `import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("b", () => assert.equal(1, 1));\n`;
const files = { "src/math.mjs": "export const one = 1;\n", "test/a.test.mjs": a, "test/b.test.mjs": b };

test("deleting a test file is reported, even uncommitted", async () => {
  const r = repo(files);
  r.rm("test/b.test.mjs");
  const { code, out } = await run(r.cwd, ["test-integrity"]);
  assert.equal(code, 1);
  assert.equal(out.length, 1);
  assert.match(out[0], /^test\/b\.test\.mjs: test file deleted \| to accept: add \{ "gate": "test-integrity", "target": "test\/b\.test\.mjs", "why": "…" \} to gates\.acknowledged in intersite\.yml$/);
});

test("removing an assertion, removing a test and adding a skip are each reported", async () => {
  for (const [edit, expected] of [
    [a.replace('  assert.ok("assert(not counted)");\n', ""), /assertions 3 → 2/],
    [a.replace(/test\("subtracts"[^]*$/, ""), /tests 2 → 1, assertions 3 → 2/],
    [a.replace('test("adds"', 'test.skip("adds"'), /skips and todos 0 → 1/],
  ]) {
    const r = repo(files);
    r.write({ "test/a.test.mjs": /** @type {string} */ (edit) });
    const { code, out } = await run(r.cwd, ["test-integrity"]);
    assert.equal(code, 1);
    assert.match(out[0], /** @type {RegExp} */ (expected));
  }
});

test("a committed change is compared with base too", async () => {
  const r = repo(files);
  r.write({ "test/a.test.mjs": a.replace("test(", "test.todo(") });
  r.commit("todo");
  assert.equal((await run(r.cwd, ["test-integrity"])).code, 1);
});

test("adding tests, removing a comment, and a rename with the same content pass", async () => {
  const r = repo(files);
  r.write({ "test/a.test.mjs": `${a.replace("// expect(this) is a comment and is not counted\n", "")}test("more", () => assert.ok(true));\n`, "test/c.test.mjs": b });
  renameSync(join(r.cwd, "test/b.test.mjs"), join(r.cwd, "test/renamed.test.mjs"));
  const { code, out } = await run(r.cwd, ["test-integrity"]);
  assert.equal(code, 0);
  assert.deepEqual(out, ["ok gate test-integrity: 3 changed test files checked"]);
});

test("an acknowledged target is not reported", async () => {
  const r = repo(files, { acknowledged: [{ gate: "test-integrity", target: "test/b.test.mjs", why: "merged into a.test.mjs" }] });
  r.rm("test/b.test.mjs");
  assert.equal((await run(r.cwd, ["test-integrity"])).code, 0);
});
