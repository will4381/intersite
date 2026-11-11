// @ts-check
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { repo } from "../gates/repo.mjs";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));

/** Runs `intersite check` in `cwd`. @param {string} cwd @returns {Promise<{ code: number, lines: string[], stderr: string }>} */
function check(cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [bin, "check", "--skip", "lint"], { cwd }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, lines: stdout.trim().split("\n"), stderr }));
  });
}

test("check runs every gate, names the ones that failed, and passes once the change is clean", async () => {
  const r = repo({ "src/a.mjs": "export const a = 1;\n", "src/use.mjs": "import { a } from './a.mjs';\nconsole.log(a);\n" });
  const server = createServer((_request, response) => response.end("{}"));
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  after(() => server.close());
  const target = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  r.write({ "intersite.json": JSON.stringify({ project: "t", gates: { base: "base" }, replay: { target } }) });
  r.commit("replay target");
  r.write({ "PLAN.md": "# Plan\n\n1. do the thing\n", "intersite.adapter.mjs": "export async function signIn() { return {}; }\n" });

  const dirty = await check(r.cwd);
  assert.equal(dirty.code, 1, dirty.stderr);
  assert.equal(dirty.lines.at(-1), "FAIL check: artifacts");
  assert.ok(dirty.lines.some((line) => line.startsWith("PLAN.md")));
  assert.ok(!dirty.lines.some((line) => line.startsWith("intersite.adapter.mjs")), "the adapter is loaded by convention, not unused");

  rmSync(join(r.cwd, "PLAN.md"));
  const clean = await check(r.cwd);
  assert.deepEqual(clean.lines, ["ok check: test-integrity, duplicates, similar, new-deps, artifacts, unused, naming, style-drift, replay"], "success is one line");
  assert.equal(clean.code, 0, clean.stderr);
});

test("outside a git repository check skips the gates with one line and passes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-check-nogit-"));
  const { code, lines } = await check(cwd);
  assert.deepEqual(lines, ["skip gates: not a git repository (run `git init` to check changes)", "skip replay: no adapter at ./intersite.adapter.mjs", "ok check: no stages ran"]);
  assert.equal(code, 0);
});

test("check skips replay with one line when nothing answers at replay.target", async () => {
  const r = repo({ "src/a.mjs": "export const a = 1;\n" });
  r.write({ "intersite.json": JSON.stringify({ project: "t", gates: { base: "base" }, replay: { target: "http://127.0.0.1:9" } }), "intersite.adapter.mjs": "export async function signIn() { return {}; }\n" });
  r.commit("adapter");
  const { code, lines } = await check(r.cwd);
  assert.deepEqual(lines, ["skip replay: nothing answers at http://127.0.0.1:9 (start the server to replay recorded sessions)", "ok check: test-integrity, duplicates, similar, new-deps, artifacts, unused, naming, style-drift"]);
  assert.equal(code, 0);
});

test("replay: false leaves replay out of check without a skip line", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-check-noreplay-"));
  writeFileSync(join(cwd, "intersite.yml"), "project: t\nreplay: false\n");
  const { code, lines } = await check(cwd);
  assert.deepEqual(lines, ["skip gates: not a git repository (run `git init` to check changes)", "ok check: no stages ran"]);
  assert.equal(code, 0);
});

test("the project's own checks run when the change touches their paths; slow ones wait for --full, and --all runs every one", async () => {
  const r = repo({ "src/a.mjs": "export const a = 1;\n", "src/use.mjs": "import { a } from './a.mjs';\nconsole.log(a);\n", "docs/a.md": "# A\n" });
  const checks = [
    { name: "src-ok", run: "node -e \"process.exit(0)\"", when: ["src/**"] },
    { name: "docs", run: "node -e \"process.exit(0)\"", when: ["docs/**"] },
    { name: "suite", run: "node -e \"console.log('1 failing');process.exit(3)\"", cwd: "src", when: ["src/**"], slow: true },
  ];
  r.write({ "intersite.json": JSON.stringify({ project: "t", gates: { base: "base", run: [] }, replay: false, checks }) });
  r.commit("checks");
  r.git("tag", "-f", "base");
  r.write({ "src/a.mjs": "export const a = 2;\n" });
  const run = (/** @type {string[]} */ ...flags) =>
    new Promise((done) => execFile(process.execPath, [bin, "check", "--skip", "lint", ...flags], { cwd: r.cwd }, (error, stdout) => done({ code: error ? Number(error.code) : 0, lines: stdout.trim().split("\n") })));

  assert.deepEqual(await run(), { code: 0, lines: ["skip suite: slow, run with `intersite check --full`", "ok check: src-ok"] });
  assert.deepEqual(await run("--full"), { code: 1, lines: ["1 failing", "suite: failed with exit 3 | rerun: cd src && node -e \"console.log('1 failing');process.exit(3)\"", "FAIL check: suite"] });
  assert.deepEqual(await run("--full", "--skip", "suite"), { code: 0, lines: ["ok check: src-ok"] });
  assert.deepEqual((await run("--all", "--skip", "suite")).lines, ["ok check: src-ok, docs"]);
});

test("a check named like a built-in stage is refused with one line", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-check-name-"));
  writeFileSync(join(cwd, "intersite.yml"), "project: t\nchecks:\n  - { name: lint, run: 'true' }\n");
  const { code, stderr } = await check(cwd);
  assert.equal(code, 2);
  assert.equal(stderr.trim(), 'check: intersite.yml: check name "lint" is already taken; pick another');
});
