// @ts-check
// Fails when code and schema disagree on the values a workflow's column may hold: a value written or tested that the
// column's enum or CHECK does not allow. Suggests, and fails nothing, when one of its rules is written in many places:
// one list of values tested in three or more files, one change of state written in four or more functions. The change
// is judged on the lines it adds; with --all, the whole repository. The work is in core/src/states.rs.

import { fromEngine, runCore } from "./core.mjs";
import { JS_FILE, NOT_PRODUCT, SKIP, changeOf, listFiles, matches } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function states({ cwd, base, testPaths }) {
  const { whole, top, prefix, added } = changeOf(cwd, base);
  if (!whole && !added.size) return { findings: [], summary: "no added lines" };
  // The whole repository is read: a schema package's columns are written and tested by the apps beside it. A test
  // may write a value to see it refused, so tests are left out. A script or a seed is held to the values a column
  // allows, but it is not the product's workflow: only product code counts towards a rule written many times.
  const files = listFiles(top).filter((f) => !SKIP.test(f) && !matches(f, testPaths) && (/\.(?:sql|prisma)$/.test(f) || JS_FILE.test(f)));
  const product = files.filter((f) => JS_FILE.test(f) && !NOT_PRODUCT.test(f));
  const answer = runCore({ command: "states", root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix, options: { product } });
  return { findings: fromEngine(answer.findings, prefix), suggestions: fromEngine(answer.data?.suggestions ?? [], prefix), summary: answer.summary };
}
