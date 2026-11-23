// @ts-check
// Fails when a changed function's cognitive complexity ends at 25 or more and the change made it so: a new function
// that complex, or one the change added 10 or more to. The scoring (SonarSource's definition) is in core/complexity.rs.
import { runCore } from "./core.mjs";
import { JS_FILE, NOT_PRODUCT, SKIP, addedLines, matches, parseNameStatus, resolveBase, showMany, workingDiff } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function complexity({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const [status, patch] = workingDiff(cwd, [["--name-status", "-M", "-z", sha], ["-U0", "-M", sha]]);
  const from = new Map(parseNameStatus(status).filter((c) => c.status !== "A").map((c) => [c.path, c.from]));
  const added = [...addedLines(patch)].filter(([path]) => JS_FILE.test(path) && !SKIP.test(path) && !NOT_PRODUCT.test(path) && !matches(path, testPaths));
  if (!added.length) return { findings: [], summary: "no changed code" };
  const before = showMany(cwd, sha, [...new Set(added.flatMap(([path]) => from.get(path) ?? []))]);
  const files = added.map(([path, lines]) => ({ path, lines: [...lines], before: before.get(from.get(path) ?? "") ?? "" }));
  const answer = runCore({ command: "complexity", root: cwd, options: { files } });
  return { findings: answer.findings.map(({ file, line, target, message }) => ({ file, line, target, message })), summary: answer.summary };
}
