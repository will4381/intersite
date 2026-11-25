// @ts-check
// Fails when the change adds a function, component, hook, class or type that already exists under another name:
// the same structure after local names and literals are replaced by placeholders, so renamed and reformatted copies
// match while code that merely looks alike does not. It also fails when added code holds most of an existing
// function's body (a helper pasted inside a new function instead of called), found with Aroma's structural features.
// Exact pasted blocks are left to the duplicates gate. The work is in core/similar.rs, core/units.rs and core/aroma.rs.
import { fromEngine, runCore } from "./core.mjs";
import { EMPTY_TREE, SKIP, addedLines, listFiles, matches, resolveBase, workingDiff } from "./lib.mjs";

// Never one side of a pair: tests, fixtures and stories, configs, and route files whose shape the framework dictates.
const NOT_SOURCE = /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|(?:[\w-]*[-_])?(?:fixtures?|mocks?|e2e|tests?|testing)|stories|seeds?|migrations)\/|\.(?:test|spec|stories|story|e2e|config)\.[^/]+$|[-_.]fixtures?\.[^/]+$|(?:^|\/)(?:page|layout|loading|error|global-error|not-found|template|default|route|middleware)\.[cm]?[jt]sx?$/;

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function similar({ cwd, base, testPaths, duplicateLines }) {
  const sha = resolveBase(cwd, base);
  // The project's added units against every unit in the repository: the original may be in a shared package.
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = addedLines(patch);
  const files = listFiles(cwd).filter((f) => !SKIP.test(f) && !NOT_SOURCE.test(f) && !matches(f, testPaths));
  const sources = new Set(files);
  if (![...added.keys()].some((f) => sources.has(f))) return { findings: [], summary: "0 added units checked" };
  const answer = runCore({ command: "similar", root: cwd, files, added: Object.fromEntries([...added].map(([f, l]) => [f, [...l]])), options: { lines: duplicateLines, whole: sha === EMPTY_TREE } });
  return { findings: fromEngine(answer.findings), summary: answer.summary };
}
