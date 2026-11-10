// @ts-check
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { repo } from "../gates/repo.mjs";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));

/** Runs `intersite check` in `cwd`. @param {string} cwd @returns {Promise<{ code: number, lines: string[] }>} */
function check(cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [bin, "check", "--skip", "lint"], { cwd }, (error, stdout) => done({ code: error ? Number(error.code) : 0, lines: stdout.trim().split("\n") }));
  });
}

test("check runs every gate, names the ones that failed, and passes once the change is clean", async () => {
  const r = repo({ "src/a.mjs": "export const a = 1;\n", "src/use.mjs": "import { a } from './a.mjs';\nconsole.log(a);\n" });
  r.write({ "PLAN.md": "# Plan\n\n1. do the thing\n", "intersite.adapter.mjs": "export async function signIn() { return {}; }\n" });

  const dirty = await check(r.cwd);
  assert.equal(dirty.code, 1);
  assert.equal(dirty.lines.at(-1), "FAIL check: artifacts");
  assert.ok(dirty.lines.some((line) => line.startsWith("PLAN.md")));
  assert.ok(!dirty.lines.some((line) => line.startsWith("intersite.adapter.mjs")), "the adapter is loaded by convention, not unused");

  rmSync(join(r.cwd, "PLAN.md"));
  const clean = await check(r.cwd);
  assert.equal(clean.lines.at(-1), "ok check: test-integrity, duplicates, similar, new-deps, artifacts, unused, naming, style-drift, replay");
  assert.equal(clean.code, 0);
});
