// @ts-check
// `intersite search <file>[:<line>[-<line>]] | - [--max <n>] [--json]`: the functions in this repository that
// contain a piece of code, after Aroma's structural search: candidates by shared features, then each pruned to the
// part that matches, ranked by how much of the query that part holds. Renamed variables and reordered or extra
// statements still match. A query is the function at a line, a range of lines, a whole file, or code on stdin.
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { JS_FILE, SKIP, counts, indexUnits, lines, overlap, parser, prune, scattered, snippet, span, units } from "../gates/features.mjs";
import { GateError, inGit, listFiles, matches } from "../gates/lib.mjs";
import { loadConfig } from "../shared/config.mjs";

const usage = "usage: intersite search <file>[:<line>[-<line>]] | - [--max <n>] [--json]";
// How many candidates by shared features are pruned: Aroma's first phase keeps a fixed number before reranking.
const CANDIDATES = 100;
// A match holds at least this share of the query's features. Tuned on half-function queries over this repository:
// the function each came from held 89% or more of nine in ten, and the best unrelated match held under 50%.
const MIN_SHARE = 0.5;

/** @typedef {import("../gates/features.mjs").Unit} Unit */

/**
 * The query and where it sits in the repository, if it does, so it does not match itself.
 * @param {import("../gates/features.mjs").Oxc} oxc @param {string} arg @param {string} cwd
 * @returns {{ query: Unit | undefined, file?: string, from?: number, to?: number }}
 */
function readQuery(oxc, arg, cwd) {
  if (arg === "-") return { query: snippet(oxc, readFileSync(0, "utf8")) };
  const [, file, from, to] = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(arg) ?? [];
  let text;
  try {
    text = readFileSync(resolve(cwd, file), "utf8");
  } catch {
    throw new GateError(`cannot read ${file}: pass a file in this repository, or - to read code from stdin`);
  }
  const last = text.split("\n").length;
  // A whole file is read as a snippet: a query file is usually code cut from a function, not a module.
  if (!from) return { query: snippet(oxc, text, JS_FILE.test(file) ? extname(file) : undefined), file, from: 1, to: last };
  const start = Number(from);
  const end = to ? Number(to) : start;
  if (to) return { query: lines(oxc, file, text, start, end), file, from: start, to: end };
  // One line: the innermost function around it, or the line alone.
  const around = units(oxc, file, text).filter((u) => u.line <= start && start <= u.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
  return around ? { query: around, file, from: around.line, to: around.endLine } : { query: lines(oxc, file, text, start, start), file, from: start, to: start };
}

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function search(argv, { cwd }) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { max: { type: "string" }, json: { type: "boolean" } } });
  } catch (error) {
    console.error(`${/** @type {Error} */ (error).message.split("\n")[0]}; ${usage}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const max = values.max === undefined ? 5 : Number(values.max);
  if (positionals.length !== 1 || !(Number.isInteger(max) && max > 0)) {
    console.error(usage);
    return 2;
  }
  try {
    if (!inGit(cwd)) throw new GateError("search reads the repository's files through git: run `git init`");
    const oxc = await parser();
    const { query, file, from = 0, to = 0 } = readQuery(oxc, positionals[0], cwd);
    if (!query?.bag.length) throw new GateError(`no code to search for in ${positionals[0]}: point at lines that hold code, or pass a snippet that parses`);
    const { testPaths } = loadConfig(cwd).gates;
    const files = listFiles(cwd).filter((f) => JS_FILE.test(f) && !SKIP.test(f) && !matches(f, testPaths));
    const self = (/** @type {{ file: string, line: number, endLine: number }} */ u) => u.file === file && u.line <= to && from <= u.endLine;
    const all = await indexUnits(cwd, files);
    const candidates = all
      .filter((u) => !self(u))
      .map((u) => ({ u, shared: overlap(u.set, query.set) }))
      .filter((c) => c.shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, CANDIDATES);
    const want = counts(query.bag);
    const queryLines = query.leaves.map((l) => l.line);
    const length = Math.max(...queryLines) - Math.min(...queryLines) + 1;
    /** @type {Map<string, Unit[]>} */
    const parsedFiles = new Map();
    const ranked = candidates.flatMap(({ u }) => {
      if (!parsedFiles.has(u.file)) parsedFiles.set(u.file, units(oxc, u.file, readFileSync(resolve(cwd, u.file), "utf8")));
      const unit = parsedFiles.get(u.file)?.find((x) => x.line === u.line && x.name === u.name);
      if (!unit) return [];
      const { score, kept } = prune(want, unit.leaves);
      if (!kept.length) return [];
      const at = span(kept.map((i) => unit.leaves[i].line));
      if (scattered(at, length)) return [];
      return [{ file: u.file, name: u.name, line: u.line, endLine: u.endLine, size: u.size, share: score / query.bag.length, ...at }];
    });
    ranked.sort((a, b) => b.share - a.share || a.size - b.size);
    /** @type {typeof ranked} */
    const shown = [];
    for (const r of ranked) {
      if (shown.length === max || r.share < MIN_SHARE) break;
      // A function nested in another is one match: the better scored, or with equal scores the smaller, is shown.
      if (!shown.some((s) => s.file === r.file && s.line <= r.endLine && r.line <= s.endLine)) shown.push(r);
    }
    if (values.json) console.log(JSON.stringify({ query: { file, from, to, features: query.bag.length }, functions: all.length, matches: shown }));
    else if (!shown.length) console.log(`ok search: none of ${all.length} functions holds ${MIN_SHARE * 100}% of the query`);
    else for (const r of shown) console.log(`${r.file}:${r.line} ${r.name}: ${Math.floor(r.share * 100)}% of the query, at lines ${r.from}-${r.to}`);
    return 0;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`search: ${error.message}`);
    return 2;
  }
}
