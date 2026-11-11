// @ts-check
// Fixture for gate tests: a temporary git repo whose first commit is tagged `base`, and a way to run the gate CLI on it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import gate from "../../cli/gate.mjs";

/**
 * @param {Record<string, string>} files committed as `base`, paths from the repository top
 * @param {Record<string, unknown>} [gates] the `gates` section of intersite.yml
 * @param {{ at?: string }} [layout] `at`: the project's folder in a monorepo, where intersite.json goes; `cwd` is that
 *   folder and `root` the repository top, which `write`, `rm` and `commit` work from
 */
export function repo(files, gates = {}, { at = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "intersite-gate-repo-"));
  const cwd = join(root, at);
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  const write = (/** @type {Record<string, string>} */ more) => {
    for (const [path, text] of Object.entries(more)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  git("init", "-q", "-b", "main");
  // No background housekeeping: a detached `git gc` can still be writing when a test deletes the repository.
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  write({ [join(at, "intersite.json")]: JSON.stringify({ project: "t", gates: { base: "base", ...gates } }), ...files });
  git("add", ".");
  git("commit", "-qm", "base");
  git("tag", "base");
  return {
    cwd,
    root,
    git,
    write,
    rm: (/** @type {string} */ path) => rmSync(join(root, path)),
    commit: (/** @type {string} */ message) => {
      git("add", "-A");
      git("commit", "-qm", message);
    },
    worktrees: () => git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
  };
}

/**
 * Runs `intersite gate` and collects what it prints.
 * @param {string} cwd
 * @param {string[]} args
 */
export async function run(cwd, args) {
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const { log, error } = console;
  console.log = (/** @type {string} */ line) => out.push(line);
  console.error = (/** @type {string} */ line) => err.push(line);
  try {
    return { code: await gate(args, { cwd }), out, err };
  } finally {
    Object.assign(console, { log, error });
  }
}
