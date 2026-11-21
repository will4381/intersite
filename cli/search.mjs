// @ts-check
// `intersite search <file>[:<line>[-<line>]] | - [--max <n>] [--json]`: the functions in this repository that
// contain a piece of code, after Aroma's structural search: candidates by shared features, then each pruned to the
// part that matches, ranked by how much of the query that part holds. Renamed variables and reordered or extra
// statements still match. A query is the function at a line, a range of lines, a whole file, or code on stdin.
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runCore } from "../gates/core.mjs";
import { GateError, JS_FILE, SKIP, inGit, listFiles, matches } from "../gates/lib.mjs";
import { loadConfig } from "../shared/config.mjs";

const usage = "usage: intersite search <file>[:<line>[-<line>]] | - [--max <n>] [--json]";

/**
 * The query to send to the engine (core/search.rs): code on stdin, a whole file as a snippet, a range of lines, or
 * the function around one line.
 * @param {string} arg @param {string} cwd
 */
function readQuery(arg, cwd) {
  if (arg === "-") return { kind: "snippet", text: readFileSync(0, "utf8") };
  const [, file, from, to] = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(arg) ?? [];
  let text;
  try {
    text = readFileSync(resolve(cwd, file), "utf8");
  } catch {
    throw new GateError(`cannot read ${file}: pass a file in this repository, or - to read code from stdin`);
  }
  // A whole file is read as a snippet: a query file is usually code cut from a function, not a module.
  if (!from) return { kind: "snippet", text, file, ext: JS_FILE.test(file) ? extname(file) : undefined };
  if (to) return { kind: "lines", text, file, from: Number(from), to: Number(to) };
  return { kind: "around", text, file, line: Number(from) };
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
    const query = readQuery(positionals[0], cwd);
    const { testPaths } = loadConfig(cwd).gates;
    const files = listFiles(cwd).filter((f) => JS_FILE.test(f) && !SKIP.test(f) && !matches(f, testPaths));
    let answer;
    try {
      answer = runCore({ command: "search", root: cwd, files, options: { query, max } });
    } catch (error) {
      if (error instanceof GateError && /^no code to search for|does not parse/.test(error.message)) throw new GateError(`no code to search for in ${positionals[0]}: point at lines that hold code, or pass a snippet that parses`);
      throw error;
    }
    const { query: q, functions, matches: shown, minShare } = answer.data;
    if (values.json) console.log(JSON.stringify({ query: { file: q.file ?? undefined, from: q.from, to: q.to, features: q.features }, functions, matches: shown }));
    else if (!shown.length) console.log(`ok search: none of ${functions} functions holds ${minShare * 100}% of the query`);
    else for (const r of shown) console.log(`${r.file}:${r.line} ${r.name}: ${Math.floor(r.share * 100)}% of the query, at lines ${r.from}-${r.to}`);
    return 0;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`search: ${error.message}`);
    return 2;
  }
}
