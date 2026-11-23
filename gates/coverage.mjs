// @ts-check
// Fails when a function the change added or edited runs in no test. Runs `gates.testCmd` once in the working tree
// with V8 coverage on in every Node process it starts; which functions ran is read in core/coverage.rs.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCore } from "./core.mjs";
import { GateError, JS_FILE, NOT_PRODUCT, SKIP, addedLines, matches, resolveBase, sh, workingDiff } from "./lib.mjs";

/** Config files run the tools, not the product. */
const CONFIG = /(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/;

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function coverage({ cwd, base, testCmd, testPaths, timeout }) {
  if (!testCmd) throw new GateError('needs a test command: pass --cmd "<command>" or set "gates.testCmd" in intersite.yml');
  const [patch] = workingDiff(cwd, [["-U0", "-M", resolveBase(cwd, base)]]);
  const files = [...addedLines(patch)]
    .filter(([path]) => JS_FILE.test(path) && !SKIP.test(path) && !NOT_PRODUCT.test(path) && !CONFIG.test(path) && !matches(path, testPaths))
    .map(([path, lines]) => ({ path, lines: [...lines] }));
  if (!files.length) return { findings: [], summary: "no changed source" };
  const dir = mkdtempSync(join(tmpdir(), "intersite-coverage-"));
  try {
    const run = await sh(testCmd, cwd, { timeout, output: "ignore", env: { NODE_V8_COVERAGE: dir } });
    if (run.code !== 0) throw new GateError(`the tests must pass to measure what they run, and ${testCmd} ${run.timedOut ? `timed out after ${timeout}s` : `exited ${run.code}`}`);
    // Node names modules by their real path, so the project is named the same way (macOS's /var is /private/var).
    const answer = runCore({ command: "coverage", root: realpathSync(cwd), options: { dir, files } });
    return { findings: answer.findings.map(({ file, line, target, message }) => ({ file, line, target, message })), summary: answer.summary };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
