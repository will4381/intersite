// @ts-check
// intersite stats [--json]: per gate and lint rule, the findings `check` raised, how many were fixed and how many
// acknowledged, from .intersite/ledger.jsonl and every acknowledgment. The counting is in core/stats.rs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runCore } from "../gates/core.mjs";
import { GateError, ackTrailers } from "../gates/lib.mjs";
import { loadConfig } from "../shared/config.mjs";

/** @param {number} part @param {number} whole */
const percent = (part, whole) => `${Math.round((100 * part) / Math.max(whole, 1))}%`;

/** @param {string[]} argv @param {{ cwd: string }} context */
export default async function stats(argv, { cwd }) {
  let json;
  try {
    json = parseArgs({ args: argv, options: { json: { type: "boolean" } } }).values.json;
  } catch (error) {
    console.error(`stats: ${/** @type {Error} */ (error).message}; usage: intersite stats [--json]`);
    return 2;
  }
  const ledgerPath = join(cwd, ".intersite", "ledger.jsonl");
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  let answer;
  try {
    answer = runCore({ command: "stats", root: cwd, options: { ledger, acknowledged: loadConfig(cwd).gates.acknowledged, trailers: ackTrailers(cwd, "--all").map(({ sha, gate }) => ({ sha, gate })) } });
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`stats: ${error.message}`);
    return 2;
  }
  /** @type {{ stage: string, raised: number, fixed: number, acknowledged: number }[]} */
  const rows = answer.data;
  if (json) console.log(JSON.stringify({ runs: Number.parseInt(answer.summary, 10), stages: rows }));
  else if (!rows.length) console.log("ok stats: no findings recorded yet; each `intersite check` adds its run to .intersite/ledger.jsonl");
  else for (const r of rows) console.log(`${r.stage}: ${r.raised} raised, ${r.fixed} fixed (${percent(r.fixed, r.raised)}), ${r.acknowledged} acknowledged (${percent(r.acknowledged, r.raised)})`);
  return 0;
}
