// @ts-check
// `intersite pin <caseId> [--unpin]`: keeps a case past its expiry (or lets it expire again).
import { parseArgs } from "node:util";

import { callCollector } from "../collector/client.mjs";
import { GateError } from "../gates/lib.mjs";
import { CollectorError } from "../replay/collector.mjs";
import { loadConfig } from "../shared/config.mjs";

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function pin(argv, { cwd }) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { unpin: { type: "boolean" } }, allowPositionals: true });
  } catch {
    parsed = { positionals: [] };
  }
  if (parsed.positionals.length !== 1) {
    console.error("usage: intersite pin <caseId> [--unpin]");
    return 2;
  }
  const [id] = parsed.positionals;
  const unpin = Boolean(parsed.values?.unpin);
  try {
    await callCollector(cwd, "POST", `/v1/cases/${encodeURIComponent(id)}/pin`, { pinned: !unpin });
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(error instanceof CollectorError && error.status === 404 ? `case ${id} not found in project ${loadConfig(cwd).project}` : error.message);
    return 2;
  }
  console.log(`ok pin: ${id} ${unpin ? "unpinned" : "pinned"}`);
  return 0;
}
