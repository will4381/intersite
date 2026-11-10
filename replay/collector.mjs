// @ts-check
/** The collector's read routes (CONTRACT.md "Collector HTTP API"), called with the read token. */

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {{ url: string, token: string, project: string }} Collector */
/** @typedef {{ session: string, cases: Case[] }} Session */

/** Hosts on this machine (or reserved for local testing). */
export const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$|\.(?:localhost|test)$/;

/** @param {Collector} collector @param {string} method @param {string} path @param {unknown} [body] */
async function call(collector, method, path, body) {
  const response = await fetch(collector.url.replace(/\/$/, "") + path, {
    method,
    headers: { authorization: `Bearer ${collector.token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    let local = false;
    try { local = LOCAL_HOST.test(new URL(collector.url).hostname); } catch { local = false; }
    throw new Error(`cannot reach the collector at ${collector.url}; ${local ? "start it with `intersite collector`" : "check collector.url in intersite.yml"}`);
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`collector ${method} ${path.split("?")[0]}: ${response.status} ${json.error ?? ""}`.trim());
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
