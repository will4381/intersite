// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

// Two mutable operators in code; the ones in the comment and the string must be left alone.
const clamp = `// keep a > b && c in comments
export function clamp(n, lo, hi) {
  const note = "n < lo || n > hi === true";
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
`;
const head = `import assert from "node:assert/strict";\nimport { clamp } from "../src/clamp.mjs";\n`;

/** @param {string} testBody uncommitted test/clamp.test.mjs after the import lines */
function change(testBody) {
  const r = repo({ "src/clamp.mjs": "export const clamp = (n) => n;\n" }, { testCmd: "node test/clamp.test.mjs" });
  r.write({ "src/clamp.mjs": clamp, "test/clamp.test.mjs": head + testBody });
  return r;
}

test("a real test kills the removed body and every operator flip of the changed lines, and exits 0", async () => {
  const r = change("assert.equal(clamp(5, 0, 10), 5);\nassert.equal(clamp(-1, 0, 10), 0);\nassert.equal(clamp(11, 0, 10), 10);\n");
  const { code, out } = await run(r.cwd, ["mutation"]);
  assert.deepEqual(out, ["ok gate mutation: 3/3 mutants killed"]);
  assert.equal(code, 0);
  assert.equal(r.worktrees(), 1);
});

test("a test that only checks the function exists: its removed body survives, and nothing inside it is tried", async () => {
  const r = change("assert.equal(typeof clamp, 'function');\n");
  const { code, out } = await run(r.cwd, ["mutation", "--max", "5"]);
  assert.equal(code, 1);
  assert.deepEqual(out.map((line) => line.split(" | ")[0]), [
    "src/clamp.mjs:2 no test notices when clamp's body is removed: write a test that fails on this mutant and passes on the real code",
  ]);
  assert.match(out[0], /\| to accept: add \{ "gate": "mutation", "target": "src\/clamp\.mjs:clamp", "why": "…" \}/);
  assert.equal(r.worktrees(), 1);
});

test("an operator flip no test notices is reported with the mutated line", async () => {
  const r = repo({ "src/discount.mjs": "export const discount = (t) => t;\n" }, { testCmd: "node test/discount.test.mjs" });
  r.write({
    "src/discount.mjs": "export function discount(total) {\n  let d = 0;\n  if (total > 100) d = 10;\n  return total - d;\n}\n",
    "test/discount.test.mjs": 'import assert from "node:assert/strict";\nimport { discount } from "../src/discount.mjs";\nassert.equal(discount(50), 50);\n',
  });
  const { code, out } = await run(r.cwd, ["mutation"]);
  assert.equal(code, 1);
  assert.deepEqual(out.map((line) => line.split(" | ")[0]), [
    "src/discount.mjs:4 no test fails when '-' becomes '+' (`return total + d;`): write a test that fails on this mutant and passes on the real code",
  ]);
});

test("survivors are reported at most three per file, and that file is not mutated further", async () => {
  const r = repo({ "src/score.mjs": "export const score = () => 1;\n" }, { testCmd: "node test/score.test.mjs" });
  r.write({
    "src/score.mjs": "export function score(a, b) {\n  const x = a - 1;\n  const y = b - 1;\n  const z = a + b;\n  const w = b + 2;\n  return 0 * (x + y + z + w) + 1;\n}\n",
    "test/score.test.mjs": 'import assert from "node:assert/strict";\nimport { score } from "../src/score.mjs";\nassert.equal(score(1, 2), 1);\n',
  });
  const { code, out } = await run(r.cwd, ["mutation", "--json"]);
  assert.equal(code, 1);
  const report = JSON.parse(out[0]);
  assert.deepEqual(report.findings.map((/** @type {{ line: number }} */ f) => f.line), [2, 3, 4]);
  assert.equal(report.summary, "1/4 mutants killed");
});

test("a failing baseline exits 2 and removes the worktree", async () => {
  const r = change("assert.equal(clamp(5, 0, 10), 6);\n");
  const { code, err } = await run(r.cwd, ["mutation"]);
  assert.equal(code, 2);
  assert.deepEqual(err, ["gate mutation: the tests must pass before mutating, and node test/clamp.test.mjs exited 1"]);
  assert.equal(r.worktrees(), 1);
});

test("a mutant that hangs the tests times out, counts as killed, and the worktree is removed", async () => {
  const r = change("if (clamp(5, 0, 10) !== 5) while (true);\n");
  const { code, out } = await run(r.cwd, ["mutation", "--timeout", "1"]);
  assert.deepEqual(out, ["ok gate mutation: 3/3 mutants killed"]);
  assert.equal(code, 0);
  assert.equal(r.worktrees(), 1);
});
