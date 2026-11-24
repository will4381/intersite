// @ts-check
// Fails when a small deliberate break in changed code leaves the tests passing: coverage without checking. After
// Google's mutation testing in code review: a changed function's body removed, then one mutant per changed line (an
// access check, tenant filter, idempotency or state guard or cache invalidation removed before an operator flip),
// never in logging or error text. The mutants are chosen in core/hygiene.rs; this runs the tests against each. A run
// that fails only because the mutant does not compile or load is an invalid mutant, not a killed one (core/outcome.rs).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCore } from "./core.mjs";
import { outcomeOf } from "./fails-on-base.mjs";
import { GateError, WORK_TREE, addedLines, matches, parseNameStatus, resolveBase, sh, topLevel, withWorktree, workingDiff } from "./lib.mjs";

const SOURCE = /\.(?:[cm]?js|tsx?|jsx)$/;
/** @typedef {{ kind: "body" | "operator" | "cut", label?: string, path: string, line: number, at: number, length: number, from: string, to: string, name?: string, text?: string, key?: string, within: string[] }} Mutant */

/**
 * Applies one mutant in the worktree, runs the tests and puts the file back. A timeout counts as killed: the mutant
 * changed behaviour enough to hang the tests.
 * @param {Mutant} m @param {string} dir @param {string} testCmd @param {number} timeout
 * @returns {Promise<"pass" | "fail" | "compile" | "setup" | "timeout">}
 */
async function runMutant(m, dir, testCmd, timeout) {
  const file = join(dir, m.path);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.slice(0, m.at) + m.to + original.slice(m.at + m.length));
  try {
    const run = await sh(testCmd, dir, { timeout, output: "keep" });
    return run.code === 0 ? "pass" : run.timedOut ? "timeout" : outcomeOf(run).kind;
  } finally {
    writeFileSync(file, original);
  }
}

/**
 * Runs the tests against each mutant in turn. Once a function's removed body survives, nothing inside it is tried, and
 * a file with `PER_FILE` survivors is not mutated further.
 * @param {Mutant[]} chosen @param {string} dir @param {string} testCmd @param {number} timeout
 */
async function tryAll(chosen, dir, testCmd, timeout) {
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  /** Functions whose removed body went unnoticed: flipping an operator inside them would only say so again. */
  const unchecked = new Set();
  /** @type {Map<string, number>} */
  const survivors = new Map();
  let tried = 0;
  /** Mutants that broke the build or the run instead of the behaviour: no evidence either way. */
  let invalid = 0;
  /** @type {Map<string, [number, number]>} per semantic label: killed, tried */
  const byLabel = new Map();
  for (const m of chosen) {
    if (m.within.some((key) => unchecked.has(key)) || (survivors.get(m.path) ?? 0) >= PER_FILE) continue;
    tried++;
    const kind = await runMutant(m, dir, testCmd, timeout);
    if (kind === "compile" || kind === "setup") {
      invalid++;
      continue;
    }
    if (m.label) {
      const [k, t] = byLabel.get(m.label) ?? [0, 0];
      byLabel.set(m.label, [k + (kind === "pass" ? 0 : 1), t + 1]);
    }
    if (kind !== "pass") continue;
    survivors.set(m.path, (survivors.get(m.path) ?? 0) + 1);
    if (m.kind === "body") unchecked.add(m.key);
    findings.push(survivor(m));
  }
  return { findings, tried, invalid, byLabel };
}

/** The finding for a mutant no test noticed. @param {Mutant} m @returns {import("./lib.mjs").Finding} */
function survivor(m) {
  const task = "write a test that fails on this mutant and passes on the real code";
  if (m.kind === "body") return { file: m.path, line: m.line, target: `${m.path}:${m.name}`, message: `${m.path}:${m.line} no test notices when ${m.name}'s body is removed: ${task}` };
  if (m.kind === "operator") return { file: m.path, line: m.line, target: `${m.path}:${m.line}`, message: `${m.path}:${m.line} no test fails when '${m.from}' becomes '${m.to}' (\`${m.text}\`): ${task}` };
  const what = m.label === "tenant" ? `the tenant filter \`${m.from}\` is dropped from the query` : m.label === "error" ? "this catch rethrows instead of answering with its fallback" : `\`${m.from}\` is removed (${LABELS[/** @type {keyof typeof LABELS} */ (m.label)] ?? m.label})`;
  return { file: m.path, line: m.line, target: `${m.path}:${m.line}`, message: `${m.path}:${m.line} no test fails when ${what}: ${task}` };
}

/** What a removed check protected, as a survivor's line says it. */
const LABELS = { access: "an access check", idempotency: "an idempotency guard", transition: "a state-transition guard", invalidation: "a cache invalidation", check: "a check", guard: "a guard" };
/** Survivors reported per file: past a few, more lines of the same file only repeat that its tests are thin. */
const PER_FILE = 3;

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function mutation({ cwd, base, testCmd, testPaths, setup, mutants: max, timeout }) {
  if (!testCmd) throw new GateError('needs a test command: pass --cmd "<command>" or set "gates.testCmd" in intersite.yml');
  const sha = resolveBase(cwd, base);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);

  // Which mutants to try, spread across lines and files, is chosen in core/hygiene.rs.
  const files = [...addedLines(patch)].sort(([a], [b]) => a.localeCompare(b)).filter(([path]) => SOURCE.test(path) && !matches(path, testPaths)).map(([path, lines]) => [path, [...lines]]);
  /** @type {Mutant[]} */
  const chosen = runCore({ command: "mutants", root: cwd, options: { files, max } }).data;

  // A worktree of HEAD with the whole repository's uncommitted changes (and deletions) copied over, since the project's
  // tests may use a sibling package edited alongside it. Paths are relative to the repository top, as the overlay wants.
  const top = topLevel(cwd);
  const [sinceHead] = workingDiff(top, [["--name-status", "--no-renames", "-z", "HEAD"]], WORK_TREE);
  const overlay = parseNameStatus(sinceHead).map((c) => ({ path: c.path, deleted: c.status === "D" }));
  return withWorktree({ cwd, ref: "HEAD", setup, overlay }, async (dir) => {
    const baseline = await sh(testCmd, dir, { timeout, output: "keep" });
    if (baseline.code !== 0) {
      const { why } = outcomeOf(baseline);
      throw new GateError(`the tests must pass before mutating, and ${testCmd} ${baseline.timedOut ? `timed out after ${timeout}s` : `exited ${baseline.code}`}${why ? `: ${why}` : ""}`);
    }
    const { findings, tried, invalid, byLabel } = await tryAll(chosen, dir, testCmd, timeout);
    const valid = tried - invalid;
    const labels = [...byLabel].map(([label, [k, t]]) => `${label} ${k}/${t}`).join(", ");
    return { findings, summary: `${valid - findings.length}/${valid} mutants killed${invalid ? `, ${invalid} invalid (did not compile or run)` : ""}${labels ? `; semantic: ${labels}` : ""}` };
  });
}
