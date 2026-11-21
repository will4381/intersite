// @ts-check
// Fails when a package.json gained a dependency: agents add packages they do not need, and some that do not exist.
// The comparison is in core/hygiene.rs.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { runCore } from "./core.mjs";
import { changes, projectPrefix, resolveBase, show } from "./lib.mjs";

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function newDeps({ cwd, base }) {
  const sha = resolveBase(cwd, base);
  const files = changes(cwd, sha).filter((c) => c.status !== "D" && basename(c.path) === "package.json");
  // A project in a subfolder of a workspace also answers for the workspace root's package.json: its packages are
  // hoisted and installed for every app, so one added there for this app is still a new dependency.
  const rootPath = projectPrefix(cwd).replace(/[^/]+\//g, "../") + "package.json";
  const root = rootPath !== "package.json" && existsSync(join(cwd, rootPath)) ? [{ path: rootPath, from: rootPath }] : [];
  const list = [...files, ...root].map((c) => ({ path: c.path, beforePlace: `${c.from} on ${base}`, before: show(cwd, sha, c.from), now: readFileSync(join(cwd, c.path), "utf8") }));
  const answer = runCore({ command: "new-deps", root: cwd, options: { changes: list } });
  return { findings: answer.findings.map(({ target, message }) => ({ target, message })), summary: `${files.length} changed package.json files checked${root.length ? ", and the workspace root's" : ""}` };
}
