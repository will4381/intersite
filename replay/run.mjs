// @ts-check
import { UI_METHOD } from "../shared/case.mjs";
import { idsOf, shapeDiff, shapeOf } from "../shared/shape.mjs";
import { countersOf } from "./metrics.mjs";
import { idMatcher, normalise } from "./snapshot.mjs";

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {"baseline" | "twice" | "cross-tenant" | "ui" | "contract"} Mode */
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
 * @property {string} method   "INVARIANT" for an adapter invariant, whose route is the invariant's name. In `ui` mode, the action name.
 * @property {string} route    In `ui` mode, the page.
 * @property {"passed" | "failed" | "skipped"} result
 * @property {string} [reason]
 * @property {string} [sent]   On a failed request step: "METHOD path body" as sent, at most 500 characters.
 * @property {string} [got]    On a failed request step: "status body" as answered, at most 500 characters.
 * @property {Record<string, number>} [counters] On a baseline step: the counters the server reported in `Server-Timing`.
 * @property {"presence"} [checked] On a `ui` write action that could not be filled from the recorded body: only its presence was checked.
 */
/**
 * @typedef {{ session: string, steps: Step[], skipped?: string, snapshot?: import("./snapshot.mjs").Snapshot, live?: Record<string, import("./contract.mjs").Live> }} SessionResult
 * `snapshot`, with the `snapshots` option: each baseline case's status and body, normalised. `live`, in the `contract`
 * mode: what the server answered each case, for the contract lint.
 */
/** @typedef {{ target: string, adapter: Adapter, pattern: RegExp, fetch: typeof fetch, startedAt: number | undefined, snapshots: boolean, contract: boolean }} Context */
/**
 * One pass over a session in one mode. `known` holds every ID sent or answered so far; `mine` the IDs the owner's
 * writes produced, `theirs` those another account's writes produced.
 * @typedef {{ mode: Mode, steps: Step[], send: ReturnType<typeof sender>, auth: ReturnType<typeof signer>, pattern: RegExp,
 *   known: Set<string>, mine: Set<string>, theirs: Set<string> }} Pass
 */

const DAY = 86_400_000;
const CLIP = 500;

/** Whether anything answers HTTP at this URL, whatever the status. @param {string} url */
export function answers(url) {
  return fetch(url, { signal: AbortSignal.timeout(3000) }).then((response) => (response.body?.cancel(), true), () => false);
}

/**
 * Replay each session against `target` in every mode and compare with what was recorded.
 * `concurrency` sessions run at once, except when the adapter has `reset` (shared state), when they run one at a time.
 * @param {{ sessions: { session: string, cases: Case[] }[], target: string, adapter: Adapter, modes: Mode[], idPattern: string,
 *   fetch?: typeof fetch, shiftDates?: boolean, now?: number, concurrency?: number, uiTarget?: string, headed?: boolean, cwd?: string,
 *   browser?: string, browserUrl?: string, snapshots?: boolean }} options
 * @returns {Promise<SessionResult[]>}
 */
export async function replaySessions({
  sessions, target, adapter, modes, idPattern, fetch = globalThis.fetch,
  shiftDates = true, now = Date.now(), concurrency = 1, uiTarget = "", headed = false, cwd = process.cwd(), browser, browserUrl, snapshots = false,
}) {
  /** @type {Context} */
  const context = {
    target: target.replace(/\/$/, ""), adapter, pattern: new RegExp(idPattern), fetch, startedAt: shiftDates ? now : undefined, snapshots, contract: modes.includes("contract"),
  };
  const ui = modes.includes("ui") ? await (await import("./ui.mjs")).openBrowser({ uiTarget, headed, cwd, browser, browserUrl }) : undefined;
  try {
    /** @type {SessionResult[]} */
    const results = Array(sessions.length);
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < sessions.length; index = next++) results[index] = await replaySession(sessions[index], modes, context, ui);
    };
    const workers = adapter.reset ? 1 : Math.max(1, Math.min(concurrency, sessions.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
  } finally {
    await ui?.close();
  }
}

/**
 * @param {{ session: string, cases: Case[] }} session @param {Mode[]} modes @param {Context} context
 * @param {Awaited<ReturnType<typeof import("./ui.mjs").openBrowser>> | undefined} ui
 */
async function replaySession({ session, cases }, modes, context, ui) {
  const ordered = [...cases].sort((a, b) => a.seq - b.seq);
  const api = ordered.filter((item) => item.request.method !== UI_METHOD);
  /** @type {SessionResult} */
  const result = { session, steps: [] };
  // With baseline in the run, the contract lint reads the baseline answers instead of sending everything again.
  for (const mode of modes.filter((item) => item !== "contract" || !modes.includes("baseline"))) {
    const skipped = mode === "ui" && ui ? await ui.replay(ordered, result.steps, context) : await replayOnce(mode, api, result, context);
    if (skipped && !result.skipped) result.skipped = skipped;
    const last = api.at(-1);
    if (mode !== "baseline" || !last || skipped) continue;
    for (const invariant of context.adapter.invariants ?? []) {
      const message = await invariant.check({ target: context.target, fetch: context.fetch });
      result.steps.push({
        mode, caseId: last.id, method: "INVARIANT", route: invariant.name,
        ...(message ? { result: "failed", reason: message } : { result: "passed" }),
      });
    }
  }
  return result;
}

/**
 * One pass over a session in one API mode. Returns the skip reason when an ID could not be resolved.
 * @param {Mode} mode @param {Case[]} cases @param {SessionResult} result @param {Context} context
 */
async function replayOnce(mode, cases, result, context) {
  const { target, adapter, pattern } = context;
  await adapter.reset?.({ target });
  /** @type {Map<string, string>} recorded ID -> replayed ID */
  const ids = new Map();
  /** @type {Pass} */
  const pass = { mode, steps: result.steps, send: sender(context), auth: signer(context), pattern, known: new Set(), mine: new Set(), theirs: new Set() };
  const snapshot = context.snapshots && mode === "baseline" ? { created: pass.mine, numbers: new Map(), from: Date.now() } : undefined;

  for (const [index, item] of cases.entries()) {
    const { method } = item.request;
    const kind = item.actor.kind;
    const prepared = await prepare(item, ids, context);
    if (prepared.skip !== undefined) {
      for (const rest of cases.slice(index)) if (counts(mode, rest, pattern)) record(pass, rest, "skipped", prepared.skip);
      return prepared.skip;
    }
    const { request } = prepared;
    mapIds(request, pattern, (id) => (pass.known.add(id), id));

    // Another account's request goes first, so a leaky DELETE is not hidden by the owner's DELETE.
    if (mode === "cross-tenant") await asOtherAccount(item, request, pass);

    const headers = await pass.auth(kind, false);
    const first = await pass.send(request, item, headers);
    learnIds(item, first.json, ids);
    if (context.contract && (mode === "baseline" || mode === "contract")) {
      (result.live ??= {})[item.id] = { status: first.status, json: first.json, text: first.text, contentType: first.contentType, sent: Object.values(headers) };
    }
    const foreign = noteIds(first.json, method, pass, pass.mine).find((id) => pass.theirs.has(id));
    if (foreign) record(pass, item, "failed", `this session's response contains ${foreign}, created by another account`, first.exchange);

    if (mode === "baseline") {
      const reason = baselineReason(item, first);
      record(pass, item, reason ? "failed" : "passed", reason, first.exchange);
      if (Object.keys(first.counters).length) /** @type {Step} */ (pass.steps.at(-1)).counters = first.counters;
      if (snapshot) (result.snapshot ??= {})[item.id] = { status: first.status, body: normalise(first.json ?? null, snapshot) };
    }
    if (mode === "twice" && method !== "GET") {
      const second = await pass.send(request, item, await pass.auth(kind, false));
      if (second.status >= 500 || second.status === 0) record(pass, item, "failed", `second send got ${second.status}, first got ${first.status}`, second.exchange);
      else record(pass, item, "passed");
    }
  }
  return undefined;
}

/**
 * The cross-tenant checks of one case, sent as a user of another account. A request that names an ID must be refused.
 * A GET that names none (a list, search or dashboard) must not answer with an ID this session created earlier: shared
 * records (a catalogue, plans) appear for both accounts, so only IDs the owner's own writes produced count.
 * @param {Case} item @param {Case["request"]} request @param {Pass} pass
 */
async function asOtherAccount(item, request, pass) {
  const { method } = item.request;
  if (counts("cross-tenant", item, pass.pattern)) {
    const { status, json, exchange } = await pass.send(request, item, await pass.auth(item.actor.kind, true));
    noteIds(json, method, pass, pass.theirs);
    if ([401, 403, 404].includes(status)) record(pass, item, "passed");
    else record(pass, item, "failed", `another account got ${status}, expected 401, 403 or 404`, exchange);
    return;
  }
  if (item.actor.kind === "anonymous" || method !== "GET" || !pass.mine.size) return;
  const { json, exchange } = await pass.send(request, item, await pass.auth(item.actor.kind, true));
  const leaked = [...new Set(JSON.stringify(json ?? null).match(/** @type {RegExp} */ (idMatcher(pass.mine))))];
  if (!leaked.length) return record(pass, item, "passed");
  const more = leaked.length > 1 ? ` (and ${leaked.length - 1} more)` : "";
  record(pass, item, "failed", `another account's response contains ${leaked[0]}${more}, created by this session`, exchange);
}

/**
 * Adds each ID in an answer to `pass.known`; on a write, each one not known before also goes to `created` (the IDs
 * the write produced). Returns every ID in the answer.
 * @param {unknown} json @param {string} method @param {Pass} pass @param {Set<string>} created
 */
function noteIds(json, method, pass, created) {
  const found = Object.values(idsOf(json, pass.pattern));
  for (const id of found) {
    if (!pass.known.has(id) && method !== "GET") created.add(id);
    pass.known.add(id);
  }
  return found;
}

/** @param {Pass} pass @param {Case} which @param {Step["result"]} result @param {string} [reason] @param {{ sent: string, got: string }} [exchange] */
function record(pass, which, result, reason, exchange) {
  pass.steps.push({
    mode: pass.mode, caseId: which.id, method: which.request.method, route: which.request.route, result,
    ...(reason && { reason }), ...(result === "failed" && exchange),
  });
}

/** Headers for each actor kind, signed in once per pass. @param {Context} context */
function signer({ adapter, target }) {
  /** @type {Map<string, Record<string, string>>} */
  const signedIn = new Map();
  /** @param {string} kind @param {boolean} other */
  return async (kind, other) => {
    if (kind === "anonymous") return {};
    const key = `${kind}\0${other}`;
    if (!signedIn.has(key)) signedIn.set(key, await adapter.signIn(kind, { target, other }));
    return /** @type {Record<string, string>} */ (signedIn.get(key));
  };
}

/** Sends a prepared request and reads the answer. @param {Context} context */
function sender({ target, fetch }) {
  /** @param {Case["request"]} request @param {Case} item @param {Record<string, string>} headers */
  return async (request, item, headers) => {
    const url = new URL(target + request.path);
    for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
    const hasBody = request.body !== undefined && request.body !== null && !["GET", "HEAD"].includes(request.method);
    const body = hasBody ? JSON.stringify(request.body) : undefined;
    const sent = clip(`${request.method} ${url.pathname}${url.search}${body ? ` ${body}` : ""}`);
    const headersSent = { ...headers, "x-intersite-replay": item.id, "x-intersite-time": item.at, ...(hasBody && { "content-type": "application/json" }) };
    // A dropped connection is the server failing this request (it crashed or hung up), not a setup error: status 0.
    const response = await fetch(url, { method: request.method, headers: headersSent, body }).catch((/** @type {Error} */ error) => error);
    if (response instanceof Error) {
      const cause = /** @type {{ code?: string }} */ (response.cause)?.code ?? response.message;
      return { status: 0, json: undefined, text: "", contentType: "", exchange: { sent, got: `no answer (${cause})` }, counters: {} };
    }
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return {
      status: response.status, json, text, contentType: response.headers.get("content-type") ?? "",
      exchange: { sent, got: clip(`${response.status} ${text}`) }, counters: countersOf(response.headers.get("server-timing")),
    };
  };
}

/**
 * Why a baseline step failed, or undefined when it passed: the same status and response shape as recorded. A server
 * error production recorded is a bug, not the answer to keep: that step fails while the replay still gets a 5xx or no
 * answer (the reproduction), and passes once it does not (the fix), whatever the new status and shape.
 * @param {Case} item @param {{ status: number, json: unknown, exchange: { got: string } }} answer
 */
function baselineReason(item, answer) {
  const recorded = item.response.status;
  const got = answer.status === 0 ? answer.exchange.got : answer.status;
  if (recorded >= 500) return answer.status >= 500 || answer.status === 0 ? `still fails as production did: status recorded ${recorded}, got ${got}` : undefined;
  if (answer.status !== recorded) return `status recorded ${recorded}, got ${got}`;
  return shapeDiff(item.response.shape, shapeOf(answer.json));
}

/**
 * The case's request with IDs swapped for replayed ones (created earlier in the session, or from `resolveId`) and,
 * with `shiftDates`, dates moved forward. Returns `skip` when an ID cannot be resolved.
 * @param {Case} item @param {Map<string, string>} ids recorded ID -> replayed ID, filled as IDs are resolved
 * @param {Context} context
 * @returns {Promise<{ request: Case["request"], skip?: undefined } | { skip: string }>}
 */
export async function prepare(item, ids, { target, adapter, pattern, startedAt }) {
  /** @type {string[]} */
  const found = [];
  mapIds(item.request, pattern, (id) => (found.push(id), id));
  const skip = await resolveIds(found, ids, { target, adapter });
  if (skip) return { skip };
  const request = mapIds(item.request, pattern, (id) => /** @type {string} */ (ids.get(id)));
  if (startedAt === undefined) return { request };
  const shift = (/** @type {unknown} */ value) => (typeof value === "string" ? shiftDate(value, startedAt - Date.parse(item.at)) : value);
  return { request: { ...request, query: mapValues(request.query, shift), body: deep(request.body, shift) } };
}

/**
 * Adds each ID not yet in `ids` from `resolveId`. Returns why one could not be resolved.
 * @param {string[]} found @param {Map<string, string>} ids @param {{ target: string, adapter: Adapter }} context
 */
export async function resolveIds(found, ids, { target, adapter }) {
  for (const id of found) {
    if (ids.has(id)) continue;
    if (!adapter.resolveId) return `${id} was not created by this session and the adapter has no resolveId`;
    const resolved = await adapter.resolveId(id, { target });
    if (resolved === undefined) return `resolveId gave nothing for ${id}`;
    ids.set(id, resolved);
  }
  return undefined;
}

/** Maps each ID the recorded response created to the one at the same pointer in the replayed answer. @param {Case} item @param {unknown} json @param {Map<string, string>} ids */
export function learnIds(item, json, ids) {
  for (const [pointer, recordedId] of Object.entries(item.response.ids)) {
    const value = valueAt(json, pointer);
    if (typeof value === "string") ids.set(recordedId, value);
  }
}

/**
 * Whether a case is a step in this mode. Cross-tenant only checks requests that name a record: another account
 * may legitimately create in its own account. The contract mode reports per route, not per step.
 * @param {Mode} mode @param {Case} item @param {RegExp} pattern
 */
function counts(mode, item, pattern) {
  if (mode === "contract") return false;
  if (mode === "twice") return item.request.method !== "GET";
  if (mode === "cross-tenant") {
    if (item.actor.kind === "anonymous") return false;
    let named = false;
    mapIds(item.request, pattern, (id) => ((named = true), id));
    return named;
  }
  return true;
}

/** Every leaf of a JSON value passed through `swap`. @param {unknown} value @param {(leaf: unknown) => unknown} swap @returns {unknown} */
function deep(value, swap) {
  if (Array.isArray(value)) return value.map((item) => deep(item, swap));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v, swap)]));
  return swap(value);
}

/** @param {Record<string, string>} record @param {(value: string) => unknown} swap @returns {Record<string, string>} */
function mapValues(record, swap) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, /** @type {string} */ (swap(value))]));
}

/**
 * A copy of the request with every ID-looking path segment, query value and body string passed through `swap`.
 * @param {Case["request"]} request @param {RegExp} pattern @param {(id: string) => string} swap
 * @returns {Case["request"]}
 */
function mapIds(request, pattern, swap) {
  /** @param {unknown} value */
  const one = (value) => (typeof value === "string" && pattern.test(value) ? swap(value) : value);
  return {
    ...request,
    path: request.path.split("/").map((segment) => /** @type {string} */ (one(segment))).join("/"),
    query: mapValues(request.query, one),
    body: deep(request.body, one),
  };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * An ISO date or timestamp moved `delta` ms later, written in the same format: a date-only value moves by whole days,
 * and a timestamp keeps its precision and its zone (the wall time in that zone moves by `delta`). Anything else is
 * returned unchanged.
 * @param {string} value @param {number} delta
 */
function shiftDate(value, delta) {
  const match = ISO_DATE.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const millis = Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0), millis);
  if (new Date(wall).getUTCDate() !== Number(day)) return value;
  if (hour === undefined) return new Date(wall + Math.round(delta / DAY) * DAY).toISOString().slice(0, 10);
  // ponytail: sub-millisecond digits become zeros; keep them as text if a project ever needs microseconds.
  const iso = new Date(wall + delta).toISOString();
  return iso.slice(0, 16) + (second === undefined ? "" : iso.slice(16, 19))
    + (fraction === undefined ? "" : `.${iso.slice(20, 23).padEnd(fraction.length, "0").slice(0, fraction.length)}`) + (zone ?? "");
}

/** @param {string} text */
function clip(text) {
  return text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text;
}

/** The value at a pointer written by `idsOf` ("/" is the root; keys are not escaped). @param {unknown} json @param {string} pointer */
function valueAt(json, pointer) {
  if (pointer === "/") return json;
  return pointer.slice(1).split("/").reduce((/** @type {any} */ value, key) => value?.[key], json);
}
