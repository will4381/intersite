// @ts-check
// What the gates share: git plumbing against the working tree, temporary worktrees, running the test command, and
// blanking comments and strings so regular expressions only see code.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";

import { DEFAULT_BASE } from "../shared/config.mjs";

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

/** git's empty tree: the base of a repository with no commits yet, against which every file is new. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Where the default base `origin/main` is looked for when a repository has no such ref: no remote, or another name. */
const MAIN_LINES = ["origin/HEAD", "origin/master", "main", "master"];

/** Whether this folder is inside a git work tree (false too when git is not installed). @param {string} cwd */
export const inGit = (cwd) => spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" }).stdout?.trim() === "true";

/**
 * The ref the gates compare with, as findings should name it: `base`, or for the default base the main line it fell
 * back to, or the empty tree when there are no commits yet.
 * @param {string} cwd @param {string} base
 */
export function baseName(cwd, base) {
  if (!inGit(cwd)) throw new GateError("not a git repository: the gates compare a change with git history; run `git init`, or `intersite check` skips them");
  /** @param {string} ref */
  const exists = (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd }).status === 0;
  if (!exists("HEAD")) return EMPTY_TREE;
  const found = [base, ...(base === DEFAULT_BASE ? MAIN_LINES : [])].find(exists);
  if (!found) throw new GateError(`base ref "${base}" not found: pass --base <ref> or set "gates.base" in intersite.yml, for example "main"`);
  return found;
}

/**
 * The merge-base of `base` and HEAD. The default base falls back to the repository's main line, and a repository
 * with no commits compares against the empty tree, so the gates work in a fresh `git init`.
 * @param {string} cwd
 * @param {string} base
 */
export function resolveBase(cwd, base) {
  const found = baseName(cwd, base);
  if (found === EMPTY_TREE) return found;
  const mb = spawnSync("git", ["merge-base", found, "HEAD"], { cwd, encoding: "utf8" });
  if (mb.status !== 0) throw new GateError(`base ref "${found}" shares no history with HEAD: pass --base <ref> or set "gates.base" in intersite.yml`);
  return mb.stdout.trim();
}

// ponytail: git paths are relative to the repository top and testPaths are matched against them as-is, so a project
// in a subfolder of a monorepo needs globs that include that folder; rebase paths onto cwd if monorepos need it
/** @param {string} cwd */
export const topLevel = (cwd) => git(cwd, ["rev-parse", "--show-toplevel"]).trim();

/**
 * The whole repository except installed packages and Intersite's own data, which a project with no .gitignore leaves
 * untracked and which are never part of a change.
 */
const WORK_TREE = [":(top)", ":(top,exclude,glob)**/node_modules/**", ":(top,exclude,glob)**/.intersite/**"];

/**
 * Every tracked and untracked (not ignored) path, relative to the repository top. Tracked files deleted from the
 * working tree are still listed, so callers that read files check they exist.
 * @param {string} top
 */
export const listFiles = (top) => [...new Set(git(top, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...WORK_TREE]).split("\0"))].filter(Boolean);

/**
 * Runs `git diff --cached <args>` for each args list against a throwaway index holding the whole working tree, so
 * staged, unstaged and untracked (not ignored) work all count, and renames are found even before `git add`.
 * @param {string} cwd
 * @param {string[][]} argsList
 */
export function workingDiff(cwd, argsList) {
  const dir = mkdtempSync(join(tmpdir(), "intersite-index-"));
  const forget = onInterrupt(() => rmSync(dir, { recursive: true, force: true }));
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
    git(cwd, ["add", "-A", "--", ...WORK_TREE], env);
    return argsList.map((args) => git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", ...args], env));
  } finally {
    forget();
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

const ESCAPES = /** @type {Record<string, number>} */ ({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 });

/**
 * The path in a patch's `--- a/…` or `+++ b/…` line. git C-quotes a path holding a quote, backslash, control or
 * non-ASCII byte (`"b/caf\303\251.js"`) and ends the line with a tab when the path holds a space.
 * @param {string} line
 */
export function patchPath(line) {
  const raw = line.slice(4).replace(/\t$/, "");
  if (!raw.startsWith('"')) return raw.slice(2);
  /** @type {number[]} */
  const bytes = [];
  for (let i = 1; i < raw.length - 1; i++) {
    const octal = raw[i] === "\\" ? /^[0-7]{3}/.exec(raw.slice(i + 1))?.[0] : undefined;
    if (octal) bytes.push(Number.parseInt(octal, 8));
    else if (raw[i] === "\\") bytes.push(ESCAPES[raw[i + 1]] ?? raw.charCodeAt(i + 1));
    else bytes.push(...Buffer.from(raw[i]));
    if (raw[i] === "\\") i += octal ? 3 : 1;
  }
  return Buffer.from(bytes).toString("utf8").slice(2);
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
      if (current) added.set(patchPath(text), current);
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

/** Cleanups that must run if the user interrupts: running test commands (own process groups) and temporary worktrees. */
const pending = new Set();
/** @param {NodeJS.Signals} signal */
function interrupted(signal) {
  for (const cleanup of [...pending].reverse()) cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

/**
 * Runs `cleanup` if the process is interrupted before the returned function is called. A test command runs in its
 * own process group, so Ctrl-C does not reach it; without this it and its worktree would outlive the gate.
 * @param {() => void} cleanup
 */
export function onInterrupt(cleanup) {
  if (!pending.size) {
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
  }
  pending.add(cleanup);
  return () => {
    pending.delete(cleanup);
    if (pending.size) return;
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  };
}

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
  const forget = onInterrupt(() => killGroup(child.pid));
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
      forget();
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
  const remove = () => {
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: top });
    // rmSync removes the node_modules symlink itself, never what it points at.
    rmSync(parent, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: top });
  };
  const forget = onInterrupt(remove);
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
    forget();
    remove();
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
