// @ts-check
// Fails when a changed function's cognitive complexity ends at 25 or more and the change made it so: a new function
// that complex, or one the change added 10 or more to. A moved or renamed function is judged against its old self.
// The scoring (SonarSource's definition) is in core/complexity.rs.
import { runCore } from "./core.mjs";
import { JS_FILE, NOT_PRODUCT, SKIP, addedLines, matches, parseNameStatus, resolveBase, showMany, workingDiff } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function complexity({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const [status, patch] = workingDiff(cwd, [["--name-status", "-M", "-z", sha], ["-U0", "-M", sha]]);
  const changes = parseNameStatus(status).filter((c) => c.status !== "A");
  const from = new Map(changes.map((c) => [c.path, c.from]));
  const added = [...addedLines(patch)].filter(([path]) => JS_FILE.test(path) && !SKIP.test(path) && !NOT_PRODUCT.test(path) && !matches(path, testPaths));
  if (!added.length) return { findings: [], summary: "no changed code" };
  // Every file the change touched, as it was: a function moved to another file, or out of one git does not pair
  // as a rename, is found there and judged against its old self instead of as new.
  const touched = [...showMany(cwd, sha, [...new Set(changes.map((c) => c.from).filter((path) => JS_FILE.test(path)))])].map(([path, text]) => ({ path, text }));
  const files = added.map(([path, lines]) => ({ path, lines: [...lines], from: from.get(path) ?? "" }));
  const answer = runCore({ command: "complexity", root: cwd, options: { files, base: touched } });
  return { findings: answer.findings.map(({ file, line, target, message }) => ({ file, line, target, message })), summary: answer.summary };
}
