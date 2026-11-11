// @ts-check
// Fails when the change adds a function, component, hook, class or type that already exists under another name:
// the same structure after local names and literals are replaced by placeholders, so renamed and reformatted copies
// match while code that merely looks alike does not. Exact pasted blocks are left to the duplicates gate.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { addedLines, listFiles, matches, resolveBase, workingDiff } from "./lib.mjs";
import { units as jsUnits } from "./units.mjs";

/** @typedef {import("./units.mjs").Unit} Unit */
/** @typedef {{ file: string, unit: Unit, prints: Int32Array | undefined }} Entry */

/** Unit extractors by file extension; another language adds an entry. */
const LANGUAGES = [{ test: /\.[cm]?[jt]sx?$/, units: jsUnits }];
const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__)\/|\.min\.|\.d\.[cm]?ts$|\.generated\./;
// Never one side of a pair: tests, fixtures and stories, configs, and route files whose shape the framework dictates.
const NOT_SOURCE = /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|(?:[\w-]*[-_])?(?:fixtures?|mocks?|e2e|tests?|testing)|stories|seeds?|migrations)\/|\.(?:test|spec|stories|story|e2e|config)\.[^/]+$|[-_.]fixtures?\.[^/]+$|(?:^|\/)(?:page|layout|loading|error|global-error|not-found|template|default|route|middleware)\.[cm]?[jt]sx?$/;
// Kit primitives (shadcn-style) are deliberately uniform wrappers: two of them are never reported as a pair.
const KIT = /(?:^|\/)(?:components\/ui|ui\/components|packages\/ui)\//;
const MAX_BYTES = 256 * 1024;
const K = 7;
// Jaccard over 7-gram sets. Tuned on 21 agent-built repositories: real regenerated helpers scored 60-100%, and below
// 60% or 32 normalised tokens the matches were mostly shared idioms a reviewer would keep.
const THRESHOLD = 0.6;
const MIN_TOKENS = 32;
const MIN_MEMBERS = 6;
const TYPE_THRESHOLD = 0.9;
const LCS_CELLS = 4_000_000;
// A unit this short that calls a different module-level helper is a delegate to it, not a copy.
const DELEGATE_TOKENS = 50;
// Entry points whose shape a framework or script convention dictates.
const ENTRY = /^(?:main|run|handler|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|loader|action|generateMetadata|generateStaticParams|getServerSideProps|getStaticProps|getStaticPaths)$/;

/** @type {Map<string, number>} */
const tokenIds = new Map();

/**
 * The unit's k-gram hashes over its normalised tokens, sorted and unique.
 * @param {string[]} norm
 */
function fingerprint(norm) {
  const ids = norm.map((t) => {
    let id = tokenIds.get(t);
    if (id === undefined) tokenIds.set(t, (id = tokenIds.size));
    return id;
  });
  const out = new Int32Array(Math.max(0, ids.length - K + 1));
  for (let i = 0; i < out.length; i++) {
    let h = 0x811c9dc5;
    for (let j = i; j < i + K; j++) h = Math.imul(h ^ ids[j], 0x01000193);
    out[i] = h;
  }
  // ponytail: 32-bit hashes, so a rare collision nudges a score up by one gram; 53-bit pairs as in duplicates if it bites
  out.sort();
  let n = 0;
  for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[n++] = out[i];
  return out.subarray(0, n);
}

/** Types compare by member set, code by fingerprints; classes only with classes. @param {Unit} u */
const family = (u) => (u.kind === "type" ? "type" : u.kind === "class" ? "class" : "code");

/** Whether a copy of the unit would matter: big enough, not an entry point, not an error subclass. @param {Unit} u */
function big(u) {
  if (u.kind === "type") return u.members.length >= MIN_MEMBERS;
  if (ENTRY.test(u.name) || (u.kind === "class" && u.raw.some((t, i) => t === "extends" && u.raw[i + 1]?.endsWith("Error")))) return false;
  return u.norm.length >= MIN_TOKENS;
}

/** @param {string[]} a @param {string[]} b */
function memberSimilarity(a, b) {
  const set = new Set(a);
  const shared = new Set(b.filter((m) => set.has(m))).size;
  return shared / (set.size + new Set(b).size - shared);
}

/**
 * Every unit in the repository's source files, with which ones the change added (its first line is an added line).
 * @param {string} cwd @param {string[]} files @param {Map<string, Set<number>>} added
 */
// ponytail: tokenizes every source file on every run (~0.6s CPU for 4,000 files); cache units by blob hash past that
function collect(cwd, files, added) {
  /** @type {Entry[]} */
  const all = [];
  /** @type {Entry[]} */
  const fresh = [];
  for (const file of files) {
    const lang = LANGUAGES.find((l) => l.test.test(file));
    if (!lang || statSync(join(cwd, file), { throwIfNoEntry: false })?.isFile() !== true) continue;
    const text = readFileSync(join(cwd, file), "utf8");
    // ponytail: files over MAX_BYTES are skipped, as in duplicates; chunk them if large hand-written files matter
    if (text.length > MAX_BYTES || text.includes("\0") || /@generated|DO NOT EDIT/.test(text.slice(0, 500))) continue;
    const lines = added.get(file);
    for (const unit of lang.units(text, file)) {
      const entry = { file, unit, prints: undefined };
      all.push(entry);
      if (big(unit) && !KIT.test(file) && lines?.has(unit.line)) fresh.push(entry);
    }
  }
  return { all, fresh };
}

/**
 * The most similar other unit for each added unit, as [added, other, similarity].
 * Fingerprints are computed only for units whose size could reach the threshold.
 * @param {Entry[]} fresh @param {Entry[]} all
 * @returns {[Entry, Entry, number][]}
 */
function match(fresh, all) {
  /** @type {Map<number, number[]>} */
  const index = new Map();
  let lo = Infinity;
  let hi = 0;
  fresh.forEach((e, i) => {
    if (family(e.unit) === "type") return;
    e.prints = fingerprint(e.unit.norm);
    lo = Math.min(lo, e.unit.norm.length * THRESHOLD);
    hi = Math.max(hi, e.unit.norm.length / THRESHOLD);
    for (const h of e.prints) {
      const list = index.get(h);
      if (list) list.push(i);
      else index.set(h, [i]);
    }
  });
  /** @type {(Entry | undefined)[]} */ const best = [];
  const score = new Float64Array(fresh.length);
  const shared = new Int32Array(fresh.length);
  for (const other of all) {
    const u = other.unit;
    if (family(u) === "type" || u.norm.length < lo || u.norm.length > hi) continue;
    other.prints ??= fingerprint(u.norm);
    /** @type {number[]} */ const hit = [];
    for (const h of other.prints) for (const i of index.get(h) ?? []) if (shared[i]++ === 0) hit.push(i);
    for (const i of hit) {
      const sim = shared[i] / (/** @type {Int32Array} */ (fresh[i].prints).length + other.prints.length - shared[i]);
      shared[i] = 0;
      if (sim > score[i] && candidate(fresh[i], other)) [score[i], best[i]] = [sim, other];
    }
  }
  // ponytail: each added type is compared with every type, O(added × types); index members if big changes slow it
  fresh.forEach((e, i) => {
    if (family(e.unit) !== "type") return;
    for (const other of all) {
      if (family(other.unit) !== "type" || !candidate(e, other)) continue;
      const sim = memberSimilarity(e.unit.members, other.unit.members);
      if (sim > score[i]) [score[i], best[i]] = [sim, other];
    }
  });
  return fresh.flatMap((e, i) => (best[i] ? [/** @type {[Entry, Entry, number]} */ ([e, best[i], score[i]])] : []));
}

// ponytail: same-file pairs are never reported (the author wrote them side by side, overloads included); report
// them past a higher threshold if in-file copies turn out to matter
/** Whether `other` may be reported as the original of added `e`. @param {Entry} e @param {Entry} other */
function candidate(e, other) {
  return other.file !== e.file && family(other.unit) === family(e.unit) && big(other.unit) && !(KIT.test(e.file) && KIT.test(other.file));
}

/**
 * Whether the two units share a run of `n` identical non-trivial lines: the duplicates gate reports those.
 * @param {string} cwd @param {Entry} a @param {Entry} b @param {number} n
 */
function pasted(cwd, a, b, n) {
  const lines = (/** @type {Entry} */ e) =>
    readFileSync(join(cwd, e.file), "utf8").split("\n").slice(e.unit.line - 1, e.unit.endLine).map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
  const la = lines(a);
  const lb = lines(b);
  const runs = new Set();
  const real = (/** @type {string[]} */ w) => w.filter((l) => !/^[[\](){};,]*$|^<\/[\w.]*>$/.test(l)).length * 2 >= n;
  for (let i = 0; i + n <= lb.length; i++) runs.add(lb.slice(i, i + n).join("\n"));
  for (let i = 0; i + n <= la.length; i++) if (runs.has(la.slice(i, i + n).join("\n")) && real(la.slice(i, i + n))) return true;
  return false;
}

/**
 * Matched token pairs of the longest common subsequence of two normalised streams, or undefined when too large.
 * @param {string[]} a @param {string[]} b
 */
function align(a, b) {
  // ponytail: quadratic LCS, skipped past LCS_CELLS (about 2,000 tokens a side); Myers diff if huge units need wording
  if ((a.length + 1) * (b.length + 1) > LCS_CELLS) return undefined;
  const w = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  /** @type {[number, number][]} */
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Whether string `k` of `u` is a list of CSS classes. @param {Unit} u @param {number} k */
function classList(u, k) {
  if (u.raw[k - 2] === "className" || u.raw[k - 2] === "class" || /^(?:cn|clsx|cva|twMerge|classNames)$/.test(u.raw[k - 2])) return true;
  const words = u.raw[k].replace(/^["'`]|["'`]$/g, "").trim().split(/\s+/);
  return words.length > 1 && words.every((w) => /^[!a-z0-9:/[\].%#-]+$/.test(w)) && words.filter((w) => /[-:]/.test(w)).length * 2 >= words.length;
}

/**
 * What separates two near-identical units: "" when only local names do, a list such as "class names and one string"
 * when only literals and a prop or two do, else undefined.
 * @param {Unit} a @param {Unit} b
 */
function differences(a, b) {
  const pairs = align(a.norm, b.norm);
  if (!pairs) return undefined;
  const unmatched = a.norm.length + b.norm.length - 2 * pairs.length;
  const matchedA = new Set(pairs.map(([i]) => i));
  const matchedB = new Set(pairs.map(([, j]) => j));
  const props = new Set([...a.rawKind.flatMap((k, i) => (k === "attr" && !matchedA.has(i) ? [a.raw[i]] : [])), ...b.rawKind.flatMap((k, j) => (k === "attr" && !matchedB.has(j) ? [b.raw[j]] : []))]).size;
  // A prop is about three tokens (`name="value"`); anything more is a structural change.
  if (unmatched > props * 3) return undefined;
  let classes = 0;
  let strings = 0;
  let numbers = 0;
  for (const [i, j] of pairs) {
    if (a.raw[i] === b.raw[j] || !LITERAL.test(a.rawKind[i])) continue;
    if (a.rawKind[i] === "num") numbers++;
    else if (classList(a, i)) classes++;
    else strings++;
  }
  const count = (/** @type {number} */ n, /** @type {string} */ what) => (n === 1 ? `one ${what}` : `${n} ${what}s`);
  const parts = [classes && "class names", strings && count(strings, "string"), numbers && count(numbers, "number"), props && count(props, "prop")].filter(Boolean);
  return parts.join(", ").replace(/, ([^,]*)$/, " and $1");
}

/**
 * Whether token `k` of `u` names a dependency: an imported name that is called or reached into (not a type
 * annotation), a module-level object reached into (a store, a key factory), the middle of an object path
 * (`db.fee.findMany`), a custom JSX element (a wrapper around a different page renders a different thing), or in a
 * short unit, a call to a module-level function (a delegate to a different helper).
 * @param {Unit} u @param {number} k
 */
function resource(u, k) {
  const next = u.raw[k + 1];
  const reached = next === "." || next === "?.";
  const kind = u.rawKind[k];
  if (/^(?:function|const|let|var|class)$/.test(u.raw[k - 1])) return false;
  if (kind === "dep") return next === "(" || reached;
  if (kind === "mod") return reached || (next === "(" && u.norm.length < DELEGATE_TOKENS);
  if (kind === "tag") return /^<[A-Z]/.test(u.raw[k]);
  return kind === "id" && u.raw[k - 1] === "." && reached;
}

/** @param {Unit} u @param {number} from @param {number} to */
const resourceIn = (u, from, to) => {
  for (let k = from; k < to; k++) if (resource(u, k)) return true;
  return false;
};

/** Whether literal `k` of `u` is a prop passed to a custom component (`<Chart title="…">`). @param {Unit} u @param {number} k */
function customProp(u, k) {
  for (let m = k - 1; m >= 0 && m > k - 80; m--) if (u.rawKind[m] === "tag") return /^<[A-Z]/.test(u.raw[m]);
  return false;
}

// Methods whose first string argument names a table, index, column, event, key or remote function.
const SELECTORS = /^(?:query|from|table|collection|doc|withIndex|index|rpc|invoke|channel|emit|on|select|insert|update|upsert|delete|eq|neq|where|orderBy|field|getItem|setItem)$/;

/** Whether string `k` of `u` selects what a data call touches (`db.query("fees")`). @param {Unit} u @param {number} k */
const selector = (u, k) => u.raw[k - 1] === "(" && u.raw[k - 3] === "." && SELECTORS.test(u.raw[k - 2]);

const LITERAL = /^(?:str|text|num|regex)$/;
const LITERAL_NORM = /^[SNTR]$/;
// URLs, routes, module specifiers and SQL: a string that says which thing a unit talks to. Env names too.
const ADDRESS = /^["'`]?(?:\.{0,2}\/|[@~#]\/|https?:|\s*(?:select|insert into|update|delete from|with)\s)/i;
const ENV_NAME = /^["'`][A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+["'`]$/;

/**
 * Whether two similar units are one pattern applied to different things, which a reviewer keeps apart:
 * - they talk to different things: a different URL, route, module, SQL statement, env variable or method selector
 *   (`db.query("fees")`), a different
 *   imported service, model or store, or a different custom child component (one data hook per API route, one
 *   service function per table, one sheet per page);
 * - they are data, not logic: lookup tables (three or more `case`s or literal returns) where most literals differ;
 * - they are configured instances: components that pass different literals to the same custom component, so the
 *   shared part already exists.
 * @param {Unit} a @param {Unit} b
 */
function apart(a, b) {
  const pairs = align(a.norm, b.norm) ?? [];
  let i0 = 0;
  let j0 = 0;
  let literals = 0;
  let changed = 0;
  let props = 0;
  for (const [i, j] of [...pairs, [a.norm.length, b.norm.length]]) {
    if (resourceIn(a, i0, i) && resourceIn(b, j0, j)) return true;
    [i0, j0] = [i + 1, j + 1];
    if (i === a.norm.length) break;
    const differs = a.raw[i] !== b.raw[j];
    if (differs && resource(a, i) && resource(b, j)) return true;
    if (!LITERAL.test(a.rawKind[i])) continue;
    literals++;
    if (!differs) continue;
    if (a.rawKind[i] === "str" && (selector(a, i) || [a.raw[i], b.raw[j]].some((t) => ADDRESS.test(t) || ENV_NAME.test(t)))) return true;
    changed++;
    if (customProp(a, i)) props++;
  }
  if (a.kind === "component") return changed > 0 && props === changed;
  const branches = a.norm.filter((t, k) => t === "case" || (t === "return" && LITERAL_NORM.test(a.norm[k + 1] ?? ""))).length;
  return branches >= 3 && changed >= 3 && changed * 2 >= literals;
}

/** @param {Entry} e @param {Entry} other @param {number} sim */
function message(e, other, sim) {
  const where = `${e.file}:${e.unit.line} ${e.unit.name} is ${Math.floor(sim * 100)}% the same as ${other.file}:${other.unit.line} ${other.unit.name}`;
  if (e.unit.kind === "type") return `${where}: use one type`;
  const diff = differences(e.unit, other.unit);
  if (diff === "") return `${where}: reuse it`;
  if (diff === undefined) return `${where}: reuse it, or extract what they share`;
  const one = e.unit.kind === "component" ? "one component with a variant prop" : e.unit.kind === "class" ? "one class with a parameter" : "one function with a parameter";
  return `${where} and differs only in ${diff}: make them ${one}`;
}

/**
 * Pairs of an added unit and the existing unit it repeats.
 * @param {string} cwd @param {string[]} files @param {Map<string, Set<number>>} added @param {number} n duplicates' block size
 */
function similarPairs(cwd, files, added, n) {
  const { all, fresh } = collect(cwd, files, added);
  /** @type {Set<string>} */
  const seen = new Set();
  const pairs = match(fresh, all).filter(([e, other, sim]) => {
    const key = [e, other].map((x) => `${x.file}:${x.unit.line}`).sort().join(" ");
    if (sim < (e.unit.kind === "type" ? TYPE_THRESHOLD : THRESHOLD) || seen.has(key) || pasted(cwd, e, other, n) || apart(e.unit, other.unit)) return false;
    seen.add(key);
    return true;
  });
  return { pairs, units: all.length, fresh: fresh.length };
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function similar({ cwd, base, testPaths, duplicateLines }) {
  const sha = resolveBase(cwd, base);
  // The project's added units against every unit in the repository: the original may be in a shared package.
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = addedLines(patch);
  const files = listFiles(cwd).filter((f) => !SKIP.test(f) && !NOT_SOURCE.test(f) && !matches(f, testPaths));
  const sources = new Set(files);
  if (![...added.keys()].some((f) => sources.has(f))) return { findings: [], summary: `0 added units checked` };
  const { pairs, units, fresh } = similarPairs(cwd, files, added, duplicateLines);
  const findings = pairs.map(([e, other, sim]) => ({ target: `${e.file}:${e.unit.name}`, message: message(e, other, sim) }));
  return { findings, summary: `${fresh} added units checked against ${units} units` };
}
