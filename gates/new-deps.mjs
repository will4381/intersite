// @ts-check
// Fails when a package.json gained a dependency: agents add packages they do not need, and some that do not exist.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { GateError, changes, resolveBase, show, topLevel } from "./lib.mjs";

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
  const top = topLevel(cwd);
  const files = changes(cwd, sha).filter((c) => c.status !== "D" && basename(c.path) === "package.json");
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  for (const change of files) {
    const was = names(show(cwd, sha, change.from), `${change.from} on ${base}`);
    for (const name of names(readFileSync(join(top, change.path), "utf8"), change.path)) {
      if (!was.has(name)) {
        findings.push({ target: name, message: `${change.path}: new dependency "${name}": check it exists and is needed, or use what is already installed` });
      }
    }
  }
  return { findings, summary: `${files.length} changed package.json files checked` };
}
