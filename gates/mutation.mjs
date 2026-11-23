// @ts-check
// Fails when a small deliberate break in changed code leaves the tests passing: coverage without checking. After
// Google's mutation testing in code review: a changed function's body removed, then one operator flip per changed line,
// never in logging or error text. The mutants are chosen in core/hygiene.rs; this runs the tests against each.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCore } from "./core.mjs";
import { GateError, WORK_TREE, addedLines, matches, parseNameStatus, resolveBase, sh, topLevel, withWorktree, workingDiff } from "./lib.mjs";

const SOURCE = /\.(?:[cm]?js|tsx?|jsx)$/;
/** Survivors reported per file: past a few, more lines of the same file only repeat that its tests are thin. */
const PER_FILE = 3;

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function mutation({ cwd, base, testCmd, testPaths, setup, mutants: max, timeout }) {
  if (!testCmd) throw new GateError('needs a test command: pass --cmd "<command>" or set "gates.testCmd" in intersite.yml');
  const sha = resolveBase(cwd, base);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);

  // Which mutants to try, spread across lines and files, is chosen in core/hygiene.rs.
  const files = [...addedLines(patch)].sort(([a], [b]) => a.localeCompare(b)).filter(([path]) => SOURCE.test(path) && !matches(path, testPaths)).map(([path, lines]) => [path, [...lines]]);
  /** @type {{ kind: "body" | "operator", path: string, line: number, at: number, length: number, from: string, to: string, name?: string, text?: string, key?: string, within: string[] }[]} */
  const chosen = runCore({ command: "mutants", root: cwd, options: { files, max } }).data;

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
    /** Functions whose removed body went unnoticed: flipping an operator inside them would only say so again. */
    const unchecked = new Set();
    /** @type {Map<string, number>} */
    const survivors = new Map();
    let tried = 0;
    for (const m of chosen) {
      if (m.within.some((key) => unchecked.has(key)) || (survivors.get(m.path) ?? 0) >= PER_FILE) continue;
      tried++;
      const file = join(dir, m.path);
      const original = readFileSync(file, "utf8");
      writeFileSync(file, original.slice(0, m.at) + m.to + original.slice(m.at + m.length));
      try {
        // A timeout counts as killed: the mutant changed behaviour enough to hang the tests.
        const run = await sh(testCmd, dir, { timeout, output: "ignore" });
        if (run.code !== 0) continue;
        survivors.set(m.path, (survivors.get(m.path) ?? 0) + 1);
        const task = "write a test that fails on this mutant and passes on the real code";
        if (m.kind === "body") {
          unchecked.add(m.key);
          findings.push({ file: m.path, line: m.line, target: `${m.path}:${m.name}`, message: `${m.path}:${m.line} no test notices when ${m.name}'s body is removed: ${task}` });
        } else {
          findings.push({ file: m.path, line: m.line, target: `${m.path}:${m.line}`, message: `${m.path}:${m.line} no test fails when '${m.from}' becomes '${m.to}' (\`${m.text}\`): ${task}` });
        }
      } finally {
        writeFileSync(file, original);
      }
    }
    return { findings, summary: `${tried - findings.length}/${tried} mutants killed` };
  });
}
