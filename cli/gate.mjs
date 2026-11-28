// @ts-check
// intersite gate <name> [--base <ref>] [--json] [--cmd "<test command>"] [--paths <glob>]... [--setup "<command>"]
//   [--max <n>] [--timeout <seconds>] [--all [--write]]
import { parseArgs } from "node:util";

import { BASELINE, loadConfig, readBaselines, writeBaseline } from "../shared/config.mjs";
import { artifacts } from "../gates/artifacts.mjs";
import { complexity } from "../gates/complexity.mjs";
import { coverage } from "../gates/coverage.mjs";
import { columns } from "../gates/columns.mjs";
import { dataModel } from "../gates/data-model.mjs";
import { duplicates } from "../gates/duplicates.mjs";
import { productCodeGate } from "../gates/core.mjs";
import { graphGate, imports } from "../gates/imports.mjs";
import { failsOnBase } from "../gates/fails-on-base.mjs";
import { EMPTY_TREE, GateError, ackTrailers, annotation, inGitHubActions, projectPrefix, resolveBase } from "../gates/lib.mjs";
import { mutation } from "../gates/mutation.mjs";
import { naming } from "../gates/naming.mjs";
import { newDeps } from "../gates/new-deps.mjs";
import { protectedPaths } from "../gates/protected.mjs";
import { similar } from "../gates/similar.mjs";
import { specialCase } from "../gates/special-case.mjs";
import { references } from "../gates/references.mjs";
import { renames } from "../gates/renames.mjs";
import { schemaDrift } from "../gates/schema-drift.mjs";
import { secrets } from "../gates/secrets.mjs";
import { sql } from "../gates/sql.mjs";
import { tamper } from "../gates/tamper.mjs";
import { styleDrift } from "../gates/style-drift.mjs";
import { testIntegrity } from "../gates/test-integrity.mjs";
import { unused } from "../gates/unused.mjs";
import { valueDrift } from "../gates/value-drift.mjs";

/** @type {Record<string, (options: import("../gates/lib.mjs").GateOptions) => import("../gates/lib.mjs").GateResult | Promise<import("../gates/lib.mjs").GateResult>>} */
export const gates = {
  "test-integrity": testIntegrity, duplicates, "new-deps": newDeps, artifacts, unused, similar, naming, "style-drift": styleDrift, "value-drift": valueDrift, sql,
  regex: (options) => productCodeGate("regex", options),
  decisions: (options) => productCodeGate("decisions", options),
  renames, references, "schema-drift": schemaDrift, "fails-on-base": failsOnBase, mutation, protected: protectedPaths, imports,
  boundaries: (options) => graphGate("boundaries", options, { entryPaths: options.entryPaths, layers: options.layers, features: options.features }),
  tamper, "special-case": specialCase, complexity, coverage, columns, "data-model": dataModel,
  routes: (options) => productCodeGate("routes", options, true),
  env: (options) => productCodeGate("env", options, true),
  secrets,
  auth: (options) => productCodeGate("auth", options),
  structure: (options) => graphGate("structure", options),
};

/** Gates that can judge the whole repository (`--all`): the rest only mean something for a change. */
export const WHOLE = new Set(["duplicates", "similar", "unused", "naming", "style-drift", "value-drift", "sql", "regex", "decisions", "schema-drift", "artifacts", "imports", "boundaries", "complexity", "columns", "routes", "env", "secrets", "auth", "structure", "references", "data-model"]);

const usage = `usage: intersite gate <${Object.keys(gates).join("|")}> [--base <ref>] [--json] [--cmd "<test command>"] [--paths <glob>]... [--setup "<command>"] [--max <n>] [--timeout <seconds>] [--all [--write]]`;

/**
 * Runs one gate with the project's config, flags overriding it, and drops acknowledged findings.
 * Throws GateError on a setup problem. `intersite check` can call this directly.
 * With `all` the gate judges every file, not a change, and findings recorded in the baseline are left out.
 * @param {string} name
 * @param {{ cwd: string, config: import("../shared/config.mjs").Config, flags?: Partial<import("../gates/lib.mjs").GateOptions>, all?: boolean, fresh?: boolean }} options
 *   `fresh`: count recorded findings too, to record them again
 * @returns {Promise<import("../gates/lib.mjs").GateResult & { accepted: import("../gates/lib.mjs").Finding[], suggestions: import("../gates/lib.mjs").Finding[] }>}
 *   `accepted`: findings an acknowledgment let through, which `stats` counts; `suggestions`: those still to be read
 */
export async function runGate(name, { cwd, config, flags = {}, all = false, fresh = false }) {
  const { base, testPaths, testCmd, setup, duplicateLines, mutants, entryPaths, acknowledged } = config.gates;
  // The replay adapter is loaded by Intersite itself, by the name in the config, so nothing in the project imports it.
  const loaded = [...entryPaths, config.replay.adapter.replace(/^\.\//, "")];
  const options = { cwd, base, testPaths, testCmd, setup, duplicateLines, mutants, entryPaths: loaded, artifacts: config.gates.artifacts, protected: config.gates.protected, layers: config.gates.layers, features: config.gates.features, timeout: 120 };
  const result = await gates[name]({ ...options, ...flags, ...(all && { base: EMPTY_TREE }) });
  const recorded = new Set(all && !fresh ? readBaseline(cwd)[name] : []);
  const fresher = result.findings.filter((f) => !recorded.has(f.target));
  const isAcknowledged = (/** @type {import("../gates/lib.mjs").Finding} */ f) => acknowledged.some((a) => a.gate === name && a.target === f.target);
  const findings = fresher.filter((f) => !isAcknowledged(f));
  // A suggestion is dropped the same two ways a finding is: recorded in the baseline, or acknowledged.
  const suggestions = (result.suggestions ?? []).filter((f) => !recorded.has(f.target) && !isAcknowledged(f));
  const why = findings.length && !all ? acknowledgedInCommits(cwd, flags.base ?? base, name) : "";
  if (why) return { findings: [], suggestions, summary: `${result.summary}; ${findings.length} acknowledged for this change: ${why}`, accepted: fresher };
  return { findings, suggestions, summary: result.summary, accepted: fresher.filter(isAcknowledged) };
}

/**
 * The reason an `Intersite-Ack: <gate>: <why>` trailer on a commit since the base gives for accepting this gate's
 * findings in this change only, or "". Unlike `gates.acknowledged`, it never exempts a later change.
 * @param {string} cwd @param {string} base @param {string} name
 */
function acknowledgedInCommits(cwd, base, name) {
  const from = resolveBase(cwd, base);
  if (from === EMPTY_TREE) return "";
  return ackTrailers(cwd, `${from}..HEAD`).find((t) => t.gate === name && t.why)?.why ?? "";
}

/**
 * The whole-repository findings recorded per gate, so `--all` fails only on new ones.
 * @param {string} cwd @returns {Record<string, string[]>}
 */
function readBaseline(cwd) {
  try {
    return readBaselines(cwd).gates ?? {};
  } catch (error) {
    throw new GateError(`${/** @type {Error} */ (error).message}: restore it from git, or record it again with \`intersite gate <name> --all --write\``);
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd: string, quiet?: boolean, silent?: boolean, collect?: (result: Awaited<ReturnType<typeof runGate>>) => void }} options
 *   for `check`: `quiet` leaves out the success line, `collect` is handed the result, `silent` prints nothing (`--json`)
 */
export default async function gate(argv, { cwd, quiet = false, silent = false, collect }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        base: { type: "string" },
        json: { type: "boolean" },
        cmd: { type: "string" },
        paths: { type: "string", multiple: true },
        setup: { type: "string" },
        max: { type: "string" },
        timeout: { type: "string" },
        all: { type: "boolean" },
        write: { type: "boolean" },
      },
    });
  } catch (error) {
    console.error(`${/** @type {Error} */ (error).message.split("\n")[0]}; ${usage}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const name = positionals[0];
  if (positionals.length !== 1 || !Object.hasOwn(gates, name)) {
    console.error(name ? `intersite gate: unknown gate "${name}"; ${usage}` : usage);
    return 2;
  }
  const flags = gateFlags(name, values);
  if (typeof flags === "string") {
    console.error(`intersite gate: ${flags}`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(cwd);
  } catch (error) {
    console.error(`intersite gate: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
    return 2;
  }
  let result;
  try {
    if (values.write) return await recordGate(name, cwd, config, flags);
    result = await runGate(name, { cwd, config, flags, all: values.all });
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`gate ${name}: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
    return 2;
  }

  collect?.(result);
  if (!silent) show(name, result, { json: values.json, all: values.all, quiet, cwd });
  return result.findings.length ? 1 : 0;
}

/**
 * The gate options the command line overrides, or what is wrong with the flags.
 * @param {string} name
 * @param {{ base?: string, cmd?: string, paths?: string[], setup?: string, max?: string, timeout?: string, all?: boolean, write?: boolean }} values
 * @returns {Partial<import("../gates/lib.mjs").GateOptions> | string}
 */
function gateFlags(name, values) {
  const max = values.max === undefined ? undefined : Number(values.max);
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if ((max !== undefined && !(Number.isInteger(max) && max > 0)) || (timeout !== undefined && !(timeout > 0))) {
    return `--max must be a positive integer and --timeout a positive number of seconds; ${usage}`;
  }
  if (values.write && !values.all) return `--write records whole-repository findings, so it needs --all; ${usage}`;
  if (values.all && !WHOLE.has(name)) return `${name} only judges a change, so --all does not apply; it works for ${[...WHOLE].join(", ")}`;
  return {
    ...(values.base && { base: values.base }),
    ...(values.cmd && { testCmd: values.cmd }),
    ...(values.paths && { testPaths: values.paths }),
    ...(values.setup !== undefined && { setup: values.setup }),
    ...(max !== undefined && { mutants: max }),
    ...(timeout !== undefined && { timeout }),
  };
}

/**
 * `--all --write`: records the gate's whole-repository findings in the baseline, so only new ones fail.
 * @param {string} name @param {string} cwd @param {import("../shared/config.mjs").Config} config
 * @param {Partial<import("../gates/lib.mjs").GateOptions>} flags
 */
async function recordGate(name, cwd, config, flags) {
  const baseline = readBaseline(cwd);
  const { findings, suggestions } = await runGate(name, { cwd, config, flags, all: true, fresh: true });
  baseline[name] = [...new Set([...findings, ...suggestions].map((f) => f.target))].sort();
  const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
  writeBaseline(cwd, "gates", sorted);
  console.log(`ok gate ${name}: ${baseline[name].length} findings recorded in ${BASELINE}; only new ones fail from here`);
  return 0;
}

/**
 * Prints a gate's result: `--json`, the success line, or one line per finding (a GitHub annotation in Actions).
 * @param {string} name @param {import("../gates/lib.mjs").GateResult} result
 * @param {{ json?: boolean, all?: boolean, quiet: boolean, cwd: string }} how
 */
function show(name, { findings, summary, suggestions = [] }, { json, all, quiet, cwd }) {
  if (json) return console.log(JSON.stringify({ gate: name, ok: !findings.length, summary, findings, ...(suggestions.length && { suggestions }) }));
  if (!findings.length && !quiet) console.log(`ok gate ${name}: ${summary}`);
  const prefix = inGitHubActions() ? projectPrefix(cwd) : "";
  for (const f of findings) {
    const text = `${f.message} | to accept: add { "gate": "${name}", "target": "${f.target}", "why": "…" } to gates.acknowledged in intersite.yml${all ? `, or record today's with \`intersite gate ${name} --all --write\`` : `, or for this change only a commit trailer \`Intersite-Ack: ${name}: <why>\``}`;
    console.log(inGitHubActions() ? annotation(prefix, `intersite ${name}`, f, text) : text);
  }
  // A suggestion is printed after what fails, says that it is one, and is a notice on a pull request.
  for (const f of suggestions) {
    const text = `suggestion: ${f.message} | it fails nothing; to stop seeing it: add { "gate": "${name}", "target": "${f.target}", "why": "…" } to gates.acknowledged in intersite.yml${all ? `, or record today's with \`intersite gate ${name} --all --write\`` : ""}`;
    console.log(inGitHubActions() ? annotation(prefix, `intersite ${name}`, f, text, "notice") : text);
  }
}
