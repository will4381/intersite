// @ts-check
// The `intersite` entry point itself: where a command runs, and what reaches the user when something unexpected fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));
/** @param {string} cwd @param {string[]} args */
const run = (cwd, args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, INTERSITE_DEBUG: "" } });

test("from inside a package of a monorepo configured at its root, commands use the root's intersite.yml", () => {
  const root = mkdtempSync(join(tmpdir(), "intersite-root-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "intersite.yml"), "project: root\ncollector:\n  url: http://127.0.0.1:9\n");
  mkdirSync(join(root, "packages/ui"), { recursive: true });
  writeFileSync(join(root, "packages/ui/package.json"), JSON.stringify({ name: "ui" }));
  const pinned = run(join(root, "packages/ui"), ["pin", "nope"]);
  assert.equal(pinned.stderr, "case nope not found in project root\n");
  assert.equal(pinned.status, 2);
});

test("an unexpected failure is one line on stderr with exit 2, not a stack trace", () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-bin-"));
  const started = run(cwd, ["collector", "--port", "0", "--db", "/dev/null/cases.db"]);
  assert.equal(started.status, 2);
  assert.match(started.stderr, /^intersite collector: E[A-Z]+: [^\n]*\/dev\/null[^\n]*\n$/, "one line, and a system error needs no stack trace");
});
