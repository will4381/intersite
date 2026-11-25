// @ts-check
// `intersite flow`: plays JSON flows in a browser (`.intersite/flows/*.json` by default), or writes one from a recorded session.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { LOCAL_HOST, getCase } from "../replay/collector.mjs";
import { flowProblem, runFlows, toFlow } from "../replay/flow.mjs";
import { collectorTokens, loadConfig } from "../shared/config.mjs";
import { named } from "./replay.mjs";

const FLOWS = ".intersite/flows";
const USAGE = "usage: intersite flow [<file>...] [--network recorded|none] [--timing fast|recorded] [--concurrency <n>] [--headed] [--allow-remote] [--json]"
  + " | intersite flow --from <caseId> [--out <file>] (writes the session up to that case as a flow)";

const options = /** @type {const} */ ({
  from: { type: "string" },
  out: { type: "string" },
  network: { type: "string" },
  timing: { type: "string" },
  concurrency: { type: "string" },
  headed: { type: "boolean" },
  "allow-remote": { type: "boolean" },
  json: { type: "boolean" },
});

/** @param {string[]} argv @param {{ cwd: string, print?: (line: string) => void }} context @returns {Promise<number>} */
export default async function flow(argv, { cwd, print = console.log }) {
  try {
    const { values: flags, positionals } = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
    const config = loadConfig(cwd);
    if (flags.from) return await write(cwd, config, flags.from, flags.out, print);
    return await run(cwd, config, flags, positionals, print);
  } catch (error) {
    const usage = String(/** @type {{ code?: unknown }} */ (error)?.code).startsWith("ERR_PARSE_ARGS") ? `; ${USAGE}` : "";
    console.error(`intersite flow: ${error instanceof Error ? error.message : error}${usage}`);
    return 2;
  }
}

/**
 * Writes the session of a recorded case, up to that case, as a flow file.
 * @param {string} cwd @param {import("../shared/config.mjs").Config} config @param {string} id @param {string | undefined} out @param {(line: string) => void} print
 */
async function write(cwd, config, id, out, print) {
  const collector = { url: config.collector.url, token: collectorTokens(config).read, project: config.project };
  const { cases } = await getCase(collector, id);
  const made = toFlow(cases);
  const file = out ?? join(FLOWS, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  mkdirSync(dirname(resolve(cwd, file)), { recursive: true });
  writeFileSync(resolve(cwd, file), `${JSON.stringify(made, null, 2)}\n`);
  print(`wrote ${file} (${made.steps.length} steps); run it: npx intersite flow ${file}`);
  return 0;
}

/**
 * Plays the flows and prints one line per failed or skipped flow, then the summary.
 * @param {string} cwd @param {import("../shared/config.mjs").Config} config @param {Record<string, any>} flags @param {string[]} files
 * @param {(line: string) => void} print
 */
async function run(cwd, config, flags, files, print) {
  const network = flags.network ?? "recorded";
  const timing = flags.timing ?? "fast";
  if (!["recorded", "none"].includes(network)) throw new Error("--network must be recorded or none");
  if (!["fast", "recorded"].includes(timing)) throw new Error("--timing must be fast or recorded");
  const { uiTarget, target } = config.replay;
  checkTargets(uiTarget, target, Boolean(flags["allow-remote"]));
  const flows = readFlows(cwd, files);
  const adapter = named(await import(pathToFileURL(resolve(cwd, config.replay.adapter)).href), config.replay.adapter);
  const results = await runFlows(flows, {
    uiTarget, target, adapter, pattern: new RegExp(config.capture.idPattern), headed: Boolean(flags.headed),
    browser: config.replay.browser, browserUrl: config.replay.browserUrl, network, timing,
    concurrency: concurrencyFor(flags.concurrency, adapter, config.replay.browser),
  });
  const ends = results.map(({ steps }) => steps.at(-1)?.result);
  const failed = ends.filter((result) => result === "failed").length;
  if (flags.json) {
    print(JSON.stringify({ flows: results }));
    return failed ? 1 : 0;
  }
  for (const { file, steps } of results) {
    const last = steps.at(-1);
    if (last && last.result !== "passed") print(`${last.result === "failed" ? "FAIL" : "SKIP"} flow ${file} step ${last.index + 1} ${last.verb}: ${last.reason}; rerun: npx intersite flow ${file}`);
  }
  const skipped = ends.filter((result) => result === "skipped").length;
  if (!failed) print(`ok flow: ${results.length - skipped} of ${results.length} flows passed${skipped ? `, ${skipped} skipped` : ""}`);
  return failed ? 1 : 0;
}

/** The app sends real writes to its API, so only local hosts are allowed without --allow-remote. @param {string} uiTarget @param {string} target @param {boolean} allowRemote */
function checkTargets(uiTarget, target, allowRemote) {
  if (!uiTarget) throw new Error("flows need replay.uiTarget in intersite.yml: the web app's origin, such as http://localhost:3000");
  const remote = [uiTarget, target].map((url) => new URL(url).hostname).find((host) => !LOCAL_HOST.test(host));
  if (remote && !allowRemote) throw new Error(`refusing to run flows against ${remote}, which is not a local host; pass --allow-remote if that is intended`);
}

/** The flow files given, or every one in `.intersite/flows/`, parsed and checked. @param {string} cwd @param {string[]} files */
function readFlows(cwd, files) {
  const folder = resolve(cwd, FLOWS);
  const paths = files.length ? files : existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".json")).sort().map((name) => join(FLOWS, name)) : [];
  if (!paths.length) throw new Error(`no flows: write one with npx intersite flow --from <caseId>, or put JSON flows in ${FLOWS}/`);
  return paths.map((file) => {
    /** @type {unknown} */
    let parsed;
    try { parsed = JSON.parse(readFileSync(resolve(cwd, file), "utf8")); } catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : error}`, { cause: error }); }
    const problem = flowProblem(parsed);
    if (problem) throw new Error(`${file}: ${problem}`);
    return { file: relative(cwd, resolve(cwd, file)), flow: /** @type {import("../replay/flow.mjs").Flow} */ (parsed) };
  });
}

/**
 * Flows at once as asked; one when the adapter resets shared state or Lightpanda holds one context.
 * @param {string | undefined} asked @param {import("../replay/run.mjs").Adapter} adapter @param {string} browser
 */
function concurrencyFor(asked, adapter, browser) {
  const concurrency = Number(asked ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
  if (concurrency === 1 || (!adapter.reset && browser !== "lightpanda")) return concurrency;
  console.error(`note: --concurrency ${concurrency} ignored; flows run one at a time because ${adapter.reset ? "the adapter resets shared state" : "lightpanda holds one browser context at a time"}`);
  return 1;
}
