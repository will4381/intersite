// @ts-check
// Fails when a test file was deleted, lost tests or assertions, or gained a skip: the cheapest ways to get green.
// The counting (code with strings and comments blanked, then calls to it/test, expect/assert, skip/todo) is in
// core/hygiene.rs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fromEngine, runCore } from "./core.mjs";
import { EMPTY_TREE, baseName, changes, matches, resolveBase, showMany } from "./lib.mjs";

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function testIntegrity({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const since = sha === EMPTY_TREE ? "an empty repository" : baseName(cwd, base);
  const files = changes(cwd, sha).filter((c) => matches(c.from, testPaths) || matches(c.path, testPaths));
  const before = showMany(cwd, sha, files.filter((c) => c.status !== "A" && c.status !== "D" && matches(c.from, testPaths)).map((c) => c.from));
  const list = files.map((c) => ({
    path: c.path,
    status: c.status,
    before: c.status === "A" || !matches(c.from, testPaths) ? "" : before.get(c.from) ?? "",
    // A test file moved to a path that is no longer a test path has, as far as the suite knows, no tests left.
    now: c.status === "D" || !matches(c.path, testPaths) ? "" : readFileSync(join(cwd, c.path), "utf8"),
  }));
  const answer = runCore({ command: "test-integrity", root: cwd, options: { changes: list, since } });
  return { findings: fromEngine(answer.findings), summary: answer.summary };
}
