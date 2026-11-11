// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

test("an unknown gate exits 2 with one line", async () => {
  const r = repo({});
  const { code, out, err } = await run(r.cwd, ["no-such-gate"]);
  assert.equal(code, 2);
  assert.deepEqual(out, []);
  assert.equal(err.length, 1);
  assert.match(err[0], /^intersite gate: unknown gate "no-such-gate"; usage: intersite gate <[^>]*\bartifacts\|unused\b/);
});

test("an unknown base ref exits 2 with one line naming it and gates.base", async () => {
  const r = repo({});
  const { code, err } = await run(r.cwd, ["new-deps", "--base", "origin/nope"]);
  assert.equal(code, 2);
  assert.deepEqual(err, ['gate new-deps: base ref "origin/nope" not found: pass --base <ref> or set "gates.base" in intersite.yml, for example "main"']);
});

test("--json prints the findings as one object", async () => {
  const r = repo({ "package.json": "{}" });
  r.write({ "package.json": JSON.stringify({ dependencies: { a: "1" } }) });
  const { code, out } = await run(r.cwd, ["new-deps", "--json"]);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(out[0]).findings.map((/** @type {{ target: string }} */ f) => f.target), ["a"]);
});

test("with no gates.base, a repository with no origin compares with its main branch, even from a detached HEAD", async () => {
  const r = repo({});
  r.write({ "intersite.json": JSON.stringify({ project: "t" }) });
  r.commit("default base");
  r.git("checkout", "-q", "--detach");
  r.write({ "PLAN.md": "# Plan\n" });
  const { code, out, err } = await run(r.cwd, ["artifacts"]);
  assert.deepEqual(err, []);
  assert.equal(code, 1);
  assert.match(out[0], /^PLAN\.md looks like a working note/);
});

test("a repository with no commits yet treats every file as added", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-unborn-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  writeFileSync(join(cwd, "PLAN.md"), "# Plan\n");
  const { code, out, err } = await run(cwd, ["artifacts"]);
  assert.deepEqual(err, []);
  assert.equal(code, 1);
  assert.match(out[0], /^PLAN\.md looks like a working note/);
});

test("outside a git repository a gate exits 2 with one line saying so", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-nogit-"));
  const { code, err } = await run(cwd, ["artifacts"]);
  assert.equal(code, 2);
  assert.equal(err.length, 1);
  assert.match(err[0], /^gate artifacts: not a git repository/);
});

test("installed packages and .intersite are never part of a change, even with no .gitignore", async () => {
  const r = repo({ "package.json": "{}", "src/a.mjs": "export const a = 1;\n" });
  r.write({ "node_modules/dep/package.json": JSON.stringify({ name: "dep", dependencies: { x: "1" } }), "node_modules/dep/index.js": "module.exports = 1;\n", ".intersite/cases.db": "x" });
  for (const name of ["new-deps", "unused", "artifacts"]) {
    const { code, out } = await run(r.cwd, [name]);
    assert.equal(code, 0, `${name}: ${out.join("\n")}`);
  }
});

test("findings name the main line the default base fell back to, not the missing origin/main", async () => {
  const r = repo({ "test/a.test.mjs": "test('a', () => { assert.ok(1); assert.ok(2); });\n" });
  r.write({ "intersite.json": JSON.stringify({ project: "t" }) });
  r.commit("default base");
  r.write({ "test/a.test.mjs": "test('a', () => { assert.ok(1); });\n" });
  const { out } = await run(r.cwd, ["test-integrity"]);
  assert.match(out[0], /^test\/a\.test\.mjs: assertions 2 → 1 since main \|/);
});

test("--all judges the whole repository, and --write records today's findings so only new ones fail", async () => {
  const twin = (/** @type {string} */ name) => `export function ${name}(items) {\n  const out = [];\n  for (const item of items) {\n    if (!item.active) continue;\n    if (item.total > 100) out.push({ id: item.id, total: item.total * 2 });\n    else out.push({ id: item.id, total: item.total });\n  }\n  return out.sort((a, b) => a.total - b.total);\n}\n`;
  const r = repo({ "src/a.mjs": twin("activeTotals"), "src/b.mjs": twin("liveTotals"), "src/use.mjs": "import { activeTotals } from './a.mjs';\nimport { liveTotals } from './b.mjs';\nconsole.log(activeTotals, liveTotals);\n" });
  assert.equal((await run(r.cwd, ["duplicates"])).code, 0, "nothing changed, so the change is clean");
  const whole = await run(r.cwd, ["duplicates", "--all"]);
  assert.equal(whole.code, 1);
  assert.match(whole.out[0], /or record today's with `intersite gate duplicates --all --write`$/);

  const written = await run(r.cwd, ["duplicates", "--all", "--write"]);
  assert.match(written.out[0], /^ok gate duplicates: \d+ findings recorded in intersite-gates-baseline\.json; only new ones fail from here$/);
  assert.equal((await run(r.cwd, ["duplicates", "--all"])).code, 0);

  r.write({ "src/c.mjs": twin("openTotals"), "src/use2.mjs": "import { openTotals } from './c.mjs';\nconsole.log(openTotals);\n" });
  const after = await run(r.cwd, ["duplicates", "--all"]);
  assert.equal(after.code, 1);
  assert.ok(after.out.every((line) => line.startsWith("src/c.mjs")), after.out.join("\n"));

  assert.deepEqual((await run(r.cwd, ["new-deps", "--all"])).err, ["intersite gate: new-deps only judges a change, so --all does not apply; it works for duplicates, similar, unused, naming, style-drift, artifacts"]);
});
