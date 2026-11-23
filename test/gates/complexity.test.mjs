// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

/** A function whose every branch costs 3 (an `if`, and an `if` inside it): `n` branches score 3n. @param {number} n */
const pick = (n) => `export function pick(a, b) {\n${Array.from({ length: n }, (_, i) => `  if (a === ${i}) { if (b) return ${i}; }\n`).join("")}  return -1;\n}\n`;
const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

test("a function the change made too complex is reported with its score before and after", async () => {
  const r = repo({ "src/pick.js": pick(4) });
  r.write({ "src/pick.js": pick(10) });
  const { code, out } = await run(r.cwd, ["complexity"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/pick.js:1 pick has cognitive complexity 30 (was 12): split it into named steps; do not just move its branches into a lookup of closures"]);
  assert.match(out[0], /"target": "src\/pick\.js:pick"/);
});

test("a new function over the bar is reported; tests and a small nudge to one already over it are not", async () => {
  const r = repo({ "src/old.js": pick(10) });
  r.write({ "src/new.js": pick(9), "src/old.js": pick(11), "test/pick.test.js": pick(20) });
  const { code, out } = await run(r.cwd, ["complexity"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/new.js:1 pick has cognitive complexity 27 (a new function): split it into named steps; do not just move its branches into a lookup of closures"]);
});

test("a change that keeps every function simple passes", async () => {
  const r = repo({ "src/pick.js": pick(2) });
  r.write({ "src/pick.js": pick(5) });
  const { code, out } = await run(r.cwd, ["complexity"]);
  assert.equal(code, 0);
  assert.deepEqual(out, ["ok gate complexity: 1 changed functions checked"]);
});
