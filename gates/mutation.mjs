// @ts-check
// Fails when a small deliberate break on a changed source line leaves the tests passing: coverage without checking.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GateError, WORK_TREE, addedLines, matches, parseNameStatus, resolveBase, sh, stripCode, topLevel, withWorktree, workingDiff } from "./lib.mjs";

const SOURCE = /\.(?:[cm]?js|tsx?|jsx)$/;
// Longest first. The compound tokens are matched only so their pieces are never mutated on their own.
const TOKEN = /===|!==|=>|\+\+|--|\+=|-=|>>>?=?|<<=?|\*\*|==|!=|<=|>=|&&|\|\||<|>|\+|-|\btrue\b|\bfalse\b|!(?!=)/g;
/** @type {Record<string, string>} */
const SWAP = { "===": "!==", "!==": "===", "==": "!=", "!=": "==", "<": ">=", ">=": "<", ">": "<=", "<=": ">", "&&": "||", "||": "&&", "+": "-", "-": "+", true: "false", false: "true", "!": "" };

/**
 * Takes one item from each list in turn, so the first mutants are spread across every list.
 * @template T
 * @param {T[][]} lists
 */
function interleave(lists) {
  /** @type {T[]} */
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function mutation({ cwd, base, testCmd, testPaths, setup, mutants: max, timeout }) {
  if (!testCmd) throw new GateError('needs a test command: pass --cmd "<command>" or set "gates.testCmd" in intersite.yml');
  const sha = resolveBase(cwd, base);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);

  /** @type {{ path: string, line: number, at: number, from: string, to: string }[][]} */
  const perFile = [];
  for (const [path, lines] of [...addedLines(patch)].sort(([a], [b]) => a.localeCompare(b))) {
    if (!SOURCE.test(path) || matches(path, testPaths)) continue;
    const text = readFileSync(join(cwd, path), "utf8");
    const code = stripCode(text).split("\n");
    let offset = 0;
    /** @type {(typeof perFile)[number][]} */
    const perLine = [];
    code.forEach((lineCode, i) => {
      if (lines.has(i + 1)) {
        const found = [...lineCode.matchAll(TOKEN)].filter((m) => m[0] in SWAP);
        perLine.push(found.map((m) => ({ path, line: i + 1, at: offset + (m.index ?? 0), from: m[0], to: SWAP[m[0]] })));
      }
      offset += lineCode.length + 1;
    });
    perFile.push(interleave(perLine));
  }
  const chosen = interleave(perFile).slice(0, max);

  // A worktree of HEAD with the whole repository's uncommitted changes (and deletions) copied over, since the project's
  // tests may use a sibling package edited alongside it. Paths are relative to the repository top, as the overlay wants.
  const top = topLevel(cwd);
  const [sinceHead] = workingDiff(top, [["--name-status", "--no-renames", "-z", "HEAD"]], WORK_TREE);
  const overlay = parseNameStatus(sinceHead).map((c) => ({ path: c.path, deleted: c.status === "D" }));
  return withWorktree({ cwd, ref: "HEAD", setup, overlay }, async (dir) => {
    const baseline = await sh(testCmd, dir, { timeout, output: "ignore" });
    if (baseline.code !== 0) {
      throw new GateError(`the tests must pass before mutating, and ${testCmd} ${baseline.timedOut ? `timed out after ${timeout}s` : `exited ${baseline.code}`}`);
    }
    /** @type {import("./lib.mjs").Finding[]} */
    const findings = [];
    for (const m of chosen) {
      const file = join(dir, m.path);
      const original = readFileSync(file, "utf8");
      writeFileSync(file, original.slice(0, m.at) + m.to + original.slice(m.at + m.from.length));
      try {
        // A timeout counts as killed: the mutant changed behaviour enough to hang the tests.
        const run = await sh(testCmd, dir, { timeout, output: "ignore" });
        if (run.code === 0) findings.push({ target: `${m.path}:${m.line}`, message: `${m.path}:${m.line} survived '${m.from}' → '${m.to}'` });
      } finally {
        writeFileSync(file, original);
      }
    }
    return { findings, summary: `${chosen.length - findings.length}/${chosen.length} mutants killed` };
  });
}
