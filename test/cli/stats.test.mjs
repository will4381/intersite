// @ts-check
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { repo } from "../gates/repo.mjs";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));

/** @param {string} cwd @param {string[]} args @returns {Promise<{ code: number, lines: string[] }>} */
const intersite = (cwd, ...args) =>
  new Promise((done) => execFile(process.execPath, [bin, ...args], { cwd }, (error, stdout) => done({ code: error ? Number(error.code) : 0, lines: stdout.trim().split("\n") })));

test("stats counts what check raised, what was fixed since and what was acknowledged, per gate", async () => {
  const r = repo({ "src/a.mjs": "export const a = 1;\n", "src/use.mjs": "import { a } from './a.mjs';\nconsole.log(a);\n" }, { run: ["artifacts"], acknowledged: [{ gate: "new-deps", target: "yaml", why: "t" }] });
  r.write({ "PLAN.md": "# Plan\n", "NOTES.md": "# Notes\n" });
  assert.equal((await intersite(r.cwd, "check", "--skip", "lint")).code, 1);
  rmSync(join(r.cwd, "PLAN.md"));
  assert.equal((await intersite(r.cwd, "check", "--skip", "lint")).code, 1);
  r.write({ "src/b.mjs": "export const b = 1;\n" });
  r.commit("add b\n\nIntersite-Ack: unused: wired in by the next change");

  const { code, lines } = await intersite(r.cwd, "stats");
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    "new-deps: 1 raised, 0 fixed (0%), 1 acknowledged (100%)",
    "unused: 1 raised, 0 fixed (0%), 1 acknowledged (100%)",
    "artifacts: 2 raised, 1 fixed (50%), 0 acknowledged (0%)",
  ]);
  const json = JSON.parse((await intersite(r.cwd, "stats", "--json")).lines[0]);
  assert.equal(json.runs, 2);
  assert.deepEqual(json.stages[2], { stage: "artifacts", raised: 2, fixed: 1, acknowledged: 0 });
});

test("with nothing recorded, stats says how the ledger fills", async () => {
  const r = repo({ "src/a.mjs": "export const a = 1;\n" });
  assert.deepEqual(await intersite(r.cwd, "stats"), { code: 0, lines: ["ok stats: no findings recorded yet; each `intersite check` adds its run to .intersite/ledger.jsonl"] });
});
