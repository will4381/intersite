// @ts-check
// Fails when the change weakens what judges the code instead of fixing the code: strict type options turned off, lint
// rules downgraded or paths ignored, gates or packs dropped, a baseline grown, a test runner told to skip files, pass
// with no tests, retry or accept lower coverage, a CI step that ran the checks removed or allowed to fail, coverage
// pragmas or `process.exit(0)` in a test file. The judging is in core/tamper.rs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defaults, loadConfig } from "../shared/config.mjs";
import { runCore } from "./core.mjs";
import { changes, resolveBase, showMany } from "./lib.mjs";

/** Files that hold an evaluator's settings; core/tamper.rs decides exactly what each one is. */
export const EVALUATOR = /(?:^|\/)(?:[jt]sconfig[\w.-]*\.json|\.?oxlintrc[\w.-]*|eslint\.config\.[cm]?[jt]s|\.eslintrc[\w.]*|biome\.jsonc?|\.swiftlint\.ya?ml|intersite\.(?:ya?ml|json)|(?:vitest|vite|jest|playwright|stryker)\.(?:config|workspace|conf)\.[\w.]+|package\.json)$|(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
/** Source that may carry a coverage pragma or end a test run early. */
export const PRAGMA = /(?:istanbul|c8|v8|node:coverage)\s+(?:ignore|disable)|process\.exit\(/;
const SOURCE = /\.(?:[cm]?[jt]sx?|swift)$/;

/**
 * What core/tamper.rs needs besides the files: the defaults to compare a config against when it leaves a list out,
 * and the baseline files the config names.
 * @param {import("../shared/config.mjs").Config} config
 */
export const tamperContext = (config) => ({
  defaults: { run: defaults.gates.run, packs: defaults.lint.packs, testPaths: defaults.gates.testPaths },
  baselines: [config.lint.baseline, config.gates.baseline],
});

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function tamper({ cwd, base }) {
  const config = loadConfig(cwd);
  const context = tamperContext(config);
  const sha = resolveBase(cwd, base);
  const now = (/** @type {string} */ path) => (existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), "utf8") : undefined);
  const list = changes(cwd, sha).filter((c) => (c.status !== "A" && (EVALUATOR.test(c.from) || context.baselines.includes(c.from))) || (SOURCE.test(c.path) && c.status !== "D" && PRAGMA.test(now(c.path) ?? "")));
  const before = showMany(cwd, sha, list.map((c) => c.from));
  const answer = runCore({ command: "tamper", root: cwd, options: { context, changes: list.map((c) => ({ path: c.path, before: before.get(c.from) ?? "", now: c.status === "D" ? null : now(c.path) ?? null })) } });
  return { findings: answer.findings.map(({ target, message }) => ({ target, message })), summary: answer.summary };
}
