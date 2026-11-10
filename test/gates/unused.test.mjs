// @ts-check
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const base = {
  "package.json": JSON.stringify({ name: "x", bin: { x: "./tools/run.mjs" } }),
  "src/main.ts": `import { a } from "./a";\nimport { b } from "./b";\nconsole.log(a, b);\n`,
  "src/a.ts": `import { helper } from "./helper.js";\nexport const a = helper();\n`,
  "src/b.ts": `import { helper } from "./helper.js";\nexport const b = helper();\n`,
  "src/helper.ts": "export const helper = () => 1;\n",
  "src/old-handler.ts": "export const handle = () => 1;\n",
  "src/server.ts": `import { handle } from "./old-handler";\nhandle();\n`,
};
const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

test("an added file nothing imports is reported, and is not once something imports it", async () => {
  const r = repo(base);
  r.write({ "src/format-price.ts": "export const formatPrice = (n) => n;\n" });
  const first = await run(r.cwd, ["unused"]);
  assert.equal(first.code, 1);
  assert.deepEqual(lines(first.out), ["src/format-price.ts is added but no other file imports or names it: wire it in, or delete it"]);
  assert.match(first.out[0], / \| to accept: add \{ "gate": "unused", "target": "src\/format-price\.ts", "why": "…" \}/);
  r.write({ "src/main.ts": `${base["src/main.ts"]}import { formatPrice } from "./format-price.js";\nconsole.log(formatPrice(1));\n` });
  const second = await run(r.cwd, ["unused"]);
  assert.deepEqual(second.out, ["ok gate unused: 1 added files, 1 added exports and 0 removed imports checked against 9 files"]);
});

test("tests, routes, configs, package.json bins and gates.entryPaths are not reported", async () => {
  const r = repo(base, { entryPaths: ["jobs/**"] });
  r.write({
    "src/a.test.ts": "",
    "src/routes/users.ts": "export const loader = () => 1;\n",
    "vite.config.ts": "export const config = {};\n",
    "tools/run.mjs": "",
    "jobs/nightly.ts": "export const run = 1;\n",
  });
  const { code, out } = await run(r.cwd, ["unused"]);
  assert.equal(code, 0, out.join("\n"));
  assert.match(out[0], /^ok gate unused: 0 added files, 0 added exports/);
});

test("an added export used nowhere is reported, one used in another file or in its own file is not", async () => {
  const r = repo(base);
  r.write({
    "src/helper.ts": "export const helper = () => twice(1);\nexport function neverCalled() {}\nexport function twice(n) { return n * 2; }\nexport const usedElsewhere = 2;\n",
    "src/a.ts": `import { helper, usedElsewhere } from "./helper.js";\nexport const a = helper() + usedElsewhere;\n`,
  });
  const { code, out } = await run(r.cwd, ["unused"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), [
    "src/helper.ts: export neverCalled is used nowhere: delete it",
  ]);
  assert.match(out[0], /"target": "src\/helper\.ts:neverCalled"/);
});

test("removing the last import of a file reports it as left behind, removing one of two does not", async () => {
  const r = repo(base);
  r.write({ "src/server.ts": "export {};\n", "src/b.ts": "export const b = 2;\n" });
  const { code, out } = await run(r.cwd, ["unused"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/old-handler.ts is no longer imported by anything after this change: delete it"]);
});

test("removing the last aliased import of a file reports it as left behind", async () => {
  const r = repo({ ...base, "src/lib/money.ts": "export const cents = 1;\n", "src/pages/buy.ts": `import { cents } from "@/lib/money";\ncents;\n` });
  r.write({ "src/pages/buy.ts": "export {};\n" });
  const { out } = await run(r.cwd, ["unused"]);
  assert.deepEqual(lines(out), ["src/lib/money.ts is no longer imported by anything after this change: delete it"]);
});

test("deleting a file together with its import reports nothing, and an acknowledged target is not reported", async () => {
  const r = repo(base, { acknowledged: [{ gate: "unused", target: "src/spare.ts", why: "wired in next week" }] });
  r.write({ "src/server.ts": "export {};\n", "src/spare.ts": "" });
  r.rm("src/old-handler.ts");
  const { code, out } = await run(r.cwd, ["unused"]);
  assert.equal(code, 0, out.join("\n"));
});

test("untracked and committed changes are both seen", async () => {
  const r = repo(base);
  r.write({ "src/one.ts": "" });
  r.commit("one");
  r.write({ "src/two.ts": "" });
  const { out } = await run(r.cwd, ["unused"]);
  assert.deepEqual(out.map((line) => line.split(" ")[0]), ["src/one.ts", "src/two.ts"]);
});

test("indexes 4,000 files and reports its CPU time", async (t) => {
  /** @type {Record<string, string>} */
  const files = {};
  for (let i = 0; i < 4000; i++) {
    const body = Array.from({ length: 40 }, (_, j) => `  const v${j} = input.field${(i * 7 + j) % 97} * ${i} + ${j};`).join("\n");
    files[`src/m${Math.floor(i / 100)}/f${i}.ts`] = `import { f${i + 1} } from "./f${i + 1}.js";\nexport function f${i}(input) {\n${body}\n  return v39;\n}\n`;
  }
  const r = repo(files);
  t.after(() => rmSync(r.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  r.write({ "src/new.ts": "export const lonely = 1;\n" });
  const started = process.cpuUsage();
  const { code, out } = await run(r.cwd, ["unused"]);
  const used = process.cpuUsage(started);
  const ms = (used.user + used.system) / 1000;
  console.error(`unused on 4,000 files: ${Math.round(ms)}ms`);
  assert.equal(code, 1);
  assert.match(out[0], /^src\/new\.ts is added but/);
});
