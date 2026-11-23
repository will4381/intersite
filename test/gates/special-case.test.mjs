// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);
const base = {
  "package.json": JSON.stringify({ name: "x" }),
  "src/price.ts": "export function price(id: string) {\n  return lookup(id);\n}\n",
  "src/price.test.ts": "import { price } from './price';\ntest('price', () => { expect(price('base-1')).toBe(1); });\n",
};

test("a branch on a changed test's input that returns its expected value is reported", async () => {
  const r = repo(base);
  r.write({
    "src/price.test.ts": "import { price } from './price';\ntest('price', () => { expect(price('abc-123')).toBe(4200); });\n",
    "src/price.ts": "export function price(id: string) {\n  if (id === 'abc-123') return 4200;\n  return lookup(id);\n}\n",
  });
  const { code, out } = await run(r.cwd, ["special-case"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/price.ts:2 returns 4200 when the input is \"abc-123\", exactly what a changed test expects for that input: the code answers the test instead of computing it; write the general logic, and do not hard-code test values"]);
});

test("production code that branches on running under a test runner is reported; env modules and setup are not", async () => {
  const r = repo(base);
  r.write({
    "src/mail.ts": "export async function send(to: string) {\n  if (process.env.NODE_ENV === 'test') return;\n  await smtp.send(to);\n}\n",
    "src/env.ts": "export const isTest = process.env.NODE_ENV === 'test';\n",
    "vitest.setup.ts": "if (process.env.VITEST) globalThis.fetch = fake;\n",
  });
  const { code, out } = await run(r.cwd, ["special-case"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/mail.ts:2 branches on running under a test runner, so the tests check different code than production runs: make the behavior a parameter or dependency the test passes in, and do not detect the test environment"]);
});

test("general logic that a test happens to exercise passes", async () => {
  const r = repo(base);
  r.write({
    "src/price.test.ts": "import { price } from './price';\ntest('price', () => { expect(price('premium-plan')).toBe(2500); expect(price('admin')).toBe(true); });\n",
    "src/price.ts": "export function price(id: string) {\n  if (id === 'admin') return true;\n  return PLANS[id].cents;\n}\n",
  });
  const { code, out } = await run(r.cwd, ["special-case"]);
  assert.equal(code, 0, out.join("\n"));
});
