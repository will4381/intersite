// @ts-check
// Fails when the change renames an identifier everywhere in code but leaves its old name in strings, comments and
// docs, where the compiler does not look: a log line, an error message, an API doc or a config key that now names
// nothing. The work is in core/renames.rs.
import { posix } from "node:path";

import { runCore } from "./core.mjs";
import { EMPTY_TREE, SKIP, listFiles, projectPrefix, resolveBase, topLevel, workingDiff } from "./lib.mjs";

/** Files that hold code or prose a reader acts on. */
const TEXT = /\.(?:[cm]?[jt]sx?|mdx?|txt|ya?ml|json|html?|toml|vue|svelte|astro|sql|graphql|gql)$/;

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function renames({ cwd, base }) {
  const sha = resolveBase(cwd, base);
  if (sha === EMPTY_TREE) return { findings: [], summary: "no base to compare names with" };
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  if (!patch.trim()) return { findings: [], summary: "no changes" };
  const files = listFiles(top).filter((f) => TEXT.test(f) && !SKIP.test(f));
  const answer = runCore({ command: "renames", root: top, files, prefix, options: { patch } });
  const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  return { findings: answer.findings.map((f) => ({ target: f.target, message: f.message.replace(f.file, name(f.file)) })), summary: answer.summary };
}
