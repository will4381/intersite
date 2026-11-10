// @ts-check
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { getCase, listSessions, postResults } from "../replay/collector.mjs";
import { replaySessions } from "../replay/run.mjs";
import { loadConfig } from "../shared/config.mjs";

const MODES = ["baseline", "twice", "cross-tenant"];
/** Replay sends writes, so only these hosts are allowed without --allow-remote. */
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$|\.(?:localhost|test)$/;

const options = /** @type {const} */ ({
  id: { type: "string" },
  tag: { type: "string", multiple: true },
  sample: { type: "string" },
  seed: { type: "string" },
  since: { type: "string" },
  route: { type: "string" },
  "known-good": { type: "boolean" },
  target: { type: "string" },
  mode: { type: "string", multiple: true },
  mark: { type: "boolean" },
  release: { type: "string" },
  "allow-remote": { type: "boolean" },
  json: { type: "boolean" },
});

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function replay(argv, { cwd }) {
  try {
    return await main(argv, cwd);
  } catch (error) {
    console.error(`intersite replay: ${error instanceof Error ? error.message : error}`);
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

  let host;
  try { host = new URL(target).hostname; } catch { throw new Error(`target is not a URL: ${target}`); }
  if (!LOCAL_HOST.test(host) && !flags["allow-remote"]) {
    throw new Error(`refusing to send replayed writes to ${host}, which is not a local host; pass --allow-remote if that is intended`);
  }
  if (flags.mark && !flags.release) throw new Error("--mark needs --release <sha>");

  const token = process.env[config.collector.readTokenEnv];
  if (!config.collector.url) throw new Error("collector.url is not set in intersite.json");
  if (!token) throw new Error(`${config.collector.readTokenEnv} is not set`);
  const collector = { url: config.collector.url, token, project: config.project };

  const adapter = await import(pathToFileURL(resolve(cwd, config.replay.adapter)).href);
  if (typeof adapter.signIn !== "function") throw new Error(`${config.replay.adapter} does not export signIn`);

  let seed;
  let sessions;
  if (flags.id) {
    sessions = [await getCase(collector, flags.id)];
  } else {
    seed = flags.seed ?? String(Math.floor(Math.random() * 2 ** 31));
    const sample = flags.sample ?? String(config.replay.sample);
    if (!/^\d+$/.test(seed)) throw new Error("--seed must be a non-negative integer");
    if (!/^\d+$/.test(sample) || Number(sample) < 1 || Number(sample) > 200) throw new Error("--sample must be 1 to 200");
    /** @type {[string, string][]} */
    const query = [["sample", sample], ["seed", seed], ...(flags.tag ?? []).map((tag) => /** @type {[string, string]} */ (["outcome", tag]))];
    if (flags.since) query.push(["since", since(flags.since)]);
    if (flags.route) query.push(["route", flags.route]);
    if (flags["known-good"]) query.push(["known_good", "1"]);
    sessions = await listSessions(collector, query);
  }

  const results = await replaySessions({ sessions, target, adapter, modes, idPattern: config.capture.idPattern });

  if (flags.mark) {
    const marked = results
      .filter((result) => result.steps.some((step) => step.result !== "skipped"))
      .map((result) => ({ session: result.session, pass: !result.steps.some((step) => step.result === "failed") }));
    if (marked.length) await postResults(collector, /** @type {string} */ (flags.release), marked);
  }

  const steps = results.flatMap((result) => result.steps);
  const count = (/** @type {string} */ kind) => steps.filter((step) => step.result === kind).length;
  if (flags.json) {
    console.log(JSON.stringify({ seed, sessions: results }));
  } else {
    const extra = (flags.target ? ` --target ${flags.target}` : "") + (flags["allow-remote"] ? " --allow-remote" : "");
    const lines = [
      `replay: ${results.length} sessions; steps: ${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped${seed === undefined ? "" : `; seed ${seed}`}`,
      ...steps
        .filter((step) => step.result === "failed")
        .map((s) => `FAIL ${s.mode} ${s.caseId} ${s.method} ${s.route}: ${s.reason} | rerun: intersite replay --id ${s.caseId} --mode ${s.mode}${extra}`),
      ...results.filter((result) => result.skipped).map((result) => `SKIP ${result.session}: ${result.skipped}`),
    ];
    console.log(lines.join("\n"));
  }
  return count("failed") ? 1 : 0;
}

/** "7d", "24h" or an ISO timestamp, as an ISO timestamp. @param {string} value */
function since(value) {
  const relative = /^(\d+)([dh])$/.exec(value);
  if (relative) return new Date(Date.now() - Number(relative[1]) * (relative[2] === "d" ? 86_400_000 : 3_600_000)).toISOString();
  if (Number.isNaN(Date.parse(value))) throw new Error(`--since must be like 7d, 24h or an ISO timestamp, got ${value}`);
  return new Date(value).toISOString();
}
