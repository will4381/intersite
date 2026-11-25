// @ts-check
// `intersite actions [--since 7d] [--json]`: every named action the collector has seen, per page, errors first.
import { parseArgs } from "node:util";

import { callCollector } from "../collector/client.mjs";
import { GateError } from "../gates/lib.mjs";

const UNITS = { h: 3_600_000, d: 86_400_000 };

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function actions(argv, { cwd }) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { since: { type: "string" }, json: { type: "boolean" } } }));
  } catch {
    values = { since: "" };
  }
  const relative = /^(\d+)([hd])$/.exec(values.since ?? "");
  const at = relative ? Date.now() - Number(relative[1]) * UNITS[/** @type {"h" | "d"} */ (relative[2])] : Date.parse(values.since ?? "");
  const since = values.since === undefined || Number.isNaN(at) ? undefined : new Date(at).toISOString();
  const json = values.json;
  if (values.since !== undefined && since === undefined) {
    console.error("usage: intersite actions [--since <n>d | <n>h | <ISO timestamp>] [--json]");
    return 2;
  }
  /** @type {{ name: string, page: string, ok: number, warn: number, rejected: number, error: number, lastAt: string }[]} */
  let rows;
  try {
    rows = (await callCollector(cwd, "GET", `/v1/actions${since ? `?since=${encodeURIComponent(since)}` : ""}`)).body.actions;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(error.message);
    return 2;
  }
  if (json) console.log(JSON.stringify({ actions: rows }));
  else if (!rows.length) console.log("ok actions: none recorded");
  // The collector already sorts errors first.
  else for (const a of rows) console.log(`${a.name} ${a.page} ok=${a.ok} warn=${a.warn} rejected=${a.rejected} error=${a.error} last=${a.lastAt}`);
  return 0;
}
