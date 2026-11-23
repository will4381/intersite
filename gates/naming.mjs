// @ts-check
// Fails when a file or folder the change adds breaks a naming convention its siblings already keep: casing, a shared
// suffix (`*.service.ts`), the test-name pattern, or file names that match their main export. Nothing is configured:
// a convention is whatever a clear majority of enough siblings already do, measured per folder and per kind of file.
// Siblings are the project's own files on disk: another package of a monorepo keeps its own conventions. The work is
// in core/naming.rs.
import { posix } from "node:path";

import { located, runCore } from "./core.mjs";
import { changes, listFiles, matches, projectSpec, resolveBase } from "./lib.mjs";

const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__|migrations|drizzle|Pods|DerivedData)\/|\.min\.|\.d\.[cm]?ts$/;

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function naming({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const spec = projectSpec(cwd);
  const added = changes(cwd, sha, spec).filter((c) => (c.status === "A" || (c.status === "R" && posix.basename(c.from) !== posix.basename(c.path))) && !SKIP.test(c.path)).map((c) => c.path);
  if (!added.length) return { findings: [], summary: "0 added files checked" };
  const files = listFiles(cwd, spec);
  const tests = added.filter((f) => matches(f, testPaths));
  const answer = runCore({ command: "naming", root: cwd, files, options: { added, tests } });
  return { findings: answer.findings.map((f) => ({ ...located(f), target: f.target, message: f.message })), summary: answer.summary };
}
