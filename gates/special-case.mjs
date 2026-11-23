// @ts-check
// Fails when added production code answers the tests instead of solving the problem: it branches on running under a
// test runner, or returns a changed test's expected value when given that test's own input. The work is in
// core/special.rs.
import { posix } from "node:path";

import { runCore } from "./core.mjs";
import { NOT_PRODUCT, SKIP, changeOf, matches } from "./lib.mjs";

const CODE = /\.(?:[cm]?[jt]sx?|swift)$/;
/** Configuration and test bootstrapping, where reading the environment is the point. */
const SETUP = /(?:^|\/)[^/]*(?:setup|teardown|\.config|config\.)[^/]*$|(?:^|\/)(?:test-utils|testing|testutils)\//i;

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function specialCase({ cwd, base, testPaths }) {
  const { top, prefix, added } = changeOf(cwd, base);
  const inProject = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  const code = [...added.keys()].filter((f) => CODE.test(f) && !SKIP.test(f) && !inProject(f).startsWith("../"));
  // Swift test targets are folders named …Tests; JavaScript tests follow gates.testPaths.
  const isTest = (/** @type {string} */ f) => matches(inProject(f), testPaths) || /(?:^|\/)[^/]*Tests?\/|Tests?\.swift$/.test(f);
  const tests = code.filter(isTest);
  const production = code.filter((f) => !isTest(f) && !NOT_PRODUCT.test(f) && !SETUP.test(f));
  if (!production.length) return { findings: [], summary: "no added production code" };
  const answer = runCore({ command: "special-case", root: top, files: production, added: Object.fromEntries(added), prefix, options: { tests, production } });
  return { findings: answer.findings.map(({ target, message }) => ({ target, message })), summary: answer.summary };
}
