// @ts-check
// Structural features of JavaScript and TypeScript code, after Aroma (Luan et al., "Aroma: Code Recommendation via
// Structural Code Search", OOPSLA 2019, arXiv 1812.01158). A file is parsed with oxc-parser into a simplified tree
// whose inner nodes are labelled by their syntax. Every name and literal in it (a leaf) yields features: itself;
// itself with its place in its parent, grandparent and great-grandparent; itself with the next leaf; and for a local
// variable, the places of two consecutive uses. Local names become #VAR, so a renamed copy has the same features,
// while imported, module-level, global and property names are kept. A function's features are those of the leaves
// inside it. Overlap of feature sets finds candidates fast, and `prune` keeps the part of a candidate that matches a
// query: how much of one piece of code sits inside another.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

import { GateError } from "./lib.mjs";

/**
 * @typedef {typeof import("oxc-parser")} Oxc
 * @typedef {{ id: number, name: string, local: boolean, at: number }} Leaf a name or literal; `id` hashes its text, #VAR for a local
 * @typedef {{ label: number, kids: (string | Leaf | Tree)[], member: boolean }} Tree a string kid is a keyword; `label` hashes the syntax
 * @typedef {{ line: number, feats: number[] }} Featured a leaf with the features it brings
 * @typedef {{ name: string, line: number, endLine: number, leaves: Featured[], bag: Int32Array, set: Int32Array }} Unit
 *   `bag`: every feature, sorted, with repeats; `set`: the same without repeats
 * @typedef {{ file: string, name: string, line: number, endLine: number, size: number, set: Int32Array }} Indexed `size`: leaves
 */

/** Bumped when features change, so cached ones from an older Intersite are recomputed. */
const VERSION = 1;
export const JS_FILE = /\.[cm]?[jt]sx?$/;
/** Installed, built and generated code: never written by hand, so never an original or a copy. */
export const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__)\/|\.min\.|\.d\.[cm]?ts$|\.generated\./;
const MAX_BYTES = 256 * 1024;
const TYPE_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments", "decorators", "implements"]);
// Nodes that only wrap one expression or statement: what they wrap stands in their place.
const WRAPPERS = new Set(["ExpressionStatement", "ChainExpression", "ParenthesizedExpression", "JSXExpressionContainer", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const DROPPED = new Set(["EmptyStatement", "JSXEmptyExpression", "JSXClosingElement", "JSXClosingFragment", "ImportDeclaration"]);
const BROWSER = new Set(["window", "document", "localStorage", "sessionStorage", "navigator", "location", "history"]);
const LITERAL_CHARS = 40;
const VAR = "#VAR";
const SLOT = 35;

/** oxc-parser, an optional peer that `search` and the similar gate's partial copies need, or undefined when missing. */
export async function optionalParser() {
  try {
    return await import("oxc-parser");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ERR_MODULE_NOT_FOUND") throw error;
    return undefined;
  }
}

/** oxc-parser, or a setup error saying how to install it. */
export async function parser() {
  const oxc = await optionalParser();
  if (!oxc) throw new GateError("oxc-parser is not installed: add it as a dev dependency (`npm i -D oxc-parser`)");
  return oxc;
}

/**
 * A source file's text, or undefined when it is missing, too large, binary or generated.
 * @param {string} cwd @param {string} file
 */
export function readSource(cwd, file) {
  if (statSync(join(cwd, file), { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  const text = readFileSync(join(cwd, file), "utf8");
  // ponytail: files over MAX_BYTES are skipped, as in duplicates; chunk them if large hand-written files matter
  if (text.length > MAX_BYTES || text.includes("\0") || /@generated|DO NOT EDIT/.test(text.slice(0, 500))) return undefined;
  return text;
}

/** @type {Map<string, number>} */
const hashes = new Map();

/** FNV-1a of a string, remembered: the same names and labels recur across a repository. @param {string} s */
function hashOf(s) {
  let h = hashes.get(s);
  if (h !== undefined) return h;
  h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  hashes.set(s, (h |= 0));
  return h;
}

// ponytail: 32-bit feature hashes, so a rare collision adds one feature to a match; pairs of hashes if it bites
/** One feature from a kind and up to three hashed parts. @param {number} kind @param {number} a @param {number} [b] @param {number} [c] */
function mix(kind, a, b = 0, c = 0) {
  let h = Math.imul(0x811c9dc5 ^ kind, 0x01000193);
  h = Math.imul(h ^ a, 0x01000193);
  h = Math.imul(h ^ b, 0x01000193);
  return Math.imul(h ^ c, 0x01000193) | 0;
}

/** Line number of each offset, by binary search over line starts. @param {string} text */
function lineOf(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (/** @type {number} */ offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** @type {Map<string, string[]>} */
const keysByType = new Map();
const NOT_CODE = new Set(["type", "start", "end", "range", "loc", "raw", "operator", "kind", "computed", "optional", "prefix", "async", "generator", "shorthand", "method", "static", "delegate", "directive"]);

/** The keys that may hold code on nodes of this node's type, type annotations left out. @param {any} node */
function codeKeys(node) {
  let keys = keysByType.get(node.type);
  if (!keys) keysByType.set(node.type, (keys = Object.keys(node).filter((key) => !NOT_CODE.has(key) && !TYPE_KEYS.has(key))));
  return keys;
}

/** The child nodes under the given keys of `node`. @param {any} node @returns {any[]} */
function children(node, keys = codeKeys(node)) {
  const out = [];
  for (const key of keys) {
    const value = node[key];
    if (!Array.isArray(value)) {
      if (typeof value?.type === "string") out.push(value);
      continue;
    }
    for (const child of value) if (typeof child?.type === "string") out.push(child);
  }
  return out;
}

/** Adds the names a binding pattern declares. @param {any} pattern @param {Set<string>} out */
function declare(pattern, out) {
  if (!pattern) return;
  if (pattern.type === "Identifier") out.add(pattern.name);
  else if (pattern.type === "ObjectPattern") for (const p of pattern.properties) declare(p.type === "RestElement" ? p.argument : p.value, out);
  else if (pattern.type === "ArrayPattern") for (const p of pattern.elements) declare(p, out);
  else if (pattern.type === "RestElement") declare(pattern.argument, out);
  else if (pattern.type === "AssignmentPattern") declare(pattern.left, out);
  else if (pattern.type === "TSParameterProperty") declare(pattern.parameter, out);
}

/**
 * One pass over a program: the names declared inside functions (parameters, variables, catch parameters, nested
 * functions and classes), or with `everywhere` at the top level too, as in a snippet cut from a function body; the
 * names called directly; and every named function.
 * ponytail: one set per file, so shadowing is ignored; a scope tree if a shadowed import ever matters
 * @param {any} program @param {boolean} everywhere @param {string} fallback the name of a default-exported function
 */
function scan(program, everywhere, fallback) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<string>} */
  const called = new Set();
  /** @type {{ name: string, start: number, end: number }[]} */
  const functions = [];
  /** @type {any[]} */
  const ancestors = [];
  const visit = (/** @type {any} */ node, /** @type {boolean} */ inside) => {
    const fn = FUNCTIONS.has(node.type);
    if (fn) {
      for (const p of node.params) declare(p, names);
      const name = nameOf(node, ancestors, fallback);
      if (name) functions.push({ name, start: node.start, end: node.end });
    }
    if (inside || everywhere) {
      if (node.type === "VariableDeclarator") declare(node.id, names);
      if (node.type === "CatchClause") declare(node.param, names);
      if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) names.add(node.id.name);
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier") called.add(node.callee.name);
    ancestors.push(node);
    for (const child of children(node)) visit(child, inside || fn);
    ancestors.pop();
  };
  visit(program, false);
  return { names, called, functions };
}

/**
 * Whether the identifier at `key` of `node` is a property or label, whose name is kept and never a variable.
 * @param {any} node @param {string} key
 */
function named(node, key) {
  if (key === "property") return node.type === "JSXMemberExpression" || (node.type === "MemberExpression" && !node.computed);
  if (key === "key") return !node.computed;
  return key === "label" || (key === "name" && node.type === "JSXAttribute");
}

/** @param {string} text @param {string} name @param {boolean} local @param {number} at @returns {Leaf} */
const leaf = (text, name, local, at) => ({ id: hashOf(text), name, local, at });

/**
 * The simplified tree of `node`: a keyword string, a leaf, a labelled subtree, or undefined when it holds no code
 * (types, empty statements, imports).
 * @param {any} node @param {boolean} ref whether an identifier here is a variable reference
 * @param {(name: string) => boolean} local
 * @returns {string | Leaf | Tree | undefined}
 */
function simplify(node, ref, local) {
  const type = node.type;
  if (WRAPPERS.has(type)) return simplify(node.expression, ref, local);
  if (type === "TSParameterProperty") return simplify(node.parameter, ref, local);
  if (type.startsWith("TS") || DROPPED.has(type)) return undefined;
  if (type === "ThisExpression") return "this";
  if (type === "Super") return "super";
  if (type === "Identifier" || type === "JSXIdentifier" || type === "PrivateIdentifier") {
    const name = type === "PrivateIdentifier" ? `#${node.name}` : node.name;
    if (ref && name === "undefined") return name;
    const isLocal = ref && local(name);
    return leaf(isLocal ? VAR : name, name, isLocal, node.start);
  }
  if (type === "Literal") {
    if (typeof node.value === "boolean" || node.raw === "null") return node.raw;
    const text = typeof node.value === "string" ? JSON.stringify(node.value.slice(0, LITERAL_CHARS)) : String(node.raw);
    return leaf(text, text, false, node.start);
  }
  if (type === "TemplateElement" || type === "JSXText") {
    const raw = (type === "JSXText" ? node.value : (node.value.cooked ?? node.value.raw)).trim().replace(/\s+/g, " ").slice(0, LITERAL_CHARS);
    return raw ? leaf(`\`${raw}\``, raw, false, node.start) : undefined;
  }
  /** @type {[number, string | Leaf | Tree][]} */
  const kids = [];
  for (const key of codeKeys(node)) {
    // A function's own name is what a renamed copy changes: `function f() {}` reads as `const f = () => {}`.
    if (key === "id" && FUNCTIONS.has(type)) continue;
    for (const child of children(node, [key])) {
      const kid = simplify(child, !named(node, key), local);
      if (kid !== undefined) kids.push([child.start, kid]);
    }
  }
  kids.sort((a, b) => a[0] - b[0]);
  const list = kids.map(([, kid]) => kid);
  // `if (x) y;` reads as `if (x) { y; }`, and `const a = 1;` as its one declarator.
  if ((type === "BlockStatement" || type === "VariableDeclaration") && list.length === 1 && typeof list[0] !== "string") return list[0];
  if (type === "BlockStatement" && list.length === 0) return "{}";
  const kind = (type === "Property" && node.kind !== "init") || (type === "MethodDefinition" && node.kind !== "method") ? node.kind : "";
  const flags = `${node.operator ?? ""}${node.computed ? "[]" : ""}${node.optional === true && !type.endsWith("Pattern") ? "?" : ""}${node.prefix === false ? "post" : ""}${node.delegate ? "*" : ""}${kind}`;
  // The label is the syntax with a # for each leaf or subtree, `BinaryExpression<(#,#)`, hashed as it is built.
  let label = hashOf(`${FUNCTIONS.has(type) ? "Function" : type}${flags}`);
  for (const kid of list) label = Math.imul(label ^ (typeof kid === "string" ? hashOf(kid) : SLOT), 0x01000193);
  return { label: label | 0, kids: list, member: type === "MemberExpression" && !node.computed };
}

/**
 * Aroma's four feature kinds for every leaf of `tree`, in source order, each with the features it brings.
 * @param {Tree} tree @param {(offset: number) => number} line
 */
function featurize(tree, line) {
  /** @typedef {{ label: number, slot: number, up: Place | undefined }} Place */
  /** @type {{ leaf: Leaf, feats: number[], context: number }[]} */
  const found = [];
  const walk = (/** @type {Tree} */ node, /** @type {Place | undefined} */ up) => {
    let slot = 0;
    for (const kid of node.kids) {
      if (typeof kid === "string") continue;
      slot++;
      /** @type {Place} */
      const place = { label: node.label, slot, up };
      if ("kids" in kid) {
        walk(kid, place);
        continue;
      }
      const feats = [mix(1, kid.id)];
      for (let p = /** @type {Place | undefined} */ (place), depth = 0; p && depth < 3; p = p.up, depth++) feats.push(mix(2, kid.id, p.slot, p.label));
      // A local's context is its place in its parent, or for `x.foo` the property it is reached into.
      const property = node.member && slot === 1 ? node.kids.find((k, i) => i > 0 && typeof k !== "string") : undefined;
      const context = property && !("kids" in property) ? property.id : mix(3, slot, node.label);
      found.push({ leaf: kid, feats, context });
    }
  };
  walk(tree, undefined);
  /** @type {Map<string, number>} */
  const lastUse = new Map();
  found.forEach((entry, i) => {
    const next = found[i + 1];
    if (next) entry.feats.push(mix(4, entry.leaf.id, next.leaf.id));
    if (!entry.leaf.local) return;
    const before = lastUse.get(entry.leaf.name);
    if (before !== undefined) entry.feats.push(mix(5, found[before].context, entry.context));
    lastUse.set(entry.leaf.name, i);
  });
  return found.map(({ leaf: l, feats }) => ({ at: l.at, line: line(l.at), feats }));
}

/** The features of some leaves, sorted with and without repeats. @param {Featured[]} leaves */
function bags(leaves) {
  const bag = Int32Array.from(leaves.flatMap((l) => l.feats)).sort();
  let n = 0;
  const set = new Int32Array(bag.length);
  for (let i = 0; i < bag.length; i++) if (i === 0 || bag[i] !== bag[i - 1]) set[n++] = bag[i];
  return { bag, set: set.slice(0, n) };
}

/**
 * The name a function goes by: its own, the variable or property it is assigned to, the variable a call wrapping it
 * is assigned to (`const Card = memo(() => …)`), or the file's name for a default export. Undefined for a callback.
 * @param {any} fn @param {any[]} path ancestors, nearest last @param {string} fallback
 */
function nameOf(fn, path, fallback) {
  if (fn.id?.name) return fn.id.name;
  const [grand, parent] = path.slice(-2);
  if (parent?.type === "VariableDeclarator" && parent.init === fn && parent.id.type === "Identifier") return parent.id.name;
  if (/^(?:Property|MethodDefinition|PropertyDefinition)$/.test(parent?.type) && parent.value === fn && !parent.computed) return parent.key.name ?? String(parent.key.value);
  if (parent?.type === "ExportDefaultDeclaration") return fallback;
  if (parent?.type === "CallExpression" && grand?.type === "VariableDeclarator" && grand.init === parent && grand.id.type === "Identifier") return grand.id.name;
  return undefined;
}

/**
 * A file's leaves with their features, and its named functions, nested ones included, as ranges of those leaves.
 * Undefined when the file does not parse.
 * @param {Oxc} oxc @param {string} path @param {string} text
 * @param {"file" | "snippet"} as a snippet's top-level names are a function body's locals, and a name it uses without
 *   declaring is a variable when it is lowercase, not imported, not called and not a global
 */
function analyze(oxc, path, text, as = "file") {
  // Raw transfer hands the AST over in shared memory, six times faster than JSON on a few thousand files.
  const { program, errors } = oxc.parseSync(path, text, { preserveParens: false, experimentalRawTransfer: oxc.rawTransferSupported() });
  if (errors.length && !program.body.length) return undefined;
  const line = lineOf(text);
  const fallback = (path.split("/").pop() ?? "").replace(/\..*$/, "");
  const { names, called, functions } = scan(program, as === "snippet", fallback);
  const imported = new Set(program.body.flatMap((/** @type {any} */ s) => (s.type === "ImportDeclaration" ? s.specifiers.map((/** @type {any} */ x) => x.local.name) : [])));
  const loose = (/** @type {string} */ name) => !imported.has(name) && !called.has(name) && /^[a-z_$]/.test(name) && !BROWSER.has(name) && !(name in globalThis);
  const tree = simplify(program, true, as === "snippet" ? (name) => names.has(name) || loose(name) : (name) => names.has(name));
  const leaves = tree && typeof tree !== "string" && "kids" in tree ? featurize(tree, line) : [];
  /** First leaf at or after an offset. @param {number} offset */
  const first = (offset) => {
    let lo = 0;
    let hi = leaves.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (leaves[mid].at < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const named = functions.map(({ name, start, end }) => ({ name, line: line(start), endLine: line(end - 1), from: first(start), to: first(end) }));
  return { leaves, named };
}

/**
 * Every named function in a JavaScript or TypeScript file, nested ones included, with its features.
 * @param {Oxc} oxc @param {string} path @param {string} text
 * @returns {Unit[]}
 */
export function units(oxc, path, text) {
  const found = analyze(oxc, path, text);
  if (!found) return [];
  return found.named.flatMap(({ name, line, endLine, from, to }) => {
    const leaves = found.leaves.slice(from, to);
    return leaves.length ? [{ name, line, endLine, leaves, ...bags(leaves) }] : [];
  });
}

/**
 * The code on lines `from` to `to` of a file, as a query, or undefined when the file does not parse.
 * @param {Oxc} oxc @param {string} path @param {string} text @param {number} from @param {number} to
 * @returns {Unit | undefined}
 */
export function lines(oxc, path, text, from, to) {
  const found = analyze(oxc, path, text);
  if (!found) return undefined;
  const leaves = found.leaves.filter((l) => l.line >= from && l.line <= to);
  return { name: `lines ${from}-${to}`, line: from, endLine: to, leaves, ...bags(leaves) };
}

/**
 * A query from loose code that may be only statements, a method or an expression, as cut from a function body.
 * @param {Oxc} oxc @param {string} text @param {string} [ext] the extension that says which syntax to parse
 * @returns {Unit | undefined}
 */
export function snippet(oxc, text, ext = ".tsx") {
  for (const [before, after] of [["", ""], ["function snippet() {\n", "\n}"], ["class Snippet {\n", "\n}"], ["(\n", "\n)"]]) {
    const found = analyze(oxc, `snippet${ext}`, before + text + after, "snippet");
    if (!found?.leaves.length) continue;
    const shift = before ? 1 : 0;
    const leaves = found.leaves.map((l) => ({ ...l, line: l.line - shift }));
    return { name: "snippet", line: 1, endLine: text.split("\n").length, leaves, ...bags(leaves) };
  }
  return undefined;
}

/** How many values two sorted sets share. @param {Int32Array} a @param {Int32Array} b */
export function overlap(a, b) {
  let n = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      n++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

/** Each feature's count in a bag. @param {Int32Array} bag */
export function counts(bag) {
  /** @type {Map<number, number>} */
  const out = new Map();
  for (const f of bag) out.set(f, (out.get(f) ?? 0) + 1);
  return out;
}

/**
 * Aroma's pruning: greedily keeps the leaves of a candidate that add the most features the query also has, until
 * none adds any. `score` is how many of the query's features the kept part matches, so `score / query size` is how
 * much of the query the candidate contains; `kept` are the indices of the kept leaves.
 * @param {Map<number, number>} want the query's feature counts @param {Featured[]} leaves the candidate's
 */
export function prune(want, leaves) {
  /** @type {Map<number, number>} */
  const have = new Map();
  const gain = (/** @type {Featured} */ l) => {
    let g = 0;
    l.feats.forEach((f, i) => {
      let earlier = 0;
      for (let j = 0; j < i; j++) if (l.feats[j] === f) earlier++;
      if ((have.get(f) ?? 0) + earlier < (want.get(f) ?? 0)) g++;
    });
    return g;
  };
  // Lazy greedy over buckets of each leaf's last known gain. What a leaf could match only shrinks as others are
  // kept, so a gain that still equals its bucket's is the best there is, and a leaf whose gain reaches 0 is done.
  /** @type {number[][]} */
  const buckets = [];
  for (let i = leaves.length - 1; i >= 0; i--) {
    const g = gain(leaves[i]);
    if (g > 0) (buckets[g] ??= []).push(i);
  }
  /** @type {number[]} */
  const kept = [];
  let score = 0;
  for (let level = buckets.length - 1; level > 0; ) {
    const i = buckets[level]?.pop();
    if (i === undefined) {
      level--;
      continue;
    }
    const g = gain(leaves[i]);
    if (g === level) {
      kept.push(i);
      score += g;
      for (const f of leaves[i].feats) have.set(f, (have.get(f) ?? 0) + 1);
    } else if (g > 0) (buckets[g] ??= []).push(i);
  }
  return { score, kept };
}

/**
 * The lines a match is at: the shortest run of lines holding nine in ten of the kept leaves, so a stray `.push(` far
 * from the copied block does not stretch it.
 * @param {number[]} at the kept leaves' lines
 */
export function span(at) {
  const sorted = [...at].sort((a, b) => a - b);
  const need = Math.max(1, Math.ceil(sorted.length * 0.9));
  let best = [sorted[0], sorted[sorted.length - 1]];
  for (let i = 0; i + need <= sorted.length; i++) {
    if (sorted[i + need - 1] - sorted[i] < best[1] - best[0]) best = [sorted[i], sorted[i + need - 1]];
  }
  return { from: best[0], to: best[1] };
}

// A match sits in a run of lines at most twice the length of what it matches, plus a little: matches scattered over
// a big function are shared idioms, not a copy.
const SPREAD = 2;
const SPREAD_LINES = 10;

/** Whether a match at `from`-`to` is scattered, for code `length` lines long. @param {{ from: number, to: number }} at @param {number} length */
export function scattered({ from, to }, length) {
  return to - from > length * SPREAD + SPREAD_LINES;
}

/**
 * The named functions of `files` with their feature sets, cached by file content in `cacheDir`, so only files
 * changed since the last run are parsed.
 * @param {string} cwd @param {string[]} files @param {string} [cacheDir]
 * @returns {Promise<Indexed[]>}
 */
export async function indexUnits(cwd, files, cacheDir = join(cwd, "node_modules/.cache/intersite")) {
  const oxc = await parser();
  // ponytail: one cache file rewritten whole when anything changed (~25 MB at 4,000 files); shard by folder past that
  const version = `${VERSION}:${createRequire(import.meta.url)("oxc-parser/package.json").version}`;
  const path = join(cacheDir, "features.bin");
  /** @type {Map<string, Omit<Indexed, "file">[]>} */
  let saved = new Map();
  try {
    const cache = deserialize(readFileSync(path));
    if (cache.version === version) saved = cache.entries;
  } catch {
    // No cache yet, or one another Node cannot read: every file is parsed and the cache written again.
  }
  /** @type {typeof saved} */
  const entries = new Map();
  /** @type {Indexed[]} */
  const all = [];
  let parsed = 0;
  for (const file of files) {
    if (!JS_FILE.test(file)) continue;
    const text = readSource(cwd, file);
    if (text === undefined) continue;
    const key = createHash("sha1").update(file).update("\0").update(text).digest("base64");
    let found = saved.get(key);
    if (!found) {
      parsed++;
      found = units(oxc, file, text).map(({ name, line, endLine, leaves, set }) => ({ name, line, endLine, size: leaves.length, set }));
    }
    entries.set(key, found);
    for (const unit of found) all.push({ file, ...unit });
  }
  if (parsed || entries.size !== saved.size) {
    mkdirSync(cacheDir, { recursive: true });
    // Written aside and renamed, so a run that stops halfway never leaves a torn cache.
    const temp = `${path}.${process.pid}`;
    writeFileSync(temp, serialize({ version, entries }));
    renameSync(temp, path);
  }
  return all;
}
