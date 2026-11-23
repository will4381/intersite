// @ts-check
// Fails when the product says one number and the code another: copy, docs or a comment that states a fee, rate or
// price ("1.5% + $0.30 per payment") that the constant with the same name in code does not hold, or one money rate
// defined twice with different values. The whole repository is read, so copy in one app is checked against a constant
// in a shared package; findings are the project's own, named relative to it. The work is in core/drift.rs.
import { posix } from "node:path";

import { located, runCore } from "./core.mjs";
import { JS_FILE, NOT_PRODUCT, SKIP, changeOf, listFiles, matches } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function valueDrift({ cwd, base, testPaths }) {
  const change = changeOf(cwd, base);
  const { top, prefix } = change;
  const added = change.whole ? undefined : Object.fromEntries(change.added);
  const files = listFiles(top).filter((f) => JS_FILE.test(f) && !SKIP.test(f) && !NOT_PRODUCT.test(f) && !matches(f, testPaths));
  const answer = runCore({ command: "value-drift", root: top, files, added, prefix });
  const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  return { findings: answer.findings.map((f) => ({ ...located(f, name), target: f.target, message: f.message })), summary: answer.summary };
}
