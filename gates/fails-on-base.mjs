// @ts-check
// Proves a change's new tests fail without it: they pass in the working tree, then run against the base commit in a
// temporary worktree, where they must fail on a test's own verdict. A run that never got that far (the code does not
// compile or load there, a package or service is missing, or the time limit stopped it) proves nothing, and neither
// does a failure in a test the change did not touch. What a run's output proves is judged in core/outcome.rs.
import { runCore } from "./core.mjs";
import { EMPTY_TREE, GateError, baseName, changes, matches, projectPrefix, resolveBase, sh, withWorktree } from "./lib.mjs";

/** What a run's output proves. @param {{ code: number | null, timedOut: boolean, text: string }} run @param {string[]} expect */
export const outcomeOf = (run, expect = []) =>
  /** @type {{ kind: "pass" | "fail" | "compile" | "setup" | "timeout", why: string, elsewhere: string | null }} */ (runCore({ command: "outcome", options: { output: run.text, code: run.code, timedOut: run.timedOut, expect } }).data);

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function failsOnBase({ cwd, base, testCmd, testPaths, setup, timeout }) {
  if (!testCmd) throw new GateError('needs a test command: pass --cmd "<command>" or set "gates.testCmd" in intersite.yml');
  const sha = resolveBase(cwd, base);
  const name = baseName(cwd, base);
  if (sha === EMPTY_TREE) throw new GateError("there is no commit yet to run the tests on: commit the code before the fix first");
  const files = changes(cwd, sha)
    .filter((c) => c.status !== "D" && matches(c.path, testPaths))
    .map((c) => c.path);
  if (!files.length) throw new GateError(`no file changed since ${name} matches ${testPaths.join(", ")}`);
  const all = (/** @type {string} */ message) => ({ findings: files.map((file) => ({ file, target: file, message: `${file} ${message}; rerun: ${testCmd}` })), summary: "" });

  // A test that fails with the change too fails on the base for nothing to do with the bug.
  const now = await sh(testCmd, cwd, { timeout });
  const here = outcomeOf(now);
  if (here.kind !== "pass") return all(`does not pass with the change (${said(here, timeout)}), so failing on ${name} would prove nothing`);

  // The worktree is of the whole repository; the tests are copied into the project's folder in it, and run there.
  const prefix = projectPrefix(cwd);
  const overlay = files.map((path) => ({ path: prefix + path, deleted: false }));
  const run = await withWorktree({ cwd, ref: sha, setup, overlay }, (dir) => sh(testCmd, dir, { timeout }));
  const there = outcomeOf(run, files);
  if (there.kind === "pass") return all(`passes on ${name} without the change, so it does not test it`);
  if (there.kind !== "fail") return all(`fails on ${name} only because ${said(there, timeout)}, which proves nothing about the change: make the test reach the code it checks on ${name} too`);
  if (there.elsewhere) return all(`does not fail on ${name}: ${there.elsewhere} does, which the change did not touch`);
  return { findings: [], summary: `${testCmd} fails on ${name} (exit ${run.code}), as a test of the change should` };
}

/** Why a run proves nothing, in words. @param {{ kind: string, why: string }} outcome @param {number} timeout */
function said({ kind, why }, timeout) {
  if (kind === "timeout") return `it did not finish within ${timeout}s (give the test its own timeout so the runner reports it as a failure)`;
  if (kind === "compile") return `it does not compile or load: ${why}`;
  if (kind === "setup") return `it could not run: ${why || "the command failed before any test"}`;
  return "a test failed";
}
