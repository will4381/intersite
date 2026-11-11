// @ts-check
// Fails when a package.json gained a dependency: agents add packages they do not need, and some that do not exist.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { GateError, changes, projectPrefix, resolveBase, show } from "./lib.mjs";

/**
 * Every dependency name in any `*dependencies` section.
 * @param {string} text
 * @param {string} where
 */
function names(text, where) {
  if (!text) return new Set();
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    throw new GateError(`${where} is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  const sections = Object.entries(pkg).filter(([key, value]) => /dependencies$/i.test(key) && value && typeof value === "object" && !Array.isArray(value));
  return new Set(sections.flatMap(([, deps]) => Object.keys(deps)));
}

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
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  for (const change of [...files, ...root]) {
    const was = names(show(cwd, sha, change.from), `${change.from} on ${base}`);
    for (const name of names(readFileSync(join(cwd, change.path), "utf8"), change.path)) {
      if (!was.has(name)) {
        findings.push({ target: name, message: `${change.path}: new dependency "${name}": check it exists and is needed, or use what is already installed` });
      }
    }
  }
  return { findings, summary: `${files.length} changed package.json files checked${root.length ? ", and the workspace root's" : ""}` };
}
