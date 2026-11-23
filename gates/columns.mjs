// @ts-check
// Fails when the database the migrations and schemas declare and the code that uses it disagree: the change adds a
// column nothing writes (it stays NULL) or a table nothing uses, names a table or column the schema does not have
// (raw SQL, Supabase, Prisma and Drizzle keys), or removes the last write of a column. With --all, every nullable
// column nothing writes and every table nothing uses. The work is in core/columns.rs.
import { posix } from "node:path";

import { runCore } from "./core.mjs";
import { JS_FILE, SKIP, changeOf, changes, listFiles, matches, showMany } from "./lib.mjs";

/** Sources in other languages: a table they name may be written there, so it is never reported as unwritten. */
const OTHER = /\.(?:py|go|rb|swift|kt|kts|java|php|cs|ex|exs|dart|rs|scala)$/;

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function columns({ cwd, base, testPaths }) {
  const { whole, top, prefix, added, sha } = changeOf(cwd, base);
  if (!whole && !added.size) return { findings: [], summary: "no added lines" };
  // The whole repository is read for uses: a schema package's tables are written by the apps beside it.
  const files = listFiles(top).filter((f) => !SKIP.test(f) && !matches(f, testPaths) && (/\.(?:sql|prisma)$/.test(f) || JS_FILE.test(f) || OTHER.test(f)));
  // The code files as they were on the base, to see a write the change removed (a file with only deletions has no
  // added lines, so the changed paths come from the diff itself).
  const edited = whole ? [] : changes(cwd, sha).filter((c) => c.status !== "A" && JS_FILE.test(c.from) && !matches(c.from, testPaths)).map((c) => prefix + c.from);
  const before = Object.fromEntries([...showMany(top, sha, edited)].filter(([, text]) => text));
  const answer = runCore({ command: "columns", root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix, options: { before } });
  const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  const findings = answer.findings.map((f) => ({ target: f.target.replace(f.file, name(f.file)), message: f.message.replace(f.file, name(f.file)) }));
  return { findings, summary: answer.summary };
}
