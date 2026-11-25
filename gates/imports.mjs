// @ts-check
// Fails when an import names something that is not there: a file that does not exist (or only under another case),
// a name its module does not export, or a package no package.json declares and nothing installed provides. Lines the
// change added are judged, and so are unchanged imports the change broke by deleting, moving or un-exporting what
// they named. Every JavaScript and TypeScript file of the repository is read and resolved once, in core/graph.rs.
import { spawnSync } from "node:child_process";

import { fromEngine, runCore } from "./core.mjs";
import { EMPTY_TREE, JS_FILE, addedLines, listFiles, parseNameStatus, projectPrefix, resolveBase, showMany, topLevel, withStdin, workingDiff } from "./lib.mjs";

/** Files that change how imports resolve: a change to one alone can break an import. */
const RESOLUTION = /(?:^|\/)(?:package\.json|(?:ts|js)config[\w.-]*\.json)$/;

/**
 * Runs a gate judged on the import graph: the change read once (added lines, deleted and moved files, the base text
 * of each modified code file), every repository file listed for the engine to parse and resolve.
 * @param {string} command @param {import("./lib.mjs").GateOptions} gate @param {Record<string, unknown>} [options]
 * @returns {import("./lib.mjs").GateResult}
 */
export function graphGate(command, { cwd, base }, options = {}) {
  const sha = resolveBase(cwd, base);
  const whole = sha === EMPTY_TREE;
  const prefix = projectPrefix(cwd);
  const [patch, status] = workingDiff(cwd, [["-U0", "-M", sha], ["--name-status", "-M", "-z", sha]]);
  const list = parseNameStatus(status);
  if (!whole && !list.some((c) => JS_FILE.test(c.path) || JS_FILE.test(c.from) || RESOLUTION.test(c.path))) return { findings: [], summary: "no changed code" };
  const top = topLevel(cwd);
  const added = Object.fromEntries([...addedLines(patch)].map(([file, lines]) => [prefix + file, [...lines]]));
  const gone = list.filter((c) => c.status === "D" || c.status === "R").map((c) => prefix + c.from);
  const modified = list.filter((c) => (c.status === "M" || c.status === "R") && JS_FILE.test(c.path));
  const before = showMany(cwd, sha, modified.map((c) => c.from));
  const baseTexts = Object.fromEntries(modified.map((c) => [prefix + c.path, before.get(c.from) ?? ""]));
  const answer = runCore({
    command,
    root: top,
    files: listFiles(top),
    added: whole ? undefined : added,
    prefix,
    options: { changed: list.filter((c) => c.status !== "D").map((c) => prefix + c.path), fresh: list.filter((c) => c.status === "A").map((c) => prefix + c.path), gone, base: baseTexts, ...options },
  });
  // A missing file that git ignores is one a build writes (generated types, a codegen client): fine until it runs.
  const ignorable = /** @type {Record<string, string>} */ (answer.data?.ignorable ?? {});
  const paths = [...new Set(Object.values(ignorable))];
  const ignored = new Set();
  if (paths.length) {
    const run = withStdin(paths.flatMap((p) => [p, ...CODE_SUFFIXES.map((s) => p + s)]).join("\n") + "\n", (fd) => spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: top, stdio: [fd, "pipe", "pipe"], encoding: "utf8" }));
    for (const line of run.stdout.split("\n")) if (line) ignored.add(line.replace(/\.[cm]?[jt]sx?$|\/index\.[cm]?[jt]sx?$/, ""));
  }
  const findings = answer.findings.filter((f) => !ignored.has(ignorable[f.target]?.replace(/\.[cm]?[jt]sx?$/, ""))).map((f) => fromEngine([f], prefix)[0]);
  return { findings, summary: answer.summary };
}

/** Ways a build may name a generated module, for asking git whether it ignores it. */
const CODE_SUFFIXES = [".ts", ".tsx", ".js", ".d.ts", "/index.ts", "/index.js"];

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function imports(options) {
  return graphGate("imports", options);
}
