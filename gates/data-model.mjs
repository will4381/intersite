// @ts-check
// Fails when the data model the schemas declare has a flaw that gets dearer with every row: a column that names
// another table with no foreign key, one fact kept in two columns, a list of ids in one column, one name with two
// types, an index another already covers, a timestamp without its zone, money in a float, two tables with the same
// columns, an enum no column has. The change is judged on what it adds; with --all, the whole schema. The work is in
// core/src/datamodel.rs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fromEngine, runCore } from "./core.mjs";
import { JS_FILE, SKIP, changeOf, listFiles, matches } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function dataModel({ cwd, base, testPaths }) {
  const { whole, top, prefix, added } = changeOf(cwd, base);
  if (!whole && !added.size) return { findings: [], summary: "no added lines" };
  // The whole repository's schemas are read: a table one package declares is linked to by another's. Code is read
  // only where some package uses Drizzle, whose tables are declared in it.
  const all = listFiles(top).filter((f) => !SKIP.test(f) && !matches(f, testPaths));
  const drizzle = all.filter((f) => /(?:^|\/)package\.json$/.test(f)).some((f) => readText(join(top, f)).includes('"drizzle-orm"'));
  const files = all.filter((f) => /\.(?:sql|prisma)$/.test(f) || (drizzle && JS_FILE.test(f)));
  const answer = runCore({ command: "data-model", root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix });
  return { findings: fromEngine(answer.findings, prefix), summary: answer.summary };
}

/** A file's text, empty when it cannot be read. @param {string} path */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // A package.json git lists and the working tree lacks (deleted, not staged) declares nothing.
    return "";
  }
}
