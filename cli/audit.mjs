// @ts-check
// `intersite audit [--sample 200] [--json]`: every value capture KEPT (did not replace with a fake), per key, widest
// first. An enum has a handful of values; a key with hundreds of distinct kept values is probably personal data that
// slipped through, and belongs in `capture.redactKeys`; an enum key whose values were faked belongs in `capture.keepKeys`. Reading this list is the review to do before production.
import { createScrubber } from "../capture/scrub.mjs";
import { callCollector, SetupError } from "../collector/client.mjs";
import { loadConfig } from "../shared/config.mjs";

const FAKE = /^(?:text-[0-9a-f]{8}|u[0-9a-f]{8}@example\.test|https:\/\/example\.test\/[0-9a-f]{8}|\+1555\d{7})$/;

const TEXT_FAKE = /^text-[0-9a-f]{8}$/;

/**
 * Adds each kept string under `value` to `kept`, keyed by the dotted path of its key (array indexes dropped). A string
 * faked as `text-…` is counted in `faked` instead: few distinct fakes under one key may be a project enum.
 * @param {unknown} value @param {string} key @param {RegExp} id @param {Map<string, Map<string, number>>} kept
 * @param {Map<string, Set<string>>} faked
 */
function collect(value, key, id, kept, faked) {
  if (typeof value === "string") {
    if (TEXT_FAKE.test(value)) faked.set(key, (faked.get(key) ?? new Set()).add(value));
    if (FAKE.test(value) || id.test(value) || value === "") return;
    const values = kept.get(key) ?? new Map();
    values.set(value, (values.get(value) ?? 0) + 1);
    kept.set(key, values);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, key, id, kept, faked);
  } else if (value !== null && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) collect(item, key ? `${key}.${name}` : name, id, kept, faked);
  }
}

/**
 * The path segments that are values, not the route's own words. The template is matched against the path's tail, so a
 * server mounted under a prefix (`/api/v1/me` for `/v1/me`) does not list `api`, `v1` and `me` as kept values.
 * @param {string} path @param {string} route
 */
function pathValues(path, route) {
  const segments = path.split("/");
  const template = route.split("/");
  const offset = Math.max(0, segments.length - template.length);
  return segments.filter((segment, index) => {
    const slot = index > 0 && index <= offset ? undefined : template[Math.max(0, index - offset)];
    return segment !== "" && segment !== slot && !(slot === undefined && /^(?:[a-z]{1,20}|v\d{1,3})$/.test(segment));
  });
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

  const { capture } = loadConfig(cwd);
  const id = new RegExp(capture.idPattern);
  /** @type {Map<string, Map<string, number>>} */
  const kept = new Map();
  /** @type {Map<string, Set<string>>} */
  const faked = new Map();
  let cases = 0;
  for (const session of sessions) {
    for (const item of session.cases) {
      cases += 1;
      collect(item.request.body, "body", id, kept, faked);
      collect(item.request.query, "query", id, kept, faked);
      collect(pathValues(item.request.path, item.request.route), `path ${item.request.route}`, id, kept, faked);
      if (item.action) collect(item.action.page.split("/").filter((segment) => segment !== "_"), "page", id, kept, faked);
    }
  }
  const rows = [...kept].map(([key, values]) => ({ key, distinct: values.size, values: [...values].sort((a, b) => b[1] - a[1]).map(([value]) => value) }))
    .sort((a, b) => b.distinct - a.distinct || a.key.localeCompare(b.key));
  const replaced = await replacedNow(rows, capture);

  const fakedRows = [...faked].map(([key, values]) => ({ key, distinct: values.size })).sort((a, b) => a.distinct - b.distinct || a.key.localeCompare(b.key));
  if (json) {
    console.log(JSON.stringify({ cases, kept: rows.map((row) => ({ ...row, replacedNow: replaced.has(row.key) })), faked: fakedRows }));
    return 0;
  }
  for (const row of rows) {
    const shown = row.values.slice(0, 8).map((value) => JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)).join(", ");
    const note = replaced.has(row.key) ? " (capture as configured here replaces these: fakes of dates or digits, or stored under another config)" : "";
    console.log(`${row.key}: ${row.distinct} kept ${row.distinct === 1 ? "value" : "values"}: ${shown}${row.distinct > 8 ? `, +${row.distinct - 8} more` : ""}${note}`);
  }
  for (const row of fakedRows) console.log(`${row.key}: ${row.distinct} distinct ${row.distinct === 1 ? "value" : "values"} faked as text`);
  console.log(`ok audit: ${cases} cases, ${rows.length} keys with kept values, ${fakedRows.length} with faked text; a key that holds personal data goes in capture.redactKeys; an enum that was faked goes in capture.keepKeys`);
  return 0;
}

/**
 * The keys whose every listed value the scrubber, as configured here, would replace. A fake date or digit string looks
 * like a real one, so it lands in the kept list; so does a value stored by a capture configured otherwise (a Worker
 * passes its lists inline). Both are worth a look, so the row stays, marked.
 * @param {{ key: string, values: string[] }[]} rows @param {{ idPattern: string, redactKeys: string[], keepKeys: string[] }} capture
 */
async function replacedNow(rows, capture) {
  const scrubber = createScrubber({ salt: "audit", idPattern: capture.idPattern, redactKeys: capture.redactKeys, keepKeys: capture.keepKeys });
  /** @type {Set<string>} */
  const replaced = new Set();
  // Body and query rows only: a path or page row's key is not the name capture scrubbed it under.
  for (const row of rows.filter((item) => /^(?:body|query)\./.test(item.key))) {
    const key = row.key.split(".").at(-1) ?? "";
    const kept = await Promise.all(row.values.map(async (value) => (await scrubber.scrub(value, key)) === value));
    if (!kept.some(Boolean)) replaced.add(row.key);
  }
  return replaced;
}
