// @ts-check
// Fails when a package.json gained a dependency: agents add packages they do not need, and some that do not exist.
// Each new npm package is looked up in the registry, so an invented name is named as one. The comparison and the
// lookups are in core/hygiene.rs and core/registry.rs.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { runCore } from "./core.mjs";
import { changes, projectPrefix, resolveBase, show, topLevel } from "./lib.mjs";

const NPM = "https://registry.npmjs.org";

/**
 * The registry new packages are looked up in, and the scopes a private registry serves (never asked about), from
 * `.npmrc` in the project, the repository top and the home folder. `INTERSITE_OFFLINE=1` asks nothing.
 * @param {string} cwd
 */
function registryOf(cwd) {
  /** @type {string[]} */ const privateScopes = [];
  let registry = process.env.INTERSITE_NPM_REGISTRY || "";
  for (const dir of [cwd, topLevel(cwd), homedir()]) {
    const path = join(dir, ".npmrc");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const scoped = /^\s*(@[^:\s]+):registry\s*=/.exec(line);
      if (scoped) privateScopes.push(scoped[1]);
      const own = /^\s*registry\s*=\s*(\S+)/.exec(line);
      if (own && !registry) registry = own[1];
    }
  }
  return { registry: process.env.INTERSITE_OFFLINE === "1" ? "" : registry || NPM, privateScopes };
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
  const list = [...files, ...root].map((c) => ({ path: c.path, beforePlace: `${c.from} on ${base}`, before: show(cwd, sha, c.from), now: readFileSync(join(cwd, c.path), "utf8") }));
  const answer = runCore({ command: "new-deps", root: cwd, options: { changes: list, ...registryOf(cwd) } });
  const checked = `${files.length} changed package.json files checked${root.length ? ", and the workspace root's" : ""}`;
  return { findings: answer.findings.map(({ target, message }) => ({ target, message })), summary: answer.summary ? `${checked}; ${answer.summary}` : checked };
}
