// @ts-check
// The collector Worker: routes and auth. Storage lives in store.mjs.
import { OUTCOMES } from "../shared/case.mjs";
import * as store from "./store.mjs";

const MAX_CASES = 50;
const MAX_SAMPLE = 200;

/** @typedef {{ DB: import("./store.mjs").D1, INGEST_TOKEN?: string, READ_TOKEN?: string, DAILY_CAP_OK?: string, DAILY_CAP_OTHER?: string }} Env */

/** @param {unknown} body @param {number} [status] */
const json = (body, status = 200) => Response.json(body, { status });
/** @param {string} message @param {number} status */
const fail = (message, status) => json({ error: message }, status);

const encoder = new TextEncoder();
/** Constant-time: compares SHA-256 digests, so lengths never differ. @param {string} given @param {string} secret */
async function same(given, secret) {
  const [a, b] = await Promise.all([given, secret].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))));
  return /** @type {any} */ (crypto.subtle).timingSafeEqual(a, b);
}

/** @param {Request} request @returns {Promise<any>} */
async function body(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** @param {unknown} value */
const isName = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (!env.INGEST_TOKEN || !env.READ_TOKEN) return fail("collector is not configured: set the INGEST_TOKEN and READ_TOKEN secrets", 503);

    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const [ingestToken, readToken] = await Promise.all([same(token, env.INGEST_TOKEN), same(token, env.READ_TOKEN)]);
    if (!ingestToken && !readToken) return fail("missing or wrong bearer token", 401);

    const now = Date.now();
    const route = `${request.method} ${url.pathname}`;

    if (route === "POST /v1/cases") {
      if (!ingestToken) return fail("this route needs the ingest token", 403);
      const input = await body(request);
      if (!Array.isArray(input?.cases)) return fail("body must be { cases: Case[] }", 400);
      if (input.cases.length > MAX_CASES) return fail(`at most ${MAX_CASES} cases per request`, 413);
      const cap = { ok: Number(env.DAILY_CAP_OK) || 5000, other: Number(env.DAILY_CAP_OTHER) || 5000 };
      return json(await store.ingest(env.DB, input.cases, cap, now));
    }

    if (!readToken) return fail("this route needs the read token", 403);

    if (route === "GET /v1/sessions") {
      const query = url.searchParams;
      const project = query.get("project");
      if (!isName(project)) return fail("project is required", 400);
      const outcomes = query.getAll("outcome");
      const unknown = outcomes.find((outcome) => !OUTCOMES.includes(/** @type {any} */ (outcome)));
      if (unknown !== undefined) return fail(`outcome must be one of ${OUTCOMES.join(", ")}`, 400);
      const since = query.has("since") ? Date.parse(/** @type {string} */ (query.get("since"))) : undefined;
      if (Number.isNaN(since)) return fail("since must be an ISO timestamp", 400);
      const seed = query.has("seed") ? Number(query.get("seed")) : Math.floor(Math.random() * 2 ** 32);
      if (!Number.isSafeInteger(seed)) return fail("seed must be an integer", 400);
      const sample = Math.min(MAX_SAMPLE, Math.max(1, Number.parseInt(query.get("sample") ?? "", 10) || 20));
      const found = await store.sessions(env.DB, {
        project: /** @type {string} */ (project),
        outcomes: [...new Set(outcomes)],
        route: query.get("route") ?? undefined,
        since,
        knownGood: query.get("known_good") === "1",
        sample,
        seed,
      });
      return json({ sessions: found });
    }

    if (route === "POST /v1/results") {
      const input = await body(request);
      const results = input?.results;
      if (!isName(input?.project) || typeof input.release !== "string" || !Array.isArray(results)) {
        return fail("body must be { project, release, results: { session, pass }[] }", 400);
      }
      if (results.length > MAX_SAMPLE) return fail(`at most ${MAX_SAMPLE} results per request`, 413);
      if (!results.every((result) => isName(result?.session) && typeof result.pass === "boolean")) {
        return fail("each result needs session (string) and pass (boolean)", 400);
      }
      return json({ recorded: await store.recordResults(env.DB, input.project, input.release, results, now) });
    }

    const caseRoute = /^\/v1\/cases\/([^/]+)(\/pin)?$/.exec(url.pathname);
    if (caseRoute) {
      const id = decodeURIComponent(caseRoute[1]);
      if (request.method === "GET" && !caseRoute[2]) {
        const project = url.searchParams.get("project");
        if (!isName(project)) return fail("project is required", 400);
        const found = await store.caseWithHistory(env.DB, /** @type {string} */ (project), id);
        return found ? json(found) : fail("case not found", 404);
      }
      if (request.method === "POST" && caseRoute[2]) {
        const input = await body(request);
        if (!isName(input?.project) || typeof input.pinned !== "boolean") return fail("body must be { project, pinned: boolean }", 400);
        const exists = await store.pin(env.DB, input.project, id, input.pinned);
        return exists ? json({ pinned: input.pinned }) : fail("case not found", 404);
      }
    }

    return fail("not found", 404);
  },

  /** Daily cron: delete expired data. @param {{ scheduledTime: number }} controller @param {Env} env */
  async scheduled(controller, env) {
    await store.cleanup(env.DB, controller.scheduledTime);
  },
};
