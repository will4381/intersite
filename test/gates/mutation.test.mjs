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

test("a real test kills every mutant of the changed lines and exits 0", async () => {
  const r = change("assert.equal(clamp(5, 0, 10), 5);\nassert.equal(clamp(-1, 0, 10), 0);\nassert.equal(clamp(11, 0, 10), 10);\n");
  const { code, out } = await run(r.cwd, ["mutation"]);
  assert.deepEqual(out, ["ok gate mutation: 2/2 mutants killed"]);
  assert.equal(code, 0);
  assert.equal(r.worktrees(), 1);
});

test("a test that only checks the function exists leaves survivors and exits 1", async () => {
  const r = change("assert.equal(typeof clamp, 'function');\n");
  const { code, out } = await run(r.cwd, ["mutation", "--max", "5"]);
  assert.equal(code, 1);
  assert.deepEqual(
    out.map((line) => line.split(" | ")[0]),
    ["src/clamp.mjs:4 survived '<' → '>='", "src/clamp.mjs:5 survived '>' → '<='"],
  );
  assert.match(out[0], /\| to accept: add \{ "gate": "mutation", "target": "src\/clamp\.mjs:4", "why": "…" \}/);
  assert.equal(r.worktrees(), 1);
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
  assert.deepEqual(out, ["ok gate mutation: 2/2 mutants killed"]);
  assert.equal(code, 0);
  assert.equal(r.worktrees(), 1);
});
