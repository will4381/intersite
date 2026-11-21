// @ts-check
// Fails when the change adds a styling value that is almost, but not exactly, one the project already has: a colour a
// hair off an existing one, a font size or spacing value a pixel off the scale, a literal that is a token's value, a
// value off a scale the project keeps closed, or a new token that duplicates an existing one. The inventory of what
// the project uses is read from the repository itself; nothing is configured.
import { existsSync } from "node:fs";
import { join, posix } from "node:path";

import { runCore } from "./core.mjs";
import { addedLines, listFiles, matches, projectPrefix, resolveBase, topLevel, workingDiff } from "./lib.mjs";

const STYLED = /\.(?:css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|astro|html|swift)$/;
// Not shipped styling: tests, stories, fixtures, mocks, generated and vendored files, minified bundles, and SVG and data
// files (which are not in STYLED at all).
const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__|__mocks__|__fixtures__|fixtures?|mocks?|stories|storybook|e2e|docs?|\.[^/]+)\/|\.min\.|(?:^|\/)seeds?\/|(?:^|[/.-])seeds?\.[cm]?[jt]s$|\.(?:stories|story|fixture|mock)\.|\.d\.ts$|\.config\.[cm]?[jt]s$(?<!tailwind\.config\.[cm]?[jt]s)/;

/**
 * The work (reading values and tokens, scales, colour distances in OKLab, package scoping) is in core/style.rs.
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function styleDrift({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = new Map([...addedLines(patch)].filter(([file]) => STYLED.test(file) && !SKIP.test(file) && !matches(file, testPaths)));
  if (!added.size) return { findings: [], summary: "0 added styling lines checked" };
  // The project's added values against the whole repository, with paths from the repository top so package scoping
  // (an app sees its own tokens, those of packages above it and shared ones) works from a project in a subfolder.
  // Findings are only ever in the project, and are named relative to it again.
  const prefix = projectPrefix(cwd);
  const top = topLevel(cwd);
  const fromTop = (/** @type {string} */ file) => posix.normalize(prefix + file);
  const all = listFiles(cwd).filter((f) => !matches(f, testPaths)).map(fromTop);
  // The folder of each package.json, so one app's tokens and palette are not offered to another.
  const packages = all.filter((f) => posix.basename(f) === "package.json" && existsSync(join(top, f))).map((f) => posix.dirname(f)).map((d) => (d === "." ? "" : d));
  const files = all.filter((f) => STYLED.test(f) && !SKIP.test(f));
  const answer = runCore({ command: "style-drift", root: top, files, added: Object.fromEntries([...added].map(([file, lines]) => [fromTop(file), [...lines]])), options: { packages } });
  const findings = answer.findings.map((f) => ({ target: f.target.slice(prefix.length), message: f.message.slice(prefix.length) }));
  return { findings, summary: answer.summary };
}
