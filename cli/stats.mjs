// @ts-check
// intersite stats [--json]: per gate and lint rule, the findings `check` raised, how many were fixed and how many
// acknowledged, from .intersite/ledger.jsonl and every acknowledgment. The counting is in core/stats.rs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runCore } from "../gates/core.mjs";
import { GateError } from "../gates/lib.mjs";
import { loadConfig } from "../shared/config.mjs";

/**
 * Every `Intersite-Ack: <gate>: <why>` trailer in the repository's history, one per commit and gate.
 * @param {string} cwd
 */
function trailers(cwd) {
  const log = spawnSync("git", ["log", "--all", "--format=%H%x09%(trailers:key=Intersite-Ack,valueonly,separator=%x1f)"], { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  if (log.status !== 0) return [];
  return log.stdout.split("\n").flatMap((line) => {
    const [sha, values = ""] = line.split("\t");
    return values.split("\x1f").map((value) => value.split(":")[0].trim()).filter(Boolean).map((gate) => ({ sha, gate }));
  });
}

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
    answer = runCore({ command: "stats", root: cwd, options: { ledger, acknowledged: loadConfig(cwd).gates.acknowledged, trailers: trailers(cwd) } });
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
