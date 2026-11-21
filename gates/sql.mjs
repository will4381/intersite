// @ts-check
// Fails when the change adds SQL that locks or breaks a live table (a NOT NULL column with no default, an index built
// without CONCURRENTLY, a dropped or renamed column, a foreign key validated under lock or left without an index),
// that scans where it should seek (a leading-wildcard LIKE, OFFSET pagination, a function around an indexed column,
// ORDER BY random()), that returns wrong answers (UPDATE or DELETE with no WHERE, NOT IN a subquery), or that runs a
// query once per loop item. With INTERSITE_DATABASE_URL set, each new query is also planned (never run) against that
// database, and a sequential scan of a large table is reported with the index to add. The work is in core/sql.rs.
import { posix } from "node:path";

import { runCore } from "./core.mjs";
import { EMPTY_TREE, JS_FILE, NOT_PRODUCT, SKIP, addedLines, listFiles, matches, projectPrefix, resolveBase, topLevel, workingDiff } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function sql({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const whole = sha === EMPTY_TREE;
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = new Map([...addedLines(patch)].map(([file, lines]) => [prefix + file, [...lines]]));
  if (!whole && !added.size) return { findings: [], summary: "no added lines" };
  // Every migration is read, for the indexes a new foreign key may already have; code only where it changed.
  const files = listFiles(top).filter((f) => !SKIP.test(f) && !matches(f, testPaths) && (f.endsWith(".sql") || (JS_FILE.test(f) && !NOT_PRODUCT.test(f) && (whole || added.has(f)))));
  const answer = runCore({ command: "sql", root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix, databaseUrl: process.env.INTERSITE_DATABASE_URL ?? "" });
  const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  const findings = answer.findings.map((f) => ({ target: f.target.replace(f.file, name(f.file)), message: f.message.replace(f.file, name(f.file)) }));
  return { findings, summary: answer.summary };
}
