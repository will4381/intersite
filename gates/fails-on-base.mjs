// @ts-check
// Proves a change's new tests fail without it: run them against the base commit in a temporary worktree.
import { EMPTY_TREE, GateError, baseName, changes, matches, projectPrefix, resolveBase, sh, withWorktree } from "./lib.mjs";

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

  // The worktree is of the whole repository; the tests are copied into the project's folder in it, and run there.
  const prefix = projectPrefix(cwd);
  const overlay = files.map((path) => ({ path: prefix + path, deleted: false }));
  const { code, timedOut } = await withWorktree({ cwd, ref: sha, setup, overlay }, (dir) => sh(testCmd, dir, { timeout }));
  // A test that waits forever for something the old code never does has not passed without the change either.
  if (timedOut) return { findings: [], summary: `${testCmd} does not finish within ${timeout}s on ${name}, so it does not pass without the change` };
  if (code !== 0) return { findings: [], summary: `${testCmd} fails on ${name} (exit ${code}), as a test of the change should` };
  return {
    findings: files.map((file) => ({ target: file, message: `${file} passes on ${name} without the change, so it does not test it; rerun: ${testCmd}` })),
    summary: "",
  };
}
