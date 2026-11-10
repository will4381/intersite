// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { LOCAL_HOST, getCase, listSessions, postResults } from "../replay/collector.mjs";
import { evidenceOf, lintContract } from "../replay/contract.mjs";
import { compareMetrics } from "../replay/metrics.mjs";
import { openapiEvidence } from "../replay/openapi.mjs";
import { answers, replaySessions } from "../replay/run.mjs";
import { compareSnapshots, describe } from "../replay/snapshot.mjs";
import { collectorTokens, loadConfig } from "../shared/config.mjs";

const MODES = ["baseline", "twice", "cross-tenant", "ui", "contract"];

const options = /** @type {const} */ ({
  id: { type: "string" },
  tag: { type: "string", multiple: true },
  sample: { type: "string" },
  seed: { type: "string" },
  since: { type: "string" },
  route: { type: "string" },
  action: { type: "string" },
  "known-good": { type: "boolean" },
  target: { type: "string" },
  mode: { type: "string", multiple: true },
  mark: { type: "boolean" },
  release: { type: "string" },
  "allow-remote": { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  concurrency: { type: "string" },
  headed: { type: "boolean" },
  "metrics-out": { type: "string" },
  "metrics-base": { type: "string" },
  "snapshot-out": { type: "string" },
  "snapshot-base": { type: "string" },
  openapi: { type: "string" },
});

const USAGE = "usage: intersite replay [--id <caseId> | --seed <n> --sample <n> --tag <outcome> --since <7d> --route <route> --action <name> --known-good]"
  + " [--mode <mode>]... [--target <url>] [--allow-remote] [--mark --release <sha>] [--concurrency <n>] [--headed] [--verbose] [--json]"
  + " [--metrics-out <file>] [--metrics-base <file>] (--metrics-base compares Server-Timing counters with a --metrics-out file;"
  + " both runs must replay the same sessions on the same local data, so it reuses that run's seed)"
  + " [--snapshot-out <file>] [--snapshot-base <file>] (--snapshot-base reports every response whose status or values changed since a"
  + " --snapshot-out file, same rules; the file holds response bodies from the local server, so write it under .intersite/, never a tracked path)"
  + " [--mode contract --openapi <file>] (lints an OpenAPI JSON document's contract with no server and no traffic)";

/** `quiet` leaves out the success line, for `check`. @param {string[]} argv @param {{ cwd: string, quiet?: boolean }} context @returns {Promise<number>} */
export default async function replay(argv, { cwd, quiet = false }) {
  try {
    return await main(argv, cwd, quiet);
  } catch (error) {
    const usage = String(/** @type {{ code?: unknown }} */ (error)?.code).startsWith("ERR_PARSE_ARGS") ? `; ${USAGE}` : "";
    console.error(`intersite replay: ${error instanceof Error ? error.message : error}${usage}`);
    return 2;
  }
}

/** @param {string[]} argv @param {string} cwd @param {boolean} quiet */
async function main(argv, cwd, quiet) {
  const { values: flags } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  const config = loadConfig(cwd);
  const target = flags.target ?? config.replay.target;
  const modes = /** @type {import("../replay/run.mjs").Mode[]} */ (flags.mode ?? config.replay.modes);
  for (const mode of modes) if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}; use ${MODES.join(", ")}`);
  const ignoreContract = contractIgnore(config.replay);
  if (flags.openapi) return lintOpenapi({ cwd, file: flags.openapi, modes: flags.mode ?? ["contract"], idPattern: config.capture.idPattern, ignore: ignoreContract, json: flags.json, quiet });
  const contract = modes.includes("contract");
  if (contract && flags.id && !flags.seed) {
    throw new Error("--mode contract with --id needs --seed <n>: the API's conventions come from that run's sample; copy the rerun command from the finding");
  }

  // Replay sends writes, so only local hosts are allowed without --allow-remote.
  let host;
  try { host = new URL(target).hostname; } catch { throw new Error(`target is not a URL: ${target}`); }
  if (!LOCAL_HOST.test(host) && !flags["allow-remote"]) {
    throw new Error(`refusing to send replayed writes to ${host}, which is not a local host; pass --allow-remote if that is intended`);
  }
  if (flags.mark && !flags.release) throw new Error("--mark needs --release <sha>");
  let concurrency = Number(flags.concurrency ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

  const files = { metrics: flags["metrics-base"], snapshot: flags["snapshot-base"] };
  const baselineOnly = ["metrics-out", "metrics-base", "snapshot-out", "snapshot-base"].filter((flag) => flags[/** @type {keyof typeof flags} */ (flag)]);
  if (baselineOnly.length && !modes.includes("baseline")) throw new Error(`${baselineOnly.map((flag) => `--${flag}`).join(" and ")} need${baselineOnly.length === 1 ? "s" : ""} the baseline mode`);
  const ignore = snapshotIgnore(config.replay);
  const bases = { metrics: files.metrics ? readBase(cwd, files.metrics, "metrics") : undefined, snapshot: files.snapshot ? readBase(cwd, files.snapshot, "snapshot") : undefined };

  const collector = { url: config.collector.url, token: collectorTokens(config).read, project: config.project };

  const adapter = named(await import(pathToFileURL(resolve(cwd, config.replay.adapter)).href), config.replay.adapter);
  if (typeof adapter.signIn !== "function") throw new Error(`${config.replay.adapter} does not export signIn`);
  if (concurrency > 1 && typeof adapter.reset === "function") {
    console.error(`note: --concurrency ${concurrency} ignored; sessions run one at a time because the adapter resets shared state`);
    concurrency = 1;
  }
  if (concurrency > 1 && modes.includes("ui") && config.replay.browser === "lightpanda") {
    console.error(`note: --concurrency ${concurrency} ignored; lightpanda holds one browser context at a time`);
    concurrency = 1;
  }

  const { seed, sessions } = await pickSessions(flags, String(config.replay.sample), collector, bases.metrics ?? bases.snapshot);
  // A rerun of one case still judges it against the conventions of the run that found it: the same seeded sample.
  const sample = contract && flags.id ? (await pickSessions({ ...flags, id: undefined }, String(config.replay.sample), collector, undefined)).sessions : [];
  if (sessions.length && modes.some((mode) => mode !== "ui") && !(await answers(target))) {
    throw new Error(`nothing answers at ${target}: start the project's server there, or point replay.target in intersite.yml (or --target) at it`);
  }
  const meta = { seed: seed === undefined ? null : Number(seed), sessions: sessions.map((session) => session.session) };
  for (const kind of /** @type {const} */ (["metrics", "snapshot"])) {
    const base = bases[kind];
    const same = !base || (flags.id ? meta.sessions.every((name) => base._meta.sessions.includes(name))
      : meta.seed === base._meta.seed && meta.sessions.join("\n") === base._meta.sessions.join("\n"));
    if (!same) {
      throw new Error(`--${kind}-base ${files[kind]} was written by a run of other sessions (seed ${base._meta.seed}); `
        + `replay the same ones: same --seed, --sample and filters, on the same local data`);
    }
  }

  const results = await replaySessions({
    sessions, target, adapter, modes, idPattern: config.capture.idPattern, shiftDates: config.replay.shiftDates,
    concurrency, uiTarget: config.replay.uiTarget, headed: flags.headed, cwd, browser: config.replay.browser, browserUrl: config.replay.browserUrl,
    snapshots: Boolean(files.snapshot || flags["snapshot-out"]),
  });

  if (flags.mark) await markResults(collector, /** @type {string} */ (flags.release), results);

  const steps = results.flatMap((result) => result.steps);
  /** @type {import("../replay/metrics.mjs").Metrics} */
  const metrics = Object.fromEntries(steps.filter((step) => step.mode === "baseline" && step.counters).map((step) => [step.caseId, step.counters]));
  /** @type {import("../replay/snapshot.mjs").Snapshot} */
  const snapshot = Object.assign({}, ...results.map((result) => result.snapshot));
  // Both bases were read before the run, so an --*-out naming the same file is written after comparing.
  writeRun(cwd, flags["metrics-out"], meta, metrics);
  writeRun(cwd, flags["snapshot-out"], meta, snapshot);
  const { _meta: _metricsMeta, ...metricsBefore } = bases.metrics ?? { _meta: meta };
  const { _meta: _snapshotMeta, ...snapshotBefore } = bases.snapshot ?? { _meta: meta };
  const compared = {
    metrics: bases.metrics && { failures: compareMetrics(metricsBefore, metrics), count: Object.keys(metrics).filter((id) => metricsBefore[id]).length },
    snapshot: bases.snapshot && {
      failures: compareSnapshots(/** @type {import("../replay/snapshot.mjs").Snapshot} */ (snapshotBefore), snapshot, ignore),
      count: Object.keys(snapshot).filter((id) => snapshotBefore[id]).length,
    },
  };
  return report({ flags, quiet, seed, sessions, results, steps, compared, files, contract: contract ? lintRun(flags, [...sessions, ...sample], results, { idPattern: config.capture.idPattern, ignore: ignoreContract }) : undefined });
}

/**
 * The contract findings of a replay run: over the recorded cases of every sampled session and the live answers. With
 * --id, only the findings on that case's route.
 * @param {Record<string, any>} flags @param {{ cases: import("../shared/case.mjs").Case[] }[]} sessions
 * @param {import("../replay/run.mjs").SessionResult[]} results @param {{ idPattern: string, ignore: import("../replay/contract.mjs").Ignore[] }} options
 */
function lintRun(flags, sessions, results, options) {
  const evidence = evidenceOf(sessions.flatMap((session) => session.cases), Object.assign({}, ...results.map((result) => result.live)));
  const picked = evidence.find((item) => item.caseId === flags.id);
  const findings = lintContract(evidence, options).filter((finding) => !picked || (finding.method === picked.method && finding.route === picked.route));
  return { findings, routes: new Set(evidence.map((item) => `${item.method} ${item.route}`)).size };
}

/**
 * `--openapi <file>`: the contract lint over an OpenAPI JSON document, with no server and no traffic.
 * @param {{ cwd: string, file: string, modes: string[], idPattern: string, ignore: import("../replay/contract.mjs").Ignore[], json?: boolean, quiet: boolean }} options
 */
function lintOpenapi({ cwd, file, modes, idPattern, ignore, json, quiet }) {
  if (modes.join() !== "contract") throw new Error("--openapi lints a document, with no server: use it with --mode contract only");
  let doc;
  try {
    doc = JSON.parse(readFileSync(resolve(cwd, file), "utf8"));
  } catch (error) {
    throw new Error(`cannot read --openapi ${file} as JSON; export the document as JSON (${error instanceof Error ? error.message : error})`);
  }
  const evidence = openapiEvidence(doc);
  const findings = lintContract(evidence, { idPattern, ignore });
  if (json) {
    console.log(JSON.stringify({ contract: findings }));
    return findings.length ? 1 : 0;
  }
  const summary = `replay: openapi ${file}; contract: ${new Set(evidence.map((item) => `${item.method} ${item.route}`)).size} routes, ${findings.length} findings`;
  if (!findings.length) {
    if (!quiet) console.log(`ok ${summary}`);
    return 0;
  }
  console.log([summary, ...findings.map((finding) => contractLine(finding, `intersite replay --openapi ${file} --mode contract`))].join("\n"));
  return 1;
}

/**
 * One contract finding as a line, ending with how to accept it where a reviewer sees it.
 * @param {import("../replay/contract.mjs").Finding} finding @param {string} rerun
 */
function contractLine({ check, method, route, pointer, message, caseId }, rerun) {
  const entry = `{ "route": "${method} ${route}", "check": "${check}"${pointer ? `, "pointer": "${pointer}"` : ""}, "why": "…" }`;
  return `FAIL contract ${method} ${route}: ${message} (case ${caseId}) | rerun: ${rerun} | to accept: add ${entry} to replay.contractIgnore in intersite.yml`;
}

/** The flags that pick the same sample again, for a contract rerun. @param {Record<string, any>} flags @param {string | undefined} seed */
function sampleFlags(flags, seed) {
  const repeated = (/** @type {string} */ name, /** @type {string[] | undefined} */ list) => (list ?? []).map((value) => ` --${name} ${value}`).join("");
  return ` --seed ${seed}${flags.sample ? ` --sample ${flags.sample}` : ""}${repeated("tag", flags.tag)}${["since", "route", "action"].map((name) => repeated(name, flags[name] && [flags[name]])).join("")}`
    + (flags["known-good"] ? " --known-good" : "");
}

/** `replay.contractIgnore`, checked: deliberate exceptions to the contract lint. @param {Record<string, unknown>} replayConfig @returns {import("../replay/contract.mjs").Ignore[]} */
function contractIgnore(replayConfig) {
  const ignore = replayConfig.contractIgnore ?? [];
  const valid = (/** @type {unknown} */ entry) => entry !== null && typeof entry === "object" && "route" in entry && typeof entry.route === "string"
    && "why" in entry && typeof entry.why === "string" && entry.why.trim() !== "";
  if (!Array.isArray(ignore) || !ignore.every(valid)) {
    throw new Error('replay.contractIgnore must be a list of { route: "GET /v1/orders/:id", pointer?, check?, why } entries, each saying why in why');
  }
  return ignore;
}

/**
 * Prints the run: `--json`, or the summary line and one line per finding. Returns the exit code.
 * @param {{ flags: Record<string, any>, quiet: boolean, seed: string | undefined, sessions: { session: string }[],
 *   results: import("../replay/run.mjs").SessionResult[], steps: import("../replay/run.mjs").Step[],
 *   compared: { metrics?: { failures: { caseId: string, reason: string }[], count: number }, snapshot?: { failures: { caseId: string, differences: import("../replay/snapshot.mjs").Difference[] }[], count: number } },
 *   files: { metrics?: string, snapshot?: string }, contract?: { findings: import("../replay/contract.mjs").Finding[], routes: number } }} run
 */
function report({ flags, quiet, seed, sessions, results, steps, compared, files, contract }) {
  const count = (/** @type {string} */ kind) => steps.filter((step) => step.result === kind).length;
  const metricFailures = compared.metrics?.failures ?? [];
  const snapshotFailures = compared.snapshot?.failures ?? [];
  const contractFindings = contract?.findings ?? [];
  const failed = count("failed") + metricFailures.length + snapshotFailures.length + contractFindings.length;
  const where = (/** @type {string} */ caseId) => steps.find((s) => s.mode === "baseline" && s.caseId === caseId);
  if (flags.json) {
    // With --verbose, the recorded cases too: the request as production saw it, scrubbed, for writing a reproduction.
    console.log(JSON.stringify({
      seed, sessions: results.map(({ snapshot: _snapshot, ...result }) => result),
      ...(compared.metrics && { metrics: metricFailures }),
      ...(compared.snapshot && { snapshot: snapshotFailures.map((failure) => ({ ...failure, method: where(failure.caseId)?.method, route: where(failure.caseId)?.route })) }),
      ...(contract && { contract: contractFindings }),
      ...(flags.verbose && { recorded: sessions }),
    }));
    return failed ? 1 : 0;
  }
  const extra = (flags.target ? ` --target ${flags.target}` : "") + (flags["allow-remote"] ? " --allow-remote" : "");
  const metricsCount = compared.metrics ? `; metrics: ${compared.metrics.count} cases compared, ${metricFailures.length} higher` : "";
  const snapshotCount = compared.snapshot ? `; snapshot: ${compared.snapshot.count} cases compared, ${snapshotFailures.length} changed` : "";
  const contractCount = contract ? `; contract: ${contract.routes} routes, ${contractFindings.length} findings` : "";
  const summary = `replay: ${results.length} sessions; steps: ${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped${seed === undefined ? "" : `; seed ${seed}`}${metricsCount}${snapshotCount}${contractCount}`;
  if (!failed) {
    if (!quiet) console.log(`ok ${summary}`);
    return 0;
  }
  const lines = [
    summary,
    ...steps
      .filter((step) => step.result === "failed")
      .flatMap((s) => [
        `FAIL ${s.mode} ${s.caseId} ${s.method} ${s.route}: ${s.reason} | rerun: intersite replay --id ${s.caseId} --mode ${s.mode}${extra}`,
        ...(flags.verbose && s.sent !== undefined ? [`  sent: ${s.sent}`, `  got: ${s.got}`] : []),
      ]),
    ...metricFailures.map(({ caseId, reason }) =>
      `FAIL metrics ${caseId} ${where(caseId)?.method} ${where(caseId)?.route}: ${reason} | rerun: intersite replay --id ${caseId} --metrics-base ${files.metrics}${extra}`),
    ...snapshotFailures.map(({ caseId, differences }) =>
      `FAIL snapshot ${caseId} ${where(caseId)?.method} ${where(caseId)?.route}: ${describe(differences)} | rerun: intersite replay --id ${caseId} --snapshot-base ${files.snapshot}${extra}`),
    ...contractFindings.map((finding) => contractLine(finding, `intersite replay --id ${finding.caseId}${sampleFlags(flags, flags.id ? flags.seed : seed)} --mode contract${extra}`)),
    ...results.filter((result) => result.skipped).map((result) => `SKIP ${result.session}: ${result.skipped}`),
  ];
  console.log(lines.join("\n"));
  return 1;
}

/**
 * Writes a --metrics-out or --snapshot-out file, creating its folder, with the seed and sessions first.
 * @param {string} cwd @param {string | undefined} file @param {{ seed: number | null, sessions: string[] }} meta @param {object} data
 */
function writeRun(cwd, file, meta, data) {
  if (!file) return;
  const path = resolve(cwd, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ _meta: meta, ...data }, null, 2)}\n`);
}

/** `replay.snapshotIgnore`, checked: a list of JSON-pointer globs. @param {Record<string, unknown>} replayConfig @returns {string[]} */
function snapshotIgnore(replayConfig) {
  // Absent means nothing is ignored: not every project has volatile fields the built-in normalisation misses.
  const ignore = replayConfig.snapshotIgnore ?? [];
  if (!Array.isArray(ignore) || !ignore.every((glob) => typeof glob === "string" && glob.startsWith("/"))) {
    throw new Error("replay.snapshotIgnore must be a list of JSON pointers such as /updatedAt or /items/*/etag");
  }
  return ignore;
}

/**
 * The adapter with each function's errors prefixed by where they came from: they are the project's to fix, and a bare
 * "fetch failed" from inside `reset` says nothing.
 * @param {Record<string, any>} module @param {string} file
 * @returns {import("../replay/run.mjs").Adapter}
 */
function named(module, file) {
  /** @param {(...args: any[]) => any} fn @param {string} name */
  const wrap = (fn, name) => async (/** @type {any[]} */ ...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      const code = /** @type {{ cause?: { code?: string } }} */ (error)?.cause?.code;
      throw new Error(`${file} ${name}: ${error instanceof Error ? error.message : error}${code ? ` (${code})` : ""}`, { cause: error });
    }
  };
  const functions = ["signIn", "resolveId", "reset"].filter((name) => typeof module[name] === "function");
  return {
    ...module,
    ...Object.fromEntries(functions.map((name) => [name, wrap(module[name], name)])),
    invariants: module.invariants?.map((/** @type {{ name: string, check: Function }} */ invariant) => ({
      ...invariant, check: wrap(invariant.check.bind(invariant), `invariant "${invariant.name}"`),
    })),
  };
}

/**
 * Reads a --metrics-out or --snapshot-out file to compare against, failing when it is unreadable or has no _meta.
 * @param {string} cwd @param {string} file @param {"metrics" | "snapshot"} kind
 * @returns {{ _meta: { seed: number | null, sessions: string[] } } & Record<string, any>}
 */
function readBase(cwd, file, kind) {
  let base;
  try {
    base = JSON.parse(readFileSync(resolve(cwd, file), "utf8"));
  } catch (error) {
    throw new Error(`cannot read --${kind}-base ${file}; write it first with --${kind}-out (${error instanceof Error ? error.message : error})`);
  }
  if (!Array.isArray(base?._meta?.sessions)) throw new Error(`--${kind}-base ${file} has no _meta; write it with --${kind}-out`);
  return base;
}

/**
 * The sessions to replay, from --id or a seeded sample matching the filters, and the seed used (undefined for --id).
 * @param {{ id?: string, seed?: string, sample?: string, tag?: string[], since?: string, route?: string, action?: string, "known-good"?: boolean }} flags
 * @param {string} defaultSample @param {Parameters<typeof listSessions>[0]} collector
 * @param {{ _meta: { seed: number | null } } | undefined} base
 */
async function pickSessions(flags, defaultSample, collector, base) {
  if (flags.id) return { seed: undefined, sessions: [await getCase(collector, flags.id)] };
  const seed = flags.seed ?? String(typeof base?._meta.seed === "number" ? base._meta.seed : Math.floor(Math.random() * 2 ** 31));
  const sample = flags.sample ?? defaultSample;
  if (!/^\d+$/.test(seed)) throw new Error("--seed must be a non-negative integer");
  if (!/^\d+$/.test(sample) || Number(sample) < 1 || Number(sample) > 200) throw new Error("--sample must be 1 to 200");
  /** @type {[string, string][]} */
  const query = [["sample", sample], ["seed", seed], ...(flags.tag ?? []).map((tag) => /** @type {[string, string]} */ (["outcome", tag]))];
  if (flags.since) query.push(["since", since(flags.since)]);
  if (flags.route) query.push(["route", flags.route]);
  if (flags.action) query.push(["action", flags.action]);
  if (flags["known-good"]) query.push(["known_good", "1"]);
  return { seed, sessions: await listSessions(collector, query) };
}

/**
 * Posts pass or fail for each session that ran at least one step to the collector, under the release.
 * @param {Parameters<typeof postResults>[0]} collector @param {string} release
 * @param {Awaited<ReturnType<typeof replaySessions>>} results
 */
async function markResults(collector, release, results) {
  const marked = results
    .filter((result) => result.steps.some((step) => step.result !== "skipped"))
    .map((result) => ({ session: result.session, pass: !result.steps.some((step) => step.result === "failed") }));
  if (marked.length) await postResults(collector, release, marked);
}

/** "7d", "24h" or an ISO timestamp, as an ISO timestamp. @param {string} value */
function since(value) {
  const relative = /^(\d+)([dh])$/.exec(value);
  if (relative) return new Date(Date.now() - Number(relative[1]) * (relative[2] === "d" ? 86_400_000 : 3_600_000)).toISOString();
  if (Number.isNaN(Date.parse(value))) throw new Error(`--since must be like 7d, 24h or an ISO timestamp, got ${value}`);
  return new Date(value).toISOString();
}
