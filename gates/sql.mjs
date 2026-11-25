// @ts-check
// Fails when the change adds SQL that locks or breaks a live table (a NOT NULL column with no default, an index built
// without CONCURRENTLY, a dropped or renamed column, a foreign key validated under lock or left without an index),
// that scans where it should seek (a leading-wildcard LIKE, OFFSET pagination, a function around an indexed column,
// ORDER BY random()), that stores UUIDs as text or points a foreign key at a column of another type, that returns wrong answers (UPDATE or DELETE with no WHERE, NOT IN a subquery), or that runs a
// query once per loop item. With INTERSITE_DATABASE_URL set, each new query is also planned (never run) against that
// database, and a sequential scan of a large table is reported with the index to add. The work is in core/sql.rs.

import { fromEngine, runCore } from "./core.mjs";
import { JS_FILE, NOT_PRODUCT, SKIP, changeOf, listFiles, matches } from "./lib.mjs";

/** Scripts, CI and deploy files: where a command that empties a database runs unattended (core/sql.rs reads them). */
const DEPLOY = /(?:^|\/)(?:package\.json|Dockerfile[^/]*|[^/]*\.Dockerfile|Makefile|Justfile|justfile|Procfile|vercel\.json|netlify\.toml|fly\.toml|render\.ya?ml|railway\.(?:json|toml)|nixpacks\.toml|\.gitlab-ci\.ya?ml|bitbucket-pipelines\.ya?ml|[^/]*\.sh)$|(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function sql({ cwd, base, testPaths }) {
  const { whole, top, prefix, added } = changeOf(cwd, base);
  if (!whole && !added.size) return { findings: [], summary: "no added lines" };
  // Every migration is read, for the indexes a new foreign key may already have; code only where it changed.
  // Scripts, CI and deploy files are read where they changed, for commands that empty a database.
  const files = listFiles(top).filter((f) => !SKIP.test(f) && !matches(f, testPaths) && (/\.(?:sql|prisma)$/.test(f) || ((JS_FILE.test(f) && !NOT_PRODUCT.test(f)) || DEPLOY.test(f)) && (whole || added.has(f))));
  const answer = runCore({ command: "sql", root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix, databaseUrl: process.env.INTERSITE_DATABASE_URL ?? "" });
  const findings = fromEngine(answer.findings, prefix);
  return { findings, summary: answer.summary };
}
