// @ts-check
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { GateError, changes, inGit, matches, resolveBase } from "../gates/lib.mjs";
import { answers } from "../replay/run.mjs";
import { loadConfig } from "../shared/config.mjs";
import { WHOLE } from "./gate.mjs";

/** Whether a collector answers at this URL. @param {string} url */
function reachable(url) {
  return fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok, () => false);
}

const TAIL = 40;

/**
 * Runs one of the project's own checks. A pass prints nothing; a failure prints the end of the command's output and
 * one line with the command that reruns it.
 * @param {{ name: string, run: string, cwd: string }} check @param {string} root
 * @returns {Promise<number>}
 */
function runCheck(check, root) {
  const child = spawn(check.run, { cwd: resolve(root, check.cwd), shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  // ponytail: keeps only the end of the output in memory, which is all a failure prints
  const keep = (/** @type {Buffer} */ chunk) => (output = (output + chunk).slice(-16_384));
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return new Promise((done) => {
    child.on("error", (error) => (output += error.message));
    child.on("close", (code) => {
      if (code === 0) return done(0);
      const lines = output.trimEnd().split("\n");
      if (lines.length > TAIL) console.log(`… ${check.name}: last ${TAIL} lines of output`);
      console.log(lines.slice(-TAIL).join("\n"));
      console.log(`${check.name}: failed with exit ${code ?? "by signal"} | rerun: ${check.cwd === "." ? "" : `cd ${check.cwd} && `}${check.run}`);
      done(1);
    });
  });
}

/**
 * `intersite check [--base <ref>] [--skip <stage>]... [--full] [--all]`: every check that applies to this project,
 * in order of cost: lint, the gates, the project's own `checks`, replay. Each stage prints its own findings; this
 * adds one line saying which stages failed. All stages run even after a failure, so one run shows everything there
 * is to fix. A project check runs when the change touches its `when` paths; `--full` adds the slow ones, and `--all`
 * runs every check and judges the whole repository, not only the change.
 * @param {string[]} argv @param {{ cwd: string }} context
 */
export default async function check(argv, { cwd }) {
  let config;
  /** @type {{ base?: string, skip?: string[], full?: boolean, all?: boolean }} */
  let flags;
  try {
    flags = parseArgs({ args: argv, options: { base: { type: "string" }, skip: { type: "string", multiple: true }, full: { type: "boolean" }, all: { type: "boolean" } } }).values;
  } catch (error) {
    console.error(`check: ${/** @type {Error} */ (error).message}; usage: intersite check [--base <ref>] [--skip <stage>]... [--full] [--all]`);
    return 2;
  }
  try {
    config = loadConfig(cwd);
  } catch (error) {
    console.error(`check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const skip = new Set(flags.skip ?? []);
  const base = flags.base ? ["--base", flags.base] : [];

  const git = inGit(cwd);
  if (!git) console.log("skip gates: not a git repository (run `git init` to check changes)");
  /** @type {{ name: string, command: string, argv: string[], check?: import("../shared/config.mjs").Config["checks"][number] }[]} */
  const stages = [
    { name: "lint", command: "lint", argv: [] },
    // The protected gate needs no listing: writing a `gates.protected` rule turns it on.
    ...(git ? [...new Set([...config.gates.run, ...(config.gates.protected.length ? ["protected"] : [])])] : []).map((/** @type {string} */ gate) => ({ name: gate, command: "gate", argv: flags.all && WHOLE.has(gate) ? [gate, "--all"] : [gate, ...base] })),
  ];
  // Without git, or with a base that cannot be found (the gates say so), there is no change to go by: every check runs.
  /** @type {string[] | undefined} */
  let changed;
  if (git && !flags.all && config.checks.some((check) => check.when.length)) {
    try {
      changed = changes(cwd, resolveBase(cwd, flags.base ?? config.gates.base)).flatMap((change) => [change.path, change.from]);
    } catch (error) {
      if (!(error instanceof GateError)) throw error;
    }
  }
  const applies = config.checks.filter((check) => !skip.has(check.name) && (!changed || !check.when.length || changed.some((path) => matches(path, check.when))));
  const waiting = applies.filter((check) => check.slow && !flags.full && !flags.all);
  if (waiting.length) console.log(`skip ${waiting.map((check) => check.name).join(", ")}: slow, run with \`intersite check --full\``);
  stages.push(...applies.filter((check) => !waiting.includes(check)).map((check) => ({ name: check.name, command: "check", argv: [], check })));
  if (config.replay.enabled && !skip.has("replay")) {
    if (!existsSync(resolve(cwd, config.replay.adapter))) console.log(`skip replay: no adapter at ${config.replay.adapter}`);
    else if (!(await reachable(config.collector.url))) console.log(`skip replay: no collector at ${config.collector.url} (start one with \`intersite collector\`)`);
    else if (!(await answers(config.replay.target))) console.log(`skip replay: nothing answers at ${config.replay.target} (start the server to replay recorded sessions)`);
    else stages.push({ name: "replay", command: "replay", argv: [] });
  }

  /** @type {string[]} */
  const failed = [];
  let worst = 0;
  /** @param {typeof stages[number]} stage */
  const runStage = async (stage) => {
    // Each stage prints only its findings; this command's own line is the one success line.
    const code = stage.check ? await runCheck(stage.check, cwd) : await (await import(`./${stage.command}.mjs`)).default(stage.argv, { cwd, quiet: true });
    if (code !== 0) failed.push(stage.name);
    worst = Math.max(worst, code);
  };
  const [lint, ...rest] = stages.filter((stage) => !skip.has(stage.name));
  // Lint waits on oxlint in another process, so the gates run meanwhile; its line prints when it finishes.
  const linting = lint ? runStage(lint) : undefined;
  for (const stage of rest) await runStage(stage);
  await linting;
  const ran = stages.filter((stage) => !skip.has(stage.name)).map((stage) => stage.name);
  console.log(failed.length > 0 ? `FAIL check: ${failed.join(", ")}` : `ok check: ${ran.join(", ") || "no stages ran"}`);
  return worst;
}
