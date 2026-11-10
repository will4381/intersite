// @ts-check
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const helper = `export function total(items) {
  let sum = 0;
  for (const item of items) {
    if (item.price > 0) sum += item.price * item.count;
  }
  const tax = sum * 0.2;
  return Math.round((sum + tax) * 100) / 100;
}
`;
const util = `export const name = "util";\n\n${helper}`;
const brackets = `import a from "a";\nimport b from "b";\nimport c from "c";\nimport d from "d";\nimport e from "e";\nimport f from "f";\nfoo(() => {\n  bar(() => {\n    baz(() => {\n      x;\n    });\n  });\n});\n`;

test("a pasted 8-line helper is reported with both locations", async () => {
  const r = repo({ "src/util.mjs": util });
  r.write({ "src/a.mjs": `export const a = 1;\n\n${helper.replace("  let", "    let")}` });
  const { code, out } = await run(r.cwd, ["duplicates"]);
  assert.equal(code, 1);
  assert.deepEqual(out, [
    `src/a.mjs:3 repeats src/util.mjs:3 (8 lines): reuse it | to accept: add { "gate": "duplicates", "target": "src/a.mjs", "why": "…" } to gates.acknowledged in intersite.yml`,
  ]);
});

test("runs of imports and closing brackets are not reported", async () => {
  const r = repo({ "src/b.mjs": brackets });
  r.write({ "src/c.mjs": brackets.replace("baz", "qux") });
  assert.equal((await run(r.cwd, ["duplicates"])).code, 0);
});

test("code moved within the change is not a duplicate", async () => {
  const r = repo({ "src/util.mjs": util });
  r.write({ "src/util.mjs": `export const name = "util";\n`, "src/moved.mjs": helper });
  const { code, out } = await run(r.cwd, ["duplicates"]);
  assert.equal(code, 0);
  assert.deepEqual(out, ["ok gate duplicates: 1 changed source files checked against 1 tracked files"]);
});

test("indexes and answers on 3,000 files in under two seconds", async (t) => {
  /** @type {Record<string, string>} */
  const files = {};
  for (let i = 0; i < 3000; i++) {
    const body = Array.from({ length: 40 }, (_, j) => `  const v${j} = input.field${(i * 7 + j) % 97} * ${i} + ${j};`).join("\n");
    files[`src/m${Math.floor(i / 100)}/f${i}.ts`] = `export function f${i}(input) {\n${body}\n  return v39;\n}\n`;
  }
  const r = repo(files);
  t.after(() => rmSync(r.cwd, { recursive: true, force: true }));
  r.write({ "src/new.ts": `export function g(input) {\n${files["src/m12/f1234.ts"].split("\n").slice(5, 15).join("\n")}\n}\n` });
  // CPU time, not wall time: other test files run at the same moment and would make a wall-clock limit flaky.
  const started = process.cpuUsage();
  const { code, out } = await run(r.cwd, ["duplicates"]);
  const used = process.cpuUsage(started);
  const ms = (used.user + used.system) / 1000;
  console.error(`duplicates on 3,000 files: ${Math.round(ms)}ms`);
  assert.equal(code, 1);
  assert.match(out[0], /^src\/new\.ts:2 repeats src\/m12\/f1234\.ts:6 \(10 lines\)/);
  assert.ok(ms < 2000, `took ${Math.round(ms)}ms`);
});
