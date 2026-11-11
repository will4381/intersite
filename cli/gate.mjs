// @ts-check
// intersite gate <name> [--base <ref>] [--json] [--cmd "<test command>"] [--paths <glob>]... [--setup "<command>"]
//   [--max <n>] [--timeout <seconds>] [--all [--write]]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "../shared/config.mjs";
import { artifacts } from "../gates/artifacts.mjs";
import { duplicates } from "../gates/duplicates.mjs";
import { failsOnBase } from "../gates/fails-on-base.mjs";
import { EMPTY_TREE, GateError } from "../gates/lib.mjs";
import { mutation } from "../gates/mutation.mjs";
import { naming } from "../gates/naming.mjs";
import { newDeps } from "../gates/new-deps.mjs";
import { protectedPaths } from "../gates/protected.mjs";
import { similar } from "../gates/similar.mjs";
import { styleDrift } from "../gates/style-drift.mjs";
import { testIntegrity } from "../gates/test-integrity.mjs";
import { unused } from "../gates/unused.mjs";

/** @type {Record<string, (options: import("../gates/lib.mjs").GateOptions) => Promise<import("../gates/lib.mjs").GateResult>>} */
export const gates = { "test-integrity": testIntegrity, duplicates, "new-deps": newDeps, artifacts, unused, similar, naming, "style-drift": styleDrift, "fails-on-base": failsOnBase, mutation, protected: protectedPaths };

/** Gates that can judge the whole repository (`--all`): the rest only mean something for a change. */
export const WHOLE = new Set(["duplicates", "similar", "unused", "naming", "style-drift", "artifacts"]);

const usage = `usage: intersite gate <${Object.keys(gates).join("|")}> [--base <ref>] [--json] [--cmd "<test command>"] [--paths <glob>]... [--setup "<command>"] [--max <n>] [--timeout <seconds>] [--all [--write]]`;

/**
 * Runs one gate with the project's config, flags overriding it, and drops acknowledged findings.
 * Throws GateError on a setup problem. `intersite check` can call this directly.
 * With `all` the gate judges every file, not a change, and findings recorded in `gates.baseline` are left out.
 * @param {string} name
 * @param {{ cwd: string, config: import("../shared/config.mjs").Config, flags?: Partial<import("../gates/lib.mjs").GateOptions>, all?: boolean, fresh?: boolean }} options
 *   `fresh`: count recorded findings too, to record them again
 */
export async function runGate(name, { cwd, config, flags = {}, all = false, fresh = false }) {
  const { base, testPaths, testCmd, setup, duplicateLines, mutants, entryPaths, acknowledged } = config.gates;
  // The replay adapter is loaded by Intersite itself, by the name in the config, so nothing in the project imports it.
  const loaded = [...entryPaths, config.replay.adapter.replace(/^\.\//, "")];
  const options = { cwd, base, testPaths, testCmd, setup, duplicateLines, mutants, entryPaths: loaded, artifacts: config.gates.artifacts, protected: config.gates.protected, timeout: 120 };
  const result = await gates[name]({ ...options, ...flags, ...(all && { base: EMPTY_TREE }) });
  const recorded = new Set(all && !fresh ? readBaseline(cwd, config)[name] : []);
  const findings = result.findings.filter((f) => !recorded.has(f.target) && !acknowledged.some((a) => a.gate === name && a.target === f.target));
  return { findings, summary: result.summary };
}

/**
 * The whole-repository findings recorded per gate, so `--all` fails only on new ones.
 * @param {string} cwd @param {import("../shared/config.mjs").Config} config
 * @returns {Record<string, string[]>}
 */
function readBaseline(cwd, config) {
  const path = join(cwd, config.gates.baseline);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new GateError(`${config.gates.baseline} is not valid JSON: restore it from git, or record it again with \`intersite gate <name> --all --write\``);
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd: string, quiet?: boolean }} options `quiet` leaves out the success line, for `check`
 */
export default async function gate(argv, { cwd, quiet = false }) {
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
  const max = values.max === undefined ? undefined : Number(values.max);
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if ((max !== undefined && !(Number.isInteger(max) && max > 0)) || (timeout !== undefined && !(timeout > 0))) {
    console.error(`intersite gate: --max must be a positive integer and --timeout a positive number of seconds; ${usage}`);
    return 2;
  }

  if (values.write && !values.all) {
    console.error(`intersite gate: --write records whole-repository findings, so it needs --all; ${usage}`);
    return 2;
  }
  if (values.all && !WHOLE.has(name)) {
    console.error(`intersite gate: ${name} only judges a change, so --all does not apply; it works for ${[...WHOLE].join(", ")}`);
    return 2;
  }

  /** @type {Partial<import("../gates/lib.mjs").GateOptions>} */
  const flags = {};
  if (values.base) flags.base = values.base;
  if (values.cmd) flags.testCmd = values.cmd;
  if (values.paths) flags.testPaths = values.paths;
  if (values.setup !== undefined) flags.setup = values.setup;
  if (max !== undefined) flags.mutants = max;
  if (timeout !== undefined) flags.timeout = timeout;

  let config;
  try {
    config = loadConfig(cwd);
  } catch (error) {
    console.error(`intersite gate: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
    return 2;
  }
  let result;
  try {
    if (values.write) {
      const baseline = readBaseline(cwd, config);
      const { findings } = await runGate(name, { cwd, config, flags, all: true, fresh: true });
      baseline[name] = [...new Set(findings.map((f) => f.target))].sort();
      const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(join(cwd, config.gates.baseline), `${JSON.stringify(sorted, null, 2)}\n`);
      console.log(`ok gate ${name}: ${baseline[name].length} findings recorded in ${config.gates.baseline}; only new ones fail from here`);
      return 0;
    }
    result = await runGate(name, { cwd, config, flags, all: values.all });
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`gate ${name}: ${/** @type {Error} */ (error).message.split("\n")[0]}`);
    return 2;
  }

  const { findings, summary } = result;
  if (values.json) {
    console.log(JSON.stringify({ gate: name, ok: !findings.length, summary, findings }));
  } else if (!findings.length) {
    if (!quiet) console.log(`ok gate ${name}: ${summary}`);
  } else {
    for (const f of findings) {
      console.log(`${f.message} | to accept: add { "gate": "${name}", "target": "${f.target}", "why": "…" } to gates.acknowledged in intersite.yml${values.all ? `, or record today's with \`intersite gate ${name} --all --write\`` : ""}`);
    }
  }
  return findings.length ? 1 : 0;
}
