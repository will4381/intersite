// @ts-check
// Fails when the change leaves code nothing uses: an added file nothing references, an added export nothing uses, or
// a file whose last import the change removed. Text only: a file is referenced when another file names its stem.
// Only the project's files are judged, but a mention anywhere in the repository counts as a use: a sibling package may
// import them.
import { statSync } from "node:fs";
import { join } from "node:path";

import { located, runCore } from "./core.mjs";
import { listFiles, matches, parseNameStatus, patchPath, resolveBase, workingDiff } from "./lib.mjs";

// The work (package entries, reference scan, export use counts, lost imports) is in core/unused.rs.
/**
 * Added and removed lines of a `-U0` patch: added by new path and line number, removed by old path.
 * @param {string} patch
 */
function patchLines(patch) {
  /** @type {Map<string, string[]>} */ const added = new Map();
  /** @type {Map<string, string[]>} */ const removed = new Map();
  let header = false;
  /** @type {string[] | undefined} */ let plus;
  /** @type {string[] | undefined} */ let minus;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) header = true;
    else if (line.startsWith("@@")) header = false;
    else if (header && line.startsWith("--- ")) minus = line === "--- /dev/null" ? undefined : removed.set(patchPath(line), []).get(patchPath(line));
    else if (header && line.startsWith("+++ ")) plus = line === "+++ /dev/null" ? undefined : added.set(patchPath(line), []).get(patchPath(line));
    else if (!header && line.startsWith("+")) plus?.push(line.slice(1));
    else if (!header && line.startsWith("-")) minus?.push(line.slice(1));
  }
  return { added, removed };
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function unused({ cwd, base, testPaths, entryPaths }) {
  const sha = resolveBase(cwd, base);
  const [status, patch] = workingDiff(cwd, [["--name-status", "-M", "-z", sha], ["-U0", "-M", sha]]);
  const changed = parseNameStatus(status);
  const { added, removed } = patchLines(patch);
  const all = listFiles(cwd).filter((f) => statSync(join(cwd, f), { throwIfNoEntry: false })?.isFile());
  // Globs are matched here, with Node's own matcher, so test and entry paths mean exactly what the config says.
  const conventionalByGlob = [...new Set([...all, ...added.keys()])].filter((f) => matches(f, testPaths) || matches(f, entryPaths));
  const fresh = changed.filter((c) => c.status === "A").map((c) => c.path);
  const answer = runCore({ command: "unused", root: cwd, files: all, options: { fresh, addedLines: [...added], removedLines: [...removed], conventionalByGlob } });
  return { findings: answer.findings.map((f) => ({ ...located(f), target: f.target, message: f.message })), summary: answer.summary };
}
