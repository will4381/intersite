// @ts-check
// Fails when the change adds a leftover file: a backup or versioned copy, a scratch script, a log or dump, or an
// agent's working note. Only files the change added count; anything that existed on base is the project's business.
// The judging (names, and whether a copy's lines are mostly its original's) is in core/hygiene.rs.
import { runCore } from "./core.mjs";
import { changes, git, listFiles, matches, projectSpec, resolveBase } from "./lib.mjs";

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function artifacts({ cwd, base, testPaths, artifacts: extra }) {
  const sha = resolveBase(cwd, base);
  const spec = projectSpec(cwd);
  const added = changes(cwd, sha, spec).filter((c) => c.status === "A" || c.status === "R" || c.status === "C").map((c) => c.path);
  if (!added.length) return { findings: [], summary: "0 added files checked" };
  // Run from the project folder, ls-tree lists only that folder, relative to it.
  const was = git(cwd, ["ls-tree", "-r", "-z", "--name-only", sha]).split("\0").filter(Boolean);
  const now = listFiles(cwd, spec);
  const options = { added, was, now, sha, inTests: added.filter((f) => matches(f, testPaths)), matchesExtra: added.filter((f) => matches(f, extra)) };
  const answer = runCore({ command: "artifacts", root: cwd, options });
  return { findings: answer.findings.map(({ target, message }) => ({ target, message })), summary: answer.summary };
}
