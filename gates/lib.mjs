// @ts-check
// What the gates share: git plumbing against the working tree, temporary worktrees, running the test command, and
// blanking comments and strings so regular expressions only see code.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";

/** A setup problem (bad ref, failing baseline): the CLI prints its message on one line and exits 2. */
export class GateError extends Error {}

/**
 * @typedef {{ cwd: string, base: string, testPaths: string[], testCmd: string, setup: string,
 *   duplicateLines: number, mutants: number, timeout: number, entryPaths: string[], artifacts: string[] }} GateOptions
 * @typedef {{ target: string, message: string }} Finding
 * @typedef {{ findings: Finding[], summary: string }} GateResult
 * @typedef {{ status: string, path: string, from: string }} Change
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
export function git(cwd, args, env) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", env, maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new GateError(`git ${args.join(" ")} failed: ${run.stderr.trim().split("\n")[0]}`);
  return run.stdout;
}

/**
 * The merge-base of `base` and HEAD.
 * @param {string} cwd
 * @param {string} base
 */
export function resolveBase(cwd, base) {
  const ok = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd, encoding: "utf8" });
  if (ok.status !== 0) throw new GateError(`base ref "${base}" not found: pass --base <ref> or set "gates.base" in intersite.yml, for example "main"`);
  const mb = spawnSync("git", ["merge-base", base, "HEAD"], { cwd, encoding: "utf8" });
  if (mb.status !== 0) throw new GateError(`base ref "${base}" shares no history with HEAD: pass --base <ref> or set "gates.base" in intersite.yml`);
  return mb.stdout.trim();
}

// ponytail: git paths are relative to the repository top and testPaths are matched against them as-is, so a project
// in a subfolder of a monorepo needs globs that include that folder; rebase paths onto cwd if monorepos need it
/** @param {string} cwd */
export const topLevel = (cwd) => git(cwd, ["rev-parse", "--show-toplevel"]).trim();

/**
 * Every tracked and untracked (not ignored) path, relative to the repository top. Tracked files deleted from the
 * working tree are still listed, so callers that read files check they exist.
 * @param {string} top
 */
export const listFiles = (top) => [...new Set(git(top, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0"))].filter(Boolean);

/**
 * Runs `git diff --cached <args>` for each args list against a throwaway index holding the whole working tree, so
 * staged, unstaged and untracked (not ignored) work all count, and renames are found even before `git add`.
 * @param {string} cwd
 * @param {string[][]} argsList
 */
export function workingDiff(cwd, argsList) {
  const dir = mkdtempSync(join(tmpdir(), "intersite-index-"));
  try {
    const index = join(dir, "index");
    const real = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index"]).trim());
    // Starting from a copy of the real index reuses its stat cache, so unchanged files are not rehashed.
    // The copy keeps the real index's timestamp: git rehashes a file only when its mtime is not older than the index,
    // so a newer-looking copy would hide a same-size edit made in the same second as the last commit.
    if (existsSync(real)) {
      copyFileSync(real, index);
      const { atime, mtime } = statSync(real);
      utimesSync(index, atime, mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(cwd, ["add", "-A"], env);
    return argsList.map((args) => git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", ...args], env));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Files changed between `sha` and the working tree. `from` is the old path of a rename, else the same as `path`.
 * @param {string} cwd
 * @param {string} sha
 * @returns {Change[]}
 */
export function changes(cwd, sha) {
  const [out] = workingDiff(cwd, [["--name-status", "-M", "-z", sha]]);
  return parseNameStatus(out);
}

/** @param {string} out `git diff --name-status -z` output */
export function parseNameStatus(out) {
  const parts = out.split("\0");
  /** @type {Change[]} */
  const list = [];
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++];
    const from = parts[i++];
    const path = /^[RC]/.test(status) ? parts[i++] : from;
    list.push({ status: status[0], path, from });
  }
  return list;
}

/**
 * New-file line numbers of the lines added in a `-U0` patch, per path.
 * @param {string} patch
 */
export function addedLines(patch) {
  /** @type {Map<string, Set<number>>} */
  const added = new Map();
  /** @type {Set<number> | undefined} */
  let current;
  let line = 0;
  for (const text of patch.split("\n")) {
    if (text.startsWith("+++ ")) {
      current = text === "+++ /dev/null" ? undefined : new Set();
      // ponytail: paths with spaces or quotes come quoted by git and are not unquoted, use -z output if that matters
      if (current) added.set(text.slice(6), current);
    } else if (text.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(text)?.[1]);
    } else if (text.startsWith("+") && current) {
      current.add(line++);
    }
  }
  return added;
}

/**
 * The contents of many files at a commit, in one git process: a spawn per file costs seconds on a large change.
 * A path that does not exist at the commit maps to "".
 * @param {string} cwd @param {string} sha @param {string[]} paths
 * @returns {Map<string, string>}
 */
export function showMany(cwd, sha, paths) {
  /** @type {Map<string, string>} */
  const texts = new Map();
  if (paths.length === 0) return texts;
  const run = spawnSync("git", ["cat-file", "--batch"], { cwd, input: paths.map((path) => `${sha}:${path}\n`).join(""), maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new GateError(`git cat-file failed: ${String(run.stderr).trim()}`);
  const out = /** @type {Buffer} */ (run.stdout);
  let at = 0;
  for (const path of paths) {
    const lineEnd = out.indexOf(10, at);
    const header = out.toString("utf8", at, lineEnd);
    at = lineEnd + 1;
    const size = / (\d+)$/.exec(header);
    if (!size || header.endsWith(" missing")) {
      texts.set(path, "");
      continue;
    }
    texts.set(path, out.toString("utf8", at, at + Number(size[1])));
    at += Number(size[1]) + 1;
  }
  return texts;
}

/**
 * A file's text at a commit, or "" when it did not exist there.
 * @param {string} cwd
 * @param {string} sha
 * @param {string} path
 */
export function show(cwd, sha, path) {
  const run = spawnSync("git", ["show", `${sha}:${path}`], { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  return run.status === 0 ? run.stdout : "";
}

/**
 * @param {string} path
 * @param {string[]} globs
 */
export const matches = (path, globs) => globs.some((glob) => matchesGlob(path, glob));

/**
 * Runs a shell command in its own process group, killing the whole group on timeout. NODE_TEST_CONTEXT is cleared
 * so a `node --test` command run from inside a test run does not silently skip.
 * @param {string} cmd
 * @param {string} cwd
 * @param {{ timeout?: number, output?: "ignore" | "stderr" }} [options] timeout in seconds
 * @returns {Promise<{ code: number | null, timedOut: boolean }>}
 */
export function sh(cmd, cwd, { timeout = 0, output = "stderr" } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = output === "stderr" ? 2 : "ignore";
  const child = spawn(cmd, { cwd, env, shell: true, detached: true, stdio: ["ignore", out, out] });
  return new Promise((done) => {
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, timeout * 1000)
      : undefined;
    child.on("exit", (code) => {
      clearTimeout(timer);
      // Grandchildren the shell left behind would keep writing into a worktree about to be removed.
      killGroup(child.pid);
      done({ code, timedOut });
    });
  });
}

/** @param {number | undefined} pid */
function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // ESRCH: the group has already exited, which is the outcome we wanted.
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
  }
}

/**
 * Runs `fn` in a temporary detached worktree of `ref`, then always removes it.
 * @template T
 * @param {{ cwd: string, ref: string, setup: string, overlay: { path: string, deleted: boolean }[] }} options
 *   `overlay`: top-level-relative paths copied from the checkout (or deleted) after checkout
 * @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withWorktree({ cwd, ref, setup, overlay }, fn) {
  const top = topLevel(cwd);
  const parent = mkdtempSync(join(tmpdir(), "intersite-gate-"));
  const dir = join(parent, "tree");
  try {
    git(top, ["worktree", "add", "--detach", "--quiet", dir, ref]);
    for (const file of overlay) {
      const target = join(dir, file.path);
      if (file.deleted) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(top, file.path), target);
      }
    }
    const work = join(dir, relative(top, realpathSync(cwd)));
    if (setup) {
      const { code } = await sh(setup, work);
      if (code !== 0) throw new GateError(`setup command failed in a worktree of ${ref}: ${setup}`);
    } else if (existsSync(join(top, "node_modules")) && !existsSync(join(dir, "node_modules"))) {
      // ponytail: links only the top-level node_modules, set gates.setup for nested workspaces
      symlinkSync(join(top, "node_modules"), join(dir, "node_modules"), "dir");
    }
    return await fn(work);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: top });
    // rmSync removes the node_modules symlink itself, never what it points at.
    rmSync(parent, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: top });
  }
}

/**
 * The same text with the inside of comments and string literals replaced by spaces, keeping every newline and
 * column, so matches map back to the original by position.
 * @param {string} text
 */
export function stripCode(text) {
  // ponytail: regex literals and template ${} expressions are not understood, a tokenizer if that bites
  const blank = (/** @type {string} */ s) => s.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    let end = -1;
    let keep = 0;
    if (c === "/" && next === "/") {
      end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
    } else if (c === "/" && next === "*") {
      end = text.indexOf("*/", i + 2);
      end = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      end = Math.min(j + 1, text.length);
      keep = 1;
    }
    if (end < 0) {
      out += c;
      i++;
    } else {
      const inner = text.slice(i + keep, end - (keep && text[end - 1] === c ? 1 : 0));
      out += (keep ? c : "") + blank(inner) + (keep && text[end - 1] === c && end - 1 > i ? c : "");
      i = end;
    }
  }
  return out;
}
