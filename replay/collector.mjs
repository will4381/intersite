// @ts-check
/** The collector's read routes (CONTRACT.md "Collector HTTP API"), called with the read token. */

import { GateError } from "../gates/lib.mjs";
import { collectorTokens } from "../shared/config.mjs";

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {{ url: string, token: string, tokenEnv: string, project: string }} Collector */
/** @typedef {{ session: string, cases: Case[] }} Session */

/** Hosts on this machine (or reserved for local testing). */
export const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$|\.(?:localhost|test)$/;

/** A collector call that failed: the one line to print, and the HTTP status when the collector answered. */
export class CollectorError extends GateError {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The project's collector, read with the read token. @param {import("../shared/config.mjs").Config} config @returns {Collector} */
export const collectorOf = (config) => ({ url: config.collector.url, token: collectorTokens(config).read, tokenEnv: config.collector.readTokenEnv, project: config.project });

/**
 * One collector route's JSON answer. Throws CollectorError when the collector cannot be reached or does not answer 200.
 * @param {Collector} collector @param {string} method @param {string} path @param {unknown} [body]
 */
export async function call(collector, method, path, body) {
  const response = await fetch(collector.url.replace(/\/$/, "") + path, {
    method,
    headers: { authorization: `Bearer ${collector.token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    let local = false;
    try { local = LOCAL_HOST.test(new URL(collector.url).hostname); } catch { local = false; }
    throw new CollectorError(`cannot reach the collector at ${collector.url}; ${local ? "start it with `intersite collector`" : "check collector.url in intersite.yml"}`);
  });
  const json = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) throw new CollectorError(`collector refused the read token: set ${collector.tokenEnv} to the collector's READ_TOKEN`, response.status);
  if (!response.ok) throw new CollectorError(`collector ${method} ${path.split("?")[0]}: ${response.status} ${json.error ?? ""}`.trim(), response.status);
  return json;
}

/**
 * Sampled sessions. `query` holds the filters besides `project`, such as ["outcome", "error"] or ["seed", "7"].
 * @param {Collector} collector @param {[string, string][]} query @returns {Promise<Session[]>}
 */
export async function listSessions(collector, query) {
  const search = new URLSearchParams([["project", collector.project], ...query]);
  return (await call(collector, "GET", `/v1/sessions?${search}`)).sessions;
}

/** A case and the earlier cases of its session. @param {Collector} collector @param {string} id @returns {Promise<Session>} */
export async function getCase(collector, id) {
  return call(collector, "GET", `/v1/cases/${encodeURIComponent(id)}?${new URLSearchParams({ project: collector.project })}`);
}

/** @param {Collector} collector @param {string} release @param {{ session: string, pass: boolean }[]} results */
export async function postResults(collector, release, results) {
  return call(collector, "POST", "/v1/results", { project: collector.project, release, results });
}
