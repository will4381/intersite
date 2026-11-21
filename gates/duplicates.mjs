// @ts-check
// Fails when an added block of source already exists elsewhere in the repository: pasted code that should be reused.
// Only the project's own change is judged, but against the whole repository, since a copy of a shared package's code
// is the case that matters most; the original is named relative to the project (`../../packages/ui/x.ts`).
import { runCore } from "./core.mjs";
import { EMPTY_TREE, WORK_TREE, addedLines, git, matches, resolveBase, workingDiff } from "./lib.mjs";

const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|scala|sh|sql|css|scss)$/;
const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__)\/|\.min\.|\.d\.ts$|\.generated\./;

/**
 * The work (hashing every window of lines, matching the added ones) is in core/dup.rs.
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function duplicates({ cwd, base, testPaths, duplicateLines: n }) {
  const sha = resolveBase(cwd, base);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = addedLines(patch);
  const tracked = git(cwd, ["ls-files", "-z", "--", ...WORK_TREE]).split("\0").filter((f) => CODE.test(f) && !SKIP.test(f));
  // Asked for the whole repository (`--all`), every line is new: the first place a block appears is its original,
  // and each later copy is reported.
  const changed = [...added.keys()].filter((f) => CODE.test(f) && !SKIP.test(f) && !matches(f, testPaths));
  const answer = runCore({
    command: "duplicates", root: cwd, files: tracked, added: Object.fromEntries([...added].map(([f, l]) => [f, [...l]])),
    options: { lines: n, changed, whole: base === EMPTY_TREE },
  });
  return { findings: answer.findings.map(({ target, message }) => ({ target, message })), summary: answer.summary };
}
