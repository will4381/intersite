// @ts-check
// Fails when an added block of source already exists elsewhere in the repository: pasted code that should be reused.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { addedLines, git, matches, resolveBase, topLevel, workingDiff } from "./lib.mjs";

const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|scala|sh|sql|css|scss)$/;
const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__)\/|\.min\.|\.d\.ts$|\.generated\./;
const MAX_BYTES = 256 * 1024;
// Closing brackets, imports, single tokens, comments: lines that repeat everywhere without being pasted code.
const TRIVIAL = /^(?:[[\](){};,]*|import\b.*|export\s+(?:\*|\{[^}]*\})\s*from\b.*|\}?\s*from\s.*|[\w$.]+[;,]?|\}?\s*else\s*\{?|\/\/.*|\/?\*.*|#.*|<\/[\w.]+>)$/;
const LINE_BITS = 2 ** 20;

/**
 * The file's non-blank lines, whitespace-normalised and hashed, or undefined for binary, generated or minified text.
 * Blank lines are dropped so a pasted block still matches after blank lines were added or removed.
 * @param {string} path
 */
function read(path) {
  if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  const text = readFileSync(path, "utf8");
  // ponytail: files over MAX_BYTES are skipped, chunk them if large hand-written files matter
  if (text.length > MAX_BYTES || text.includes("\0") || /@generated|DO NOT EDIT/.test(text.slice(0, 500))) return undefined;
  const raw = text.split("\n");
  if (text.length / raw.length > 200) return undefined;
  /** @type {number[]} */ const line = [];
  /** @type {number[]} */ const h1 = [];
  /** @type {number[]} */ const h2 = [];
  /** @type {boolean[]} */ const trivial = [];
  raw.forEach((r, i) => {
    const s = r.trim().replace(/\s+/g, " ");
    if (!s) return;
    let a = 0x811c9dc5;
    let b = 5381;
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b, 33) + c;
    }
    line.push(i + 1);
    h1.push(a >>> 0);
    h2.push(b >>> 0);
    trivial.push(TRIVIAL.test(s));
  });
  return { line, h1, h2, trivial };
}

/**
 * Hash of the `n` lines starting at `i`, or undefined when most of them are trivial.
 * @param {NonNullable<ReturnType<typeof read>>} f
 * @param {number} i
 * @param {number} n
 */
function windowKey(f, i, n) {
  let a = 0;
  let b = 0;
  let real = 0;
  for (let k = i; k < i + n; k++) {
    a = (Math.imul(a, 0x01000193) ^ f.h1[k]) >>> 0;
    b = (Math.imul(b, 0x5bd1e995) + f.h2[k]) >>> 0;
    if (!f.trivial[k]) real++;
  }
  // ponytail: a 53-bit hash with no text comparison, so a collision could report a false duplicate (odds ~1e-10)
  return real * 2 >= n ? a * 2 ** 21 + (b >>> 11) : undefined;
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function duplicates({ cwd, base, testPaths, duplicateLines: n }) {
  const sha = resolveBase(cwd, base);
  const top = topLevel(cwd);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = addedLines(patch);
  const tracked = git(top, ["ls-files", "-z"]).split("\0").filter((f) => CODE.test(f) && !SKIP.test(f));

  // One index of every window of pre-existing lines. Windows touching added lines are left out, so the added block
  // never matches itself, and code moved within the change (gone from its old place) has no original to match.
  /** @type {Map<number, number>} */
  const index = new Map();
  for (const [fi, file] of tracked.entries()) {
    const f = read(join(top, file));
    if (!f) continue;
    const fresh = added.get(file);
    for (let i = 0; i + n <= f.line.length; i++) {
      if (fresh && f.line.slice(i, i + n).some((l) => fresh.has(l))) continue;
      const key = windowKey(f, i, n);
      if (key !== undefined && !index.has(key)) index.set(key, fi * LINE_BITS + f.line[i]);
    }
  }

  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  let checked = 0;
  for (const [file, fresh] of added) {
    if (!fresh.size || !CODE.test(file) || SKIP.test(file) || matches(file, testPaths)) continue;
    const f = read(join(top, file));
    if (!f) continue;
    checked++;
    /** @type {{ first: number, last: number, at: number } | undefined} */
    let run;
    const flush = () => {
      if (!run) return;
      const original = `${tracked[Math.floor(run.at / LINE_BITS)]}:${run.at % LINE_BITS}`;
      findings.push({ target: file, message: `${file}:${f.line[run.first]} repeats ${original} (${run.last - run.first + n} lines): reuse it` });
      run = undefined;
    };
    for (let i = 0; i + n <= f.line.length; i++) {
      const at = f.line.slice(i, i + n).every((l) => fresh.has(l)) ? index.get(windowKey(f, i, n) ?? -1) : undefined;
      if (at === undefined) flush();
      else if (run) run.last = i;
      else run = { first: i, last: i, at };
    }
    flush();
  }
  return { findings, summary: `${checked} changed source files checked against ${tracked.length} tracked files` };
}
