// @ts-check
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { fixture, runLint, write } from "../lint/fixture.mjs";

test("installed packages are not linted, even in a project with no .gitignore", async () => {
  const cwd = fixture({ "intersite.json": { project: "fresh" }, "src/a.ts": "export const a = 1;\n", "node_modules/dep/index.js": "try { run(); } catch {}\n" });
  assert.deepEqual(await runLint(cwd), { code: 0, out: "ok lint: 1 files, 0 new findings" });
});

test("a path that does not exist is a usage error, not a clean run", async () => {
  const cwd = fixture({ "intersite.json": { project: "fresh" }, "src/a.ts": "export const a = 1;\n" });
  assert.deepEqual(await runLint(cwd, ["src/nope.ts"]), { code: 2, out: "intersite lint: src/nope.ts does not exist" });
});

test("a corrupt baseline is one line saying how to recover", async () => {
  const cwd = fixture({ "intersite.json": { project: "fresh" }, "src/a.ts": "export const a = 1;\n", "intersite-baseline.json": "{ not json" });
  assert.deepEqual(await runLint(cwd), {
    code: 2,
    out: "intersite lint: intersite-baseline.json is not valid JSON: restore it from git, or run `intersite lint --write=init` to record today's findings again",
  });
  assert.equal((await runLint(cwd, ["--write=init"])).code, 0, "the recovery the message names works");
  assert.equal((await runLint(cwd)).code, 0);
});

test("the project's own .oxlintrc.json may have comments and trailing commas, as oxlint allows; a broken one is one line", async () => {
  const cwd = fixture({
    "intersite.json": { project: "own" },
    ".oxlintrc.json": '{\n  // the project\'s own choice\n  "plugins": ["unicorn"],\n  "rules": { "no-debugger": "error", },\n}\n',
    "src/a.ts": "debugger;\n",
  });
  const r = await runLint(cwd, ["--json"]);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(JSON.parse(r.out).findings.map((/** @type {{ rule: string }} */ f) => f.rule), ["eslint/no-debugger"]);
  write(cwd, ".oxlintrc.json", "{ bad");
  const broken = await runLint(cwd);
  assert.equal(broken.code, 2);
  assert.match(broken.out, /^intersite lint: \.oxlintrc\.json is not a valid oxlint config: [^\n]+$/);
});

test("oxlint installed once at a workspace root is found from a package below it", async () => {
  const root = fixture({ "apps/web/intersite.json": { project: "web" }, "apps/web/src/a.ts": "try { run(); } catch {}\n" });
  const r = await runLint(join(root, "apps/web"), ["--json"]);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(JSON.parse(r.out).findings.map((/** @type {{ file: string, rule: string }} */ f) => `${f.file} ${f.rule}`), ["src/a.ts intersite/no-empty-catch"]);
});

test("an invalid lint.custom selector is reported with the parser's reason, not only that a rule crashed", async () => {
  const cwd = fixture({
    "intersite.json": { project: "custom", lint: { custom: [{ id: "no-raw-fetch", selector: "CallExpression[[", message: "Use apiClient." }] } },
    "src/a.ts": "fetch('/x');\n",
  });
  const r = await runLint(cwd);
  assert.equal(r.code, 2);
  assert.match(r.out, /^intersite lint: a lint rule crashed on src\/a\.ts: SyntaxError: [^\n]+$/);
});
