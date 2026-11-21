// @ts-check
// Fails when the change adds a regular expression whose backtracking explodes on a crafted input (ReDoS: a repeat
// inside a repeat over the same characters, overlapping alternatives in a repeat, or two adjacent repeats over the
// same characters), or a validation pattern (email, phone, URL, slug…) that another file writes differently, so the
// frontend and backend disagree on what is valid. The work is in core/regex.rs.
import { posix } from "node:path";

import { runCore } from "./core.mjs";
import { EMPTY_TREE, JS_FILE, NOT_PRODUCT, SKIP, addedLines, listFiles, matches, projectPrefix, resolveBase, topLevel, workingDiff } from "./lib.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function regex({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const whole = sha === EMPTY_TREE;
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = new Map([...addedLines(patch)].map(([file, lines]) => [prefix + file, [...lines]]));
  if (!whole && ![...added.keys()].some((f) => JS_FILE.test(f))) return { findings: [], summary: "no added code" };
  // Every file is read: a pattern is compared with the patterns of the same name anywhere in the repository.
  const files = listFiles(top).filter((f) => JS_FILE.test(f) && !SKIP.test(f) && !NOT_PRODUCT.test(f) && !matches(f, testPaths));
  const answer = runCore({ command: "regex", root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix });
  const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  const findings = answer.findings.map((f) => ({ target: f.target.replace(f.file, name(f.file)), message: f.message.replaceAll(f.file, name(f.file)) }));
  return { findings, summary: answer.summary };
}
