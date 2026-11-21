// @ts-check
// Fails when a small deliberate break on a changed source line leaves the tests passing: coverage without checking.
// The mutants are chosen in core/hygiene.rs; this runs the tests against each.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCore } from "./core.mjs";
import { GateError, WORK_TREE, addedLines, matches, parseNameStatus, resolveBase, sh, topLevel, withWorktree, workingDiff } from "./lib.mjs";

const SOURCE = /\.(?:[cm]?js|tsx?|jsx)$/;

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function mutation({ cwd, base, testCmd, testPaths, setup, mutants: max, timeout }) {
  if (!testCmd) throw new GateError('needs a test command: pass --cmd "<command>" or set "gates.testCmd" in intersite.yml');
  const sha = resolveBase(cwd, base);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);

  // Which operators to flip, spread across lines and files, is chosen in core/hygiene.rs.
  const files = [...addedLines(patch)].sort(([a], [b]) => a.localeCompare(b)).filter(([path]) => SOURCE.test(path) && !matches(path, testPaths)).map(([path, lines]) => [path, [...lines]]);
  /** @type {{ path: string, line: number, at: number, from: string, to: string }[]} */
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
