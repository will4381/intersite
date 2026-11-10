// @ts-check
// Proves a bug fix's new tests fail without the fix: run them against the base commit in a temporary worktree.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";

export const defaultPaths = ["**/*.test.*", "**/*.spec.*", "test/**", "tests/**", "**/__tests__/**"];

/**
 * @param {{ cwd: string, base: string, cmd: string, paths: string[], setup?: string }} options
 * @returns {{ code: 0 | 1 | 2, message: string }}
 */
export function failsOnBase({ cwd, base, cmd, paths, setup }) {
  /** @param {string[]} args */
  const git = (args) => spawnSync("git", args, { cwd, encoding: "utf8" });

  const diff = git(["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`]);
  if (diff.status !== 0) return { code: 2, message: `fails-on-base: git diff ${base}...HEAD failed: ${diff.stderr.trim()}` };
  const files = diff.stdout.split("\n").filter((f) => f && paths.some((glob) => matchesGlob(f, glob)));
  if (!files.length) return { code: 2, message: `fails-on-base: no file changed since ${base} matches ${paths.join(", ")}` };

  const dir = join(mkdtempSync(join(tmpdir(), "intersite-gate-")), "base");
  const add = git(["worktree", "add", "--detach", dir, base]);
  try {
    if (add.status !== 0) return { code: 2, message: `fails-on-base: git worktree add failed: ${add.stderr.trim()}` };
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(cwd, file), join(dir, file));
    }

    // The command's own output goes to stderr so the reason it failed stays visible.
    const sh = (/** @type {string} */ command) => spawnSync(command, { cwd: dir, shell: true, stdio: ["ignore", 2, 2] }).status;
    if (setup && sh(setup) !== 0) return { code: 2, message: `fails-on-base: setup failed on ${base}: ${setup}` };
    const status = sh(cmd);
    return status === 0
      ? { code: 1, message: `fails-on-base: the new tests (${files.join(", ")}) pass on ${base} without the fix, so they do not test it; rerun: ${cmd}` }
      : { code: 0, message: `fails-on-base: ${cmd} fails on ${base} (exit ${status}), as a test of the fix should` };
  } finally {
    git(["worktree", "remove", "--force", dir]);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}
