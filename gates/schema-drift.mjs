// @ts-check
// Fails when the change adds an interface or object type whose keys are exactly those of a schema the project already
// has (zod, valibot, yup, TypeBox, or a Drizzle table), or adds such a schema beside an existing hand-written type:
// two definitions of one shape that drift the first time one changes. The type should be derived from the schema.
// The work is in core/schemas.rs.

import { fromEngine, runCore } from "./core.mjs";
import { SKIP, changeOf, listFiles, matches } from "./lib.mjs";

const TS_FILE = /\.[cm]?tsx?$/;

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function schemaDrift({ cwd, base, testPaths }) {
  const { whole, top, prefix, added } = changeOf(cwd, base);
  if (!whole && ![...added.keys()].some((f) => TS_FILE.test(f))) return { findings: [], summary: "no added TypeScript" };
  const files = listFiles(top).filter((f) => TS_FILE.test(f) && !SKIP.test(f) && !/\.d\.[cm]?ts$/.test(f) && !matches(f, testPaths));
  const answer = runCore({ command: "schema-drift", root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix });
  return { findings: fromEngine(answer.findings, prefix), summary: answer.summary };
}
