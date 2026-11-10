// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import gate from "../../cli/gate.mjs";

/**
 * A repo whose base commit has a buggy `add`, and whose HEAD fixes it and adds `testSource` as test/add.test.mjs.
 * @param {string} testSource
 */
function repo(testSource) {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-gate-repo-"));
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "add.mjs"), "export const add = (a, b) => a - b;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("tag", "base");
  writeFileSync(join(cwd, "add.mjs"), "export const add = (a, b) => a + b;\n");
  mkdirSync(join(cwd, "test"));
  writeFileSync(join(cwd, "test/add.test.mjs"), `import assert from "node:assert/strict";\nimport { add } from "../add.mjs";\n${testSource}\n`);
  git("add", ".");
  git("commit", "-qm", "fix add");
  return { cwd, worktrees: () => git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length };
}

const args = ["fails-on-base", "--base", "base", "--cmd", "node test/add.test.mjs", "--paths", "test/**"];

test("exits 0 when the new test fails on the base commit, and removes the worktree", async () => {
  const { cwd, worktrees } = repo("assert.equal(add(2, 2), 4);");
  assert.equal(await gate(args, { cwd }), 0);
  assert.equal(worktrees(), 1);
});

test("exits 1 when the new test passes on the base commit, and removes the worktree", async () => {
  const { cwd, worktrees } = repo("assert.equal(typeof add, 'function');");
  assert.equal(await gate(args, { cwd }), 1);
  assert.equal(worktrees(), 1);
});

test("exits 2 when no changed file matches --paths", async () => {
  const { cwd } = repo("assert.equal(add(2, 2), 4);");
  assert.equal(await gate(["fails-on-base", "--base", "base", "--cmd", "true", "--paths", "spec/**"], { cwd }), 2);
});
