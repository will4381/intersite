// @ts-check
// Fails when the change adds a credential to any text file (a key with a recognisable format, a database URL with
// its password, a Supabase service-role JWT), commits an env file holding real secret values, or adds a private key
// file. Tests and fixtures hold realistic fakes on purpose and are left out. The work is in core/secrets.rs.
import { posix } from "node:path";

import { runCore } from "./core.mjs";
import { changeOf, listFiles, matches, patchPath, projectSpec } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function secrets({ cwd, base, testPaths }) {
  const { whole, top, prefix, added, patch } = changeOf(cwd, base);
  const files = whole ? listFiles(cwd, projectSpec(cwd)).map((f) => prefix + f) : [...added.keys()];
  // A binary key file has no added lines, only `Binary files /dev/null and b/<path> differ`.
  const binary = [...patch.matchAll(/^Binary files \/dev\/null and (.+) differ$/gm)].map((m) => prefix + patchPath(`+++ ${m[1]}`));
  const all = [...new Set([...files, ...binary])];
  const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  const fakes = all.filter((f) => matches(name(f), testPaths));
  const answer = runCore({ command: "secrets", root: top, files: all, added: whole ? undefined : Object.fromEntries(added), prefix, options: { fresh: whole ? all : binary, fakes } });
  return { findings: answer.findings.map((f) => ({ target: f.target.replace(f.file, name(f.file)), message: f.message.replaceAll(f.file, name(f.file)) })), summary: answer.summary };
}
