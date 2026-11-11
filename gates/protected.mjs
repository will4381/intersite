// @ts-check
// Fails when a change touches paths the project marked as protected without also changing what must change with
// them (by default a test): money and access code that nobody should edit without proving it still works.
import { GateError, changes, matches, resolveBase } from "./lib.mjs";

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function protectedPaths({ cwd, base, testPaths, protected: rules }) {
  const changed = changes(cwd, resolveBase(cwd, base));
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  for (const rule of rules) {
    if (!Array.isArray(rule?.paths) || !rule.paths.length) throw new GateError('each entry of "gates.protected" needs `paths`, a list of globs');
    const needs = rule.needs ?? testPaths;
    const touched = changed.filter((c) => matches(c.path, rule.paths) || matches(c.from, rule.paths));
    if (!touched.length || changed.some((c) => c.status !== "D" && matches(c.path, needs))) continue;
    const more = touched.length > 1 ? ` and ${touched.length - 1} more protected files` : "";
    findings.push({
      target: rule.paths.join(","),
      message: `${touched[0].path}${more} changed with no change under ${needs.join(", ")}${rule.why ? `: ${rule.why}` : ""}`,
    });
  }
  return { findings, summary: `${rules.length} protected path rules checked against ${changed.length} changed files` };
}
