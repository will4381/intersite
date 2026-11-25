// @ts-check
// `intersite twins [<file>:<line>] [--all] [--base <ref>] [--min <0-1>] [--json]`: functions that do the same job with
// different code, compared by what they use (names, calls, fields, strings), not their shape; `similar` covers shape.
// With a line, the functions most like the one around it; with --all, every pair in the repository; otherwise the
// functions this change added or edited, each against the rest. The work is in core/twins.rs.
import { posix } from "node:path";
import { parseArgs } from "node:util";

import { runCore } from "../gates/core.mjs";
import { EMPTY_TREE, GateError, JS_FILE, NOT_PRODUCT, SKIP, addedLines, inGit, listFiles, matches, projectPrefix, resolveBase, topLevel, workingDiff } from "../gates/lib.mjs";
import { loadConfig } from "../shared/config.mjs";

const usage = "usage: intersite twins [<file>:<line>] [--all] [--base <ref>] [--min <0-1>] [--max <n>] [--json]";

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function twins(argv, { cwd }) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean" }, base: { type: "string" }, min: { type: "string" }, max: { type: "string" }, json: { type: "boolean" } } });
  } catch (error) {
    console.error(`${/** @type {Error} */ (error).message.split("\n")[0]}; ${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const min = values.min === undefined ? 0.8 : Number(values.min);
  if (positionals.length > 1 || !(min > 0 && min < 1)) {
    console.error(usage);
    return 2;
  }
  try {
    const { answer, prefix } = findTwins(cwd, values, positionals[0], min);
    const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
    if (values.json) {
      console.log(JSON.stringify({ summary: answer.summary, findings: answer.findings, matches: answer.data?.matches ?? [] }));
      return 0;
    }
    if (answer.data?.matches) {
      for (const m of answer.data.matches) console.log(`${name(m.file)}:${m.line} ${m.name}: ${Math.round(m.score * 100)}% alike (${m.shared.join(", ")})`);
      if (!answer.data.matches.length) console.log(`ok twins: ${answer.summary}; none alike`);
      return 0;
    }
    for (const f of answer.findings) console.log(f.message.replaceAll(f.file, name(f.file)).replace(/ at ([^ :]+):/, (m, p) => ` at ${name(p)}:`));
    if (!answer.findings.length) console.log(`ok twins: ${answer.summary}; no two do the same job`);
    return 0;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`twins: ${error.message}`);
    return 2;
  }
}

/**
 * The engine's answer: the functions most like the one at `at`, every pair with `--all`, or else this change's
 * functions against the rest.
 * @param {string} cwd @param {{ all?: boolean, base?: string, max?: string }} values @param {string | undefined} at @param {number} min
 */
function findTwins(cwd, values, at, min) {
  if (!inGit(cwd)) throw new GateError("twins reads the repository's files through git: run `git init`");
  const config = loadConfig(cwd);
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  const files = listFiles(top).filter((f) => JS_FILE.test(f) && !SKIP.test(f) && !NOT_PRODUCT.test(f) && !matches(f, config.gates.testPaths));
  /** @type {Record<string, unknown>} */
  const options = { minScore: min, max: Number(values.max ?? 10) };
  let added;
  if (at) {
    const [, file, line] = /^(.*):(\d+)$/.exec(at) ?? [];
    if (!file) throw new GateError(`point at a line: ${usage}`);
    options.at = { file: posix.normalize(prefix + file), line: Number(line) };
  } else if (!values.all) {
    const sha = resolveBase(cwd, values.base ?? config.gates.base);
    const [patch] = sha === EMPTY_TREE ? [""] : workingDiff(cwd, [["-U0", "-M", sha]]);
    added = Object.fromEntries([...addedLines(patch)].map(([file, lines]) => [prefix + file, [...lines]]));
  }
  return { answer: runCore({ command: "twins", root: top, files, added, prefix, options }), prefix };
}

