// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { LOCAL_HOST, getCase, listSessions, postResults } from "../replay/collector.mjs";
import { compareMetrics } from "../replay/metrics.mjs";
import { replaySessions } from "../replay/run.mjs";
import { collectorTokens, loadConfig } from "../shared/config.mjs";

const MODES = ["baseline", "twice", "cross-tenant", "ui"];

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
});

const USAGE = "usage: intersite replay [--id <caseId> | --seed <n> --sample <n> --tag <outcome> --since <7d> --route <route> --action <name> --known-good]"
  + " [--mode <mode>]... [--target <url>] [--allow-remote] [--mark --release <sha>] [--concurrency <n>] [--headed] [--verbose] [--json]"
  + " [--metrics-out <file>] [--metrics-base <file>] (--metrics-base compares Server-Timing counters with a --metrics-out file;"
  + " both runs must replay the same sessions on the same local data, so it reuses that run's seed)";

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function replay(argv, { cwd }) {
  try {
    return await main(argv, cwd);
  } catch (error) {
    const usage = String(/** @type {{ code?: unknown }} */ (error)?.code).startsWith("ERR_PARSE_ARGS") ? `; ${USAGE}` : "";
    console.error(`intersite replay: ${error instanceof Error ? error.message : error}${usage}`);
    return 2;
  }
}

/** @param {string[]} argv @param {string} cwd */
async function main(argv, cwd) {
  const { values: flags } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  const config = loadConfig(cwd);
  const target = flags.target ?? config.replay.target;
  const modes = /** @type {import("../replay/run.mjs").Mode[]} */ (flags.mode ?? config.replay.modes);
  for (const mode of modes) if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}; use ${MODES.join(", ")}`);

  // Replay sends writes, so only local hosts are allowed without --allow-remote.
  let host;
  try { host = new URL(target).hostname; } catch { throw new Error(`target is not a URL: ${target}`); }
  if (!LOCAL_HOST.test(host) && !flags["allow-remote"]) {
    throw new Error(`refusing to send replayed writes to ${host}, which is not a local host; pass --allow-remote if that is intended`);
  }
  if (flags.mark && !flags.release) throw new Error("--mark needs --release <sha>");
  let concurrency = Number(flags.concurrency ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

  const metricsBase = flags["metrics-base"];
  if ((metricsBase || flags["metrics-out"]) && !modes.includes("baseline")) throw new Error("--metrics-out and --metrics-base need the baseline mode");
  const base = metricsBase ? readMetricsBase(cwd, metricsBase) : undefined;

  const collector = { url: config.collector.url, token: collectorTokens(config).read, project: config.project };

  const adapter = await import(pathToFileURL(resolve(cwd, config.replay.adapter)).href);
  if (typeof adapter.signIn !== "function") throw new Error(`${config.replay.adapter} does not export signIn`);
  if (concurrency > 1 && typeof adapter.reset === "function") {
    console.error(`note: --concurrency ${concurrency} ignored; sessions run one at a time because the adapter resets shared state`);
    concurrency = 1;
  }

  const { seed, sessions } = await pickSessions(flags, String(config.replay.sample), collector, base);

  if (base) {
    const names = sessions.map((session) => session.session);
    const same = flags.id ? names.every((name) => base._meta.sessions.includes(name))
      : Number(seed) === base._meta.seed && names.join("\n") === base._meta.sessions.join("\n");
    if (!same) {
      throw new Error(`--metrics-base ${metricsBase} was written by a run of other sessions (seed ${base._meta.seed}); `
        + `replay the same ones: same --seed, --sample and filters, on the same local data`);
    }
  }

  const results = await replaySessions({
    sessions, target, adapter, modes, idPattern: config.capture.idPattern, shiftDates: config.replay.shiftDates,
    concurrency, uiTarget: config.replay.uiTarget, headed: flags.headed, cwd,
  });

  if (flags.mark) await markResults(collector, /** @type {string} */ (flags.release), results);

  const steps = results.flatMap((result) => result.steps);
  /** @type {import("../replay/metrics.mjs").Metrics} */
  const metrics = Object.fromEntries(steps.filter((step) => step.mode === "baseline" && step.counters).map((step) => [step.caseId, step.counters]));
  if (flags["metrics-out"]) {
    const file = resolve(cwd, flags["metrics-out"]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ _meta: { seed: seed === undefined ? null : Number(seed), sessions: sessions.map((s) => s.session) }, ...metrics }, null, 2)}\n`);
  }
  let metricFailures = /** @type {{ caseId: string, reason: string }[]} */ ([]);
  if (base) {
    const { _meta, ...before } = base;
    metricFailures = compareMetrics(before, metrics);
  }
  const count = (/** @type {string} */ kind) => steps.filter((step) => step.result === kind).length;
  const failed = count("failed") + metricFailures.length;
  if (flags.json) {
    console.log(JSON.stringify({ seed, sessions: results, ...(base && { metrics: metricFailures }) }));
  } else {
    const extra = (flags.target ? ` --target ${flags.target}` : "") + (flags["allow-remote"] ? " --allow-remote" : "");
    const compared = base ? `; metrics: ${Object.keys(metrics).filter((id) => base[id]).length} cases compared, ${metricFailures.length} higher` : "";
    const summary = `replay: ${results.length} sessions; steps: ${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped${seed === undefined ? "" : `; seed ${seed}`}${compared}`;
    if (!failed) {
      console.log(`ok ${summary}`);
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
      ...metricFailures.map(({ caseId, reason }) => {
        const step = steps.find((s) => s.mode === "baseline" && s.caseId === caseId);
        return `FAIL metrics ${caseId} ${step?.method} ${step?.route}: ${reason} | rerun: intersite replay --id ${caseId} --metrics-base ${metricsBase}${extra}`;
      }),
      ...results.filter((result) => result.skipped).map((result) => `SKIP ${result.session}: ${result.skipped}`),
    ];
    console.log(lines.join("\n"));
  }
  return failed ? 1 : 0;
}

/**
 * Reads a --metrics-out file to compare against, failing when it is unreadable or has no _meta.
 * @param {string} cwd @param {string} metricsBase
 * @returns {{ _meta: { seed: number | null, sessions: string[] } } & import("../replay/metrics.mjs").Metrics}
 */
function readMetricsBase(cwd, metricsBase) {
  let base;
  try {
    base = JSON.parse(readFileSync(resolve(cwd, metricsBase), "utf8"));
  } catch (error) {
    throw new Error(`cannot read --metrics-base ${metricsBase}; write it first with --metrics-out (${error instanceof Error ? error.message : error})`);
  }
  if (!Array.isArray(base?._meta?.sessions)) throw new Error(`--metrics-base ${metricsBase} has no _meta; write it with --metrics-out`);
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
