// @ts-check
// `intersite actions [--since 7d] [--json]`: every named action the collector has seen, per page, errors first.
import { callCollector, SetupError } from "../collector/client.mjs";

const UNITS = { h: 3_600_000, d: 86_400_000 };

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function actions(argv, { cwd }) {
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");
  /** @type {string | undefined} */
  let since;
  if (rest[0] === "--since" && rest.length === 2) {
    const relative = /^(\d+)([hd])$/.exec(rest[1]);
    const at = relative ? Date.now() - Number(relative[1]) * UNITS[/** @type {"h" | "d"} */ (relative[2])] : Date.parse(rest[1]);
    if (!Number.isNaN(at)) since = new Date(at).toISOString();
  }
  if (rest.length && since === undefined) {
    console.error("usage: intersite actions [--since <n>d | <n>h | <ISO timestamp>] [--json]");
    return 2;
  }
  /** @type {{ name: string, page: string, ok: number, warn: number, rejected: number, error: number, lastAt: string }[]} */
  let rows;
  try {
    const { status, body } = await callCollector(cwd, "GET", `/v1/actions${since ? `?since=${encodeURIComponent(since)}` : ""}`);
    if (status !== 200) throw new SetupError(`collector GET /v1/actions: ${status} ${body.error ?? ""}`.trim());
    rows = body.actions;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    console.error(error.message);
    return 2;
  }
  if (json) console.log(JSON.stringify({ actions: rows }));
  else if (!rows.length) console.log("ok actions: none recorded");
  // The collector already sorts errors first.
  else for (const a of rows) console.log(`${a.name} ${a.page} ok=${a.ok} warn=${a.warn} rejected=${a.rejected} error=${a.error} last=${a.lastAt}`);
  return 0;
}
