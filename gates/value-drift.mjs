// @ts-check
// Fails when the product says one number and the code another: copy, docs or a comment that states a fee, rate or
// price ("1.5% + $0.30 per payment") that the constant with the same name in code does not hold, or one money rate
// defined twice with different values. The whole repository is read, so copy in one app is checked against a constant
// in a shared package; findings are the project's own, named relative to it. The work is in core/drift.rs.
import { runCore } from "./core.mjs";
import { EMPTY_TREE, JS_FILE, NOT_PRODUCT, SKIP, addedLines, listFiles, matches, projectPrefix, resolveBase, topLevel, workingDiff } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function valueDrift({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = sha === EMPTY_TREE ? undefined : Object.fromEntries([...addedLines(patch)].map(([file, lines]) => [prefix + file, [...lines]]));
  const files = listFiles(top).filter((f) => JS_FILE.test(f) && !SKIP.test(f) && !NOT_PRODUCT.test(f) && !matches(f, testPaths));
  const answer = runCore({ command: "value-drift", root: top, files, added, prefix });
  return { findings: answer.findings.map(({ target, message }) => ({ target, message })), summary: answer.summary };
}
