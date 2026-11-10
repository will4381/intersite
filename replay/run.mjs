// @ts-check
import { shapeDiff, shapeOf } from "../shared/shape.mjs";

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {"baseline" | "twice" | "cross-tenant"} Mode */
/**
 * The project's replay adapter (see CONTRACT.md "Replay adapter").
 * @typedef {object} Adapter
 * @property {(actorKind: string, options: { target: string, other: boolean }) => Promise<Record<string, string>>} signIn
 * @property {(id: string, options: { target: string }) => Promise<string | undefined>} [resolveId]
 * @property {(options: { target: string }) => Promise<void>} [reset]
 * @property {{ name: string, check: (options: { target: string, fetch: typeof fetch }) => Promise<string | undefined> }[]} [invariants]
 */
/**
 * @typedef {object} Step
 * @property {Mode} mode
 * @property {string} caseId
 * @property {string} method   "INVARIANT" for an adapter invariant, whose route is the invariant's name.
 * @property {string} route
 * @property {"passed" | "failed" | "skipped"} result
 * @property {string} [reason]
 */
/** @typedef {{ session: string, steps: Step[], skipped?: string }} SessionResult */

class Unresolved extends Error {}

/**
 * Replay each session against `target` in every mode and compare with what was recorded.
 * @param {{ sessions: { session: string, cases: Case[] }[], target: string, adapter: Adapter, modes: Mode[], idPattern: string, fetch?: typeof fetch }} options
 * @returns {Promise<SessionResult[]>}
 */
export async function replaySessions({ sessions, target, adapter, modes, idPattern, fetch = globalThis.fetch }) {
  const context = { target: target.replace(/\/$/, ""), adapter, pattern: new RegExp(idPattern), fetch };
  /** @type {SessionResult[]} */
  const results = [];
  for (const { session, cases } of sessions) {
    const ordered = [...cases].sort((a, b) => a.seq - b.seq);
    /** @type {SessionResult} */
    const result = { session, steps: [] };
    for (const mode of modes) {
      const skipped = await replayOnce(mode, ordered, result.steps, context);
      if (skipped && !result.skipped) result.skipped = skipped;
      const last = ordered.at(-1);
      if (mode !== "baseline" || !last || skipped) continue;
      for (const invariant of adapter.invariants ?? []) {
        const message = await invariant.check({ target: context.target, fetch });
        result.steps.push({
          mode, caseId: last.id, method: "INVARIANT", route: invariant.name,
          ...(message ? { result: "failed", reason: message } : { result: "passed" }),
        });
      }
    }
    results.push(result);
  }
  return results;
}

/**
 * One pass over a session in one mode. Returns the skip reason when an ID could not be resolved.
 * @param {Mode} mode @param {Case[]} cases @param {Step[]} steps
 * @param {{ target: string, adapter: Adapter, pattern: RegExp, fetch: typeof fetch }} context
 */
async function replayOnce(mode, cases, steps, { target, adapter, pattern, fetch }) {
  await adapter.reset?.({ target });
  /** @type {Map<string, string>} recorded ID -> replayed ID */
  const ids = new Map();
  /** @type {Map<string, Record<string, string>>} */
  const signedIn = new Map();
  /** @param {string} kind @param {boolean} other */
  const auth = async (kind, other) => {
    if (kind === "anonymous") return {};
    const key = `${kind}\0${other}`;
    if (!signedIn.has(key)) signedIn.set(key, await adapter.signIn(kind, { target, other }));
    return /** @type {Record<string, string>} */ (signedIn.get(key));
  };
  /** @param {Case["request"]} request @param {string} caseId @param {Record<string, string>} headers */
  const send = async (request, caseId, headers) => {
    const url = new URL(target + request.path);
    for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
    const hasBody = request.body !== undefined && request.body !== null && !["GET", "HEAD"].includes(request.method);
    const response = await fetch(url, {
      method: request.method,
      headers: { ...headers, "x-intersite-replay": caseId, ...(hasBody && { "content-type": "application/json" }) },
      body: hasBody ? JSON.stringify(request.body) : undefined,
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json };
  };

  for (const [index, item] of cases.entries()) {
    const { method } = item.request;
    const kind = item.actor.kind;
    /** @param {Case} which @param {Step["result"]} result @param {string} [reason] */
    const record = (which, result, reason) =>
      steps.push({ mode, caseId: which.id, method: which.request.method, route: which.request.route, result, ...(reason && { reason }) });

    /** @type {string[]} */
    const found = [];
    mapIds(item.request, pattern, (id) => (found.push(id), id));
    try {
      for (const id of found) {
        if (ids.has(id)) continue;
        if (!adapter.resolveId) throw new Unresolved(`${id} was not created by this session and the adapter has no resolveId`);
        const resolved = await adapter.resolveId(id, { target });
        if (resolved === undefined) throw new Unresolved(`resolveId gave nothing for ${id}`);
        ids.set(id, resolved);
      }
    } catch (error) {
      if (!(error instanceof Unresolved)) throw error;
      for (const rest of cases.slice(index)) if (counts(mode, rest, pattern)) record(rest, "skipped", error.message);
      return error.message;
    }
    const request = mapIds(item.request, pattern, (id) => /** @type {string} */ (ids.get(id)));

    // Another account's request goes first, so a leaky DELETE is not hidden by the owner's DELETE.
    if (mode === "cross-tenant" && counts(mode, item, pattern)) {
      const { status } = await send(request, item.id, await auth(kind, true));
      if ([401, 403, 404].includes(status)) record(item, "passed");
      else record(item, "failed", `another account got ${status}, expected 401, 403 or 404`);
    }

    const first = await send(request, item.id, await auth(kind, false));
    for (const [pointer, recordedId] of Object.entries(item.response.ids)) {
      const value = valueAt(first.json, pointer);
      if (typeof value === "string") ids.set(recordedId, value);
    }

    if (mode === "baseline") {
      const reason = first.status !== item.response.status
        ? `status recorded ${item.response.status}, got ${first.status}`
        : shapeDiff(item.response.shape, shapeOf(first.json));
      record(item, reason ? "failed" : "passed", reason);
    }
    if (mode === "twice" && method !== "GET") {
      const second = await send(request, item.id, await auth(kind, false));
      if (second.status >= 500) record(item, "failed", `second send got ${second.status}, first got ${first.status}`);
      else record(item, "passed");
    }
  }
  return undefined;
}

/**
 * Whether a case is a step in this mode. Cross-tenant only checks requests that name a record: another account
 * may legitimately create in its own account.
 * @param {Mode} mode @param {Case} item @param {RegExp} pattern
 */
function counts(mode, item, pattern) {
  if (mode === "twice") return item.request.method !== "GET";
  if (mode === "cross-tenant") {
    if (item.actor.kind === "anonymous") return false;
    let named = false;
    mapIds(item.request, pattern, (id) => ((named = true), id));
    return named;
  }
  return true;
}

/**
 * A copy of the request with every ID-looking path segment, query value and body string passed through `swap`.
 * @param {Case["request"]} request @param {RegExp} pattern @param {(id: string) => string} swap
 * @returns {Case["request"]}
 */
function mapIds(request, pattern, swap) {
  /** @param {unknown} value @returns {any} */
  const one = (value) => (typeof value === "string" && pattern.test(value) ? swap(value) : value);
  /** @param {unknown} value @returns {unknown} */
  const deep = (value) => {
    if (Array.isArray(value)) return value.map(deep);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]));
    return one(value);
  };
  return {
    ...request,
    path: request.path.split("/").map(one).join("/"),
    query: Object.fromEntries(Object.entries(request.query).map(([key, value]) => [key, one(value)])),
    body: deep(request.body),
  };
}

/** The value at a pointer written by `idsOf` ("/" is the root; keys are not escaped). @param {unknown} json @param {string} pointer */
function valueAt(json, pointer) {
  if (pointer === "/") return json;
  return pointer.slice(1).split("/").reduce((/** @type {any} */ value, key) => value?.[key], json);
}
