// @ts-check
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { EMPTY_TREE, GateError, changes, git, inGit, matches, resolveBase } from "../gates/lib.mjs";
import { answers } from "../replay/run.mjs";
import { loadConfig } from "../shared/config.mjs";
import { WHOLE } from "./gate.mjs";
import { installed, upgradeAvailable } from "./upgrade.mjs";

/** Whether a collector answers at this URL. @param {string} url */
function reachable(url) {
  return fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok, () => false);
}

const TAIL = 40;

/**
 * @typedef {{ file?: string, line?: number, target: string, message: string }} Finding
 * @typedef {{ name: string, code: number, findings: Finding[], acknowledged: Finding[], output: string[] }} Record
 *   one stage's result; `output` is what a project check or replay printed, kept for `--json`
 */

/**
 * Runs one of the project's own checks. A pass prints nothing; a failure prints the end of the command's output and
 * one line with the command that reruns it, which is also its finding.
 * @param {{ name: string, run: string, cwd: string }} check @param {string} root
 * @param {(line: string) => void} print @param {Record} record
 * @returns {Promise<number>}
 */
function runCheck(check, root, print, record) {
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
      if (lines.length > TAIL) print(`… ${check.name}: last ${TAIL} lines of output`);
      print(lines.slice(-TAIL).join("\n"));
      const message = `${check.name}: failed with exit ${code ?? "by signal"} | rerun: ${check.cwd === "." ? "" : `cd ${check.cwd} && `}${check.run}`;
      print(message);
      record.findings.push({ target: check.name, message });
      done(1);
    });
  });
}

/**
 * Runs one stage, its findings going to `record`. With `silent` (`--json`) nothing is printed: what a project check or
 * replay would print is kept as the stage's output, and replay's `FAIL` lines are its findings.
 * @param {{ name: string, command: string, argv: string[], check?: { name: string, run: string, cwd: string } }} stage
 * @param {string} cwd @param {Record} record @param {boolean} silent
 * @returns {Promise<number>}
 */
async function runStage(stage, cwd, record, silent) {
  if (stage.check) return runCheck(stage.check, cwd, silent ? (line) => record.output.push(line) : console.log, record);
  const run = (await import(`./${stage.command}.mjs`)).default;
  if (stage.command === "lint") {
    /** @param {{ file: string, line: number, rule: string, message: string }[]} found */
    const collect = (found) => record.findings.push(...found.map((f) => ({ file: f.file, ...(f.line > 0 && { line: f.line }), target: f.rule, message: f.message })));
    return run(stage.argv, { cwd, quiet: true, silent, collect });
  }
  if (stage.command === "gate") {
    /** @param {{ findings: Finding[], accepted: Finding[] }} result */
    const collect = ({ findings, accepted }) => {
      record.findings.push(...findings);
      record.acknowledged.push(...accepted);
    };
    return run(stage.argv, { cwd, quiet: true, silent, collect });
  }
  if (!silent) return run(stage.argv, { cwd, quiet: true });
  const log = console.log;
  console.log = (/** @type {unknown} */ line) => record.output.push(String(line));
  try {
    return await run(stage.argv, { cwd, quiet: true });
  } finally {
    console.log = log;
    record.findings.push(...record.output.filter((line) => line.startsWith("FAIL")).map((message) => ({ target: stage.name, message })));
  }
}

/**
 * Appends this run to `.intersite/ledger.jsonl`, which `intersite stats` reads: each finding's stage and target (a
 * lint finding's stage is its rule and its target its file), and those an acknowledgment let through.
 * @param {string} cwd @param {string} base @param {Record[]} records
 */
function addToLedger(cwd, base, records) {
  const ask = (/** @type {string[]} */ args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
  const key = (/** @type {Record} */ r) => (/** @type {Finding} */ f) => (r.name === "lint" ? { stage: f.target, target: f.file } : { stage: r.name, target: f.target });
  const run = {
    at: new Date().toISOString(),
    head: ask(["rev-parse", "--verify", "--quiet", "HEAD"]),
    branch: ask(["rev-parse", "--abbrev-ref", "HEAD"]),
    base,
    findings: records.flatMap((r) => r.findings.map(key(r))),
    acknowledged: records.flatMap((r) => r.acknowledged.map(key(r))),
  };
  mkdirSync(join(cwd, ".intersite"), { recursive: true });
  appendFileSync(join(cwd, ".intersite", "ledger.jsonl"), `${JSON.stringify(run)}\n`);
}

/**
 * `intersite check [--base <ref>] [--skip <stage>]... [--full] [--all] [--json]`: every check that applies to this project,
 * in order of cost: lint, the gates, the project's own `checks`, replay. Each stage prints its own findings; this
 * adds one line saying which stages failed. All stages run even after a failure, so one run shows everything there
 * is to fix. A project check runs when the change touches its `when` paths; `--full` adds the slow ones, and `--all`
 * runs every check and judges the whole repository, not only the change.
 * @param {string[]} argv @param {{ cwd: string }} context
 */
export default async function check(argv, { cwd }) {
  let config;
  /** @type {{ base?: string, skip?: string[], full?: boolean, all?: boolean, json?: boolean }} */
  let flags;
  try {
    flags = parseArgs({ args: argv, options: { base: { type: "string" }, skip: { type: "string", multiple: true }, full: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" } } }).values;
  } catch (error) {
    console.error(`check: ${/** @type {Error} */ (error).message}; usage: intersite check [--base <ref>] [--skip <stage>]... [--full] [--all] [--json]`);
    return 2;
  }
  try {
    config = loadConfig(cwd);
  } catch (error) {
    console.error(`check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  // Asked now, answered while the stages run: a newer Intersite release to upgrade to.
  const upgrade = upgradeAvailable(cwd);
  const skip = new Set(flags.skip ?? []);
  const base = flags.base ? ["--base", flags.base] : [];
  /** @type {string[]} */
  const skipped = [];
  // `--json` prints one object, so the `skip …` lines go into it instead.
  const note = (/** @type {string} */ line) => (flags.json ? skipped.push(line) : console.log(line));

  const git = inGit(cwd);
  if (!git) note("skip gates: not a git repository (run `git init` to check changes)");
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
  // A bug fix must come with a test that fails without it. When the change says it is a fix and the project has a test
  // command, fails-on-base joins the slow stages, so `--full` proves the new test catches the bug.
  const proveFix = git && config.gates.testCmd && !config.gates.run.includes("fails-on-base") && !skip.has("fails-on-base") && isFix(cwd, flags.base ?? config.gates.base);
  if (proveFix && (flags.full || flags.all)) stages.push({ name: "fails-on-base", command: "gate", argv: ["fails-on-base", ...base] });
  const applies = config.checks.filter((check) => !skip.has(check.name) && (!changed || !check.when.length || changed.some((path) => matches(path, check.when))));
  const waiting = applies.filter((check) => check.slow && !flags.full && !flags.all);
  const slowNames = [...waiting.map((check) => check.name), ...(proveFix && !flags.full && !flags.all ? ["fails-on-base"] : [])];
  if (slowNames.length) note(`skip ${slowNames.join(", ")}: slow, run with \`intersite check --full\``);
  stages.push(...applies.filter((check) => !waiting.includes(check)).map((check) => ({ name: check.name, command: "check", argv: [], check })));
  if (config.replay.enabled && !skip.has("replay")) {
    if (!existsSync(resolve(cwd, config.replay.adapter))) note(`skip replay: no adapter at ${config.replay.adapter}`);
    else if (!(await reachable(config.collector.url))) note(`skip replay: no collector at ${config.collector.url} (start one with \`intersite collector\`)`);
    else if (!(await answers(config.replay.target))) note(`skip replay: nothing answers at ${config.replay.target} (start the server to replay recorded sessions)`);
    else stages.push({ name: "replay", command: "replay", argv: [] });
  }

  /** @type {string[]} */
  const failed = [];
  /** @type {Record[]} */
  const records = [];
  let worst = 0;
  /** @param {typeof stages[number]} stage */
  const runOne = async (stage) => {
    // Each stage prints only its findings; this command's own line is the one success line.
    /** @type {Record} */
    const record = { name: stage.name, code: 0, findings: [], acknowledged: [], output: [] };
    records.push(record);
    record.code = await runStage(stage, cwd, record, Boolean(flags.json));
    if (record.code !== 0) failed.push(stage.name);
    worst = Math.max(worst, record.code);
  };
  const [lint, ...rest] = stages.filter((stage) => !skip.has(stage.name));
  // Lint waits on oxlint in another process, so the gates run meanwhile; its line prints when it finishes.
  const linting = lint ? runOne(lint) : undefined;
  for (const stage of rest) await runOne(stage);
  await linting;
  const tag = await upgrade;
  if (git) addToLedger(cwd, flags.base ?? config.gates.base, records);
  if (flags.json) {
    console.log(JSON.stringify({ ok: !failed.length, stages: records.map(({ name, code, findings, output }) => ({ name, ok: code === 0, code, findings, ...(output.length && { output }) })), skipped, ...(tag && { upgrade: tag }) }));
    return worst;
  }
  if (tag) console.log(`upgrade intersite: ${tag} is out and this is v${installed}; install github:will4381/intersite#${tag} as a dev dependency (npm i -D, or the project's package manager), then run \`npx intersite init\``);
  const ran = stages.filter((stage) => !skip.has(stage.name)).map((stage) => stage.name);
  console.log(failed.length > 0 ? `FAIL check: ${failed.join(", ")}` : `ok check: ${ran.join(", ") || "no stages ran"}`);
  return worst;
}

/**
 * Whether the change calls itself a bug fix: its branch name or a commit message since the base says fix, bug,
 * hotfix or regression. Any failure to read git counts as no.
 * @param {string} cwd @param {string} base
 */
function isFix(cwd, base) {
  try {
    const sha = resolveBase(cwd, base);
    if (sha === EMPTY_TREE) return false;
    const said = `${git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])}\n${git(cwd, ["log", "--format=%s%n%b", `${sha}..HEAD`])}`;
    return /(^|[^a-z])(fix(es|ed)?|bug(fix)?|hotfix|regression)([^a-z]|$)/i.test(said);
  } catch (error) {
    if (error instanceof GateError) return false;
    throw error;
  }
}
