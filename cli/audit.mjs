// @ts-check
// `intersite audit [--sample 200] [--json]`: every value capture KEPT (did not replace with a fake), per key, widest
// first. An enum has a handful of values; a key with hundreds of distinct kept values is probably personal data that
// slipped through, and belongs in `capture.redactKeys`. Reading this list is the review to do before production.
import { callCollector, SetupError } from "../collector/client.mjs";
import { loadConfig } from "../shared/config.mjs";

const FAKE = /^(?:text_[0-9a-f]{8}|u[0-9a-f]{8}@example\.test|https:\/\/example\.test\/[0-9a-f]{8}|\+1555\d{7})$/;

/**
 * Adds each kept string under `value` to `kept`, keyed by the dotted path of its key (array indexes dropped).
 * @param {unknown} value @param {string} key @param {RegExp} id @param {Map<string, Map<string, number>>} kept
 */
function collect(value, key, id, kept) {
  if (typeof value === "string") {
    if (FAKE.test(value) || id.test(value) || value === "") return;
    const values = kept.get(key) ?? new Map();
    values.set(value, (values.get(value) ?? 0) + 1);
    kept.set(key, values);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, key, id, kept);
  } else if (value !== null && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) collect(item, key ? `${key}.${name}` : name, id, kept);
  }
}

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function audit(argv, { cwd }) {
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");
  const sample = rest.length === 0 ? 200 : rest[0] === "--sample" && rest.length === 2 ? Number(rest[1]) : NaN;
  if (!Number.isInteger(sample) || sample < 1 || sample > 200) {
    console.error("usage: intersite audit [--sample <1-200 sessions>] [--json]");
    return 2;
  }
  /** @type {{ cases: import("../shared/case.mjs").Case[] }[]} */
  let sessions;
  try {
    const { status, body } = await callCollector(cwd, "GET", `/v1/sessions?sample=${sample}&seed=1`);
    if (status !== 200) throw new SetupError(`collector GET /v1/sessions: ${status} ${body.error ?? ""}`.trim());
    sessions = body.sessions;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    console.error(error.message);
    return 2;
  }

  const id = new RegExp(loadConfig(cwd).capture.idPattern);
  /** @type {Map<string, Map<string, number>>} */
  const kept = new Map();
  let cases = 0;
  for (const session of sessions) {
    for (const item of session.cases) {
      cases += 1;
      collect(item.request.body, "body", id, kept);
      collect(item.request.query, "query", id, kept);
      const template = item.request.route.split("/");
      collect(item.request.path.split("/").filter((segment, index) => segment !== template[index]), `path ${item.request.route}`, id, kept);
      if (item.action) collect(item.action.page.split("/").filter((segment) => segment !== "_"), "page", id, kept);
    }
  }
  const rows = [...kept].map(([key, values]) => ({ key, distinct: values.size, values: [...values].sort((a, b) => b[1] - a[1]).map(([value]) => value) }))
    .sort((a, b) => b.distinct - a.distinct || a.key.localeCompare(b.key));

  if (json) {
    console.log(JSON.stringify({ cases, kept: rows }));
    return 0;
  }
  for (const row of rows) {
    const shown = row.values.slice(0, 8).map((value) => JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)).join(", ");
    console.log(`${row.key}: ${row.distinct} kept ${row.distinct === 1 ? "value" : "values"}: ${shown}${row.distinct > 8 ? `, +${row.distinct - 8} more` : ""}`);
  }
  console.log(`ok audit: ${cases} cases, ${rows.length} keys with kept values; a key that holds personal data goes in capture.redactKeys`);
  return 0;
}
