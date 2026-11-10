// @ts-check
// Proves a change's new tests fail without it: run them against the base commit in a temporary worktree.
import { GateError, changes, matches, resolveBase, sh, withWorktree } from "./lib.mjs";

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function failsOnBase({ cwd, base, testCmd, testPaths, setup }) {
  if (!testCmd) throw new GateError('needs a test command: pass --cmd "<command>" or set "gates.testCmd" in intersite.yml');
  const sha = resolveBase(cwd, base);
  const files = changes(cwd, sha)
    .filter((c) => c.status !== "D" && matches(c.path, testPaths))
    .map((c) => c.path);
  if (!files.length) throw new GateError(`no file changed since ${base} matches ${testPaths.join(", ")}`);

  const overlay = files.map((path) => ({ path, deleted: false }));
  const { code } = await withWorktree({ cwd, ref: sha, setup, overlay }, (dir) => sh(testCmd, dir));
  if (code !== 0) return { findings: [], summary: `${testCmd} fails on ${base} (exit ${code}), as a test of the change should` };
  return {
    findings: files.map((file) => ({ target: file, message: `${file} passes on ${base} without the change, so it does not test it; rerun: ${testCmd}` })),
    summary: "",
  };
}
