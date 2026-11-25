// @ts-check

/**
 * Capture: samples real API requests in production, scrubs them, and sends each as a case to the collector.
 * `record` never rejects and never touches the response the caller returns. An unsampled `ok` request costs one
 * small synchronous hash: nothing is cloned or read.
 *
 * @example Cloudflare Worker
 * import { createCapture } from "intersite/capture";
 * export default {
 *   async fetch(request, env, ctx) {
 *     const capture = createCapture({ project: "acme", url: env.INTERSITE_URL, token: env.INTERSITE_INGEST_TOKEN, release: env.RELEASE });
 *     const copy = request.clone();
 *     const { response, route, user } = await handle(request, env); // your router
 *     ctx.waitUntil(capture.record({ request: copy, response, route, actor: { kind: user?.role ?? "anonymous" }, session: user?.id }));
 *     return response;
 *   },
 * };
 *
 * @example Fastify (plain objects; `payload` is the serialized body). In Node, `captureOptions()` from
 * "intersite/shared/config" supplies `project` and intersite.yml's `capture` section (exclude, redactKeys, keepKeys).
 * const capture = createCapture({ ...captureOptions(), url: process.env.INTERSITE_URL, token: process.env.INTERSITE_INGEST_TOKEN, release: process.env.RELEASE });
 * fastify.addHook("onSend", async (request, reply, payload) => {
 *   capture.record({ request: { method: request.method, url: request.url, headers: request.headers, body: request.body },
 *     response: { status: reply.statusCode, headers: reply.getHeaders(), body: payload },
 *     route: request.routeOptions.url, actor: { kind: request.user?.role ?? "anonymous" }, session: request.user?.id });
 *   return payload;
 * });
 *
 * @example Next.js route handler (`after` from "next/server"; call `record` before returning, so it can clone)
 * export async function POST(request) {
 *   const copy = request.clone();
 *   const response = await handle(request);
 *   after(capture.record({ request: copy, response, route: "/api/programs", actor: { kind: "user" } }));
 *   return response;
 * }
 */

import { ACTION_NAME, ERROR_NAME, OUTCOMES, UI_METHOD, caseProblem, reducePage as reduce, stepProblem } from "../shared/case.mjs";
import { DEFAULT_ID_PATTERN, idsOf, shapeOf } from "../shared/shape.mjs";
import { createScrubber } from "./scrub.mjs";

const DEFAULT_TTL_DAYS = { ok: 14, warn: 90, rejected: 30, error: 90 };
// ponytail: response bodies over 1 MiB are recorded with shape "null", make it an option if large list endpoints matter.
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 3000;
const MAX_BATCH = 50;
const enc = new TextEncoder();

/**
 * @typedef {object} CaptureOptions
 * @property {string} project
 * @property {string} url        Collector base URL.
 * @property {string} token      Ingest token.
 * @property {{ fetch: typeof fetch }} [fetcher]  A Workers service binding to use instead of global fetch.
 * @property {string} release
 * @property {string} [salt]     Defaults to `token`.
 * @property {number} [sample]
 * @property {number} [maxBodyBytes]
 * @property {string[]} [include]
 * @property {string[]} [exclude]
 * @property {string[]} [redactKeys]  Keys whose values are always replaced, on top of the built-in list.
 * @property {string[]} [keepKeys]    Keys whose short codes and dates are kept, on top of the built-in structural and
 *                                    date words (`status`, `createdAt`). `redactKeys` and the sensitive list win.
 * @property {string} [idPattern]
 * @property {Partial<Record<"ok" | "warn" | "rejected" | "error", number>>} [ttlDays]
 */

/**
 * Headers as a `Headers` or a plain object with lowercase keys (as Node servers give them).
 * @typedef {Headers | Record<string, string | string[] | number | undefined>} HeaderBag
 */

/** @typedef {{ method: string, url: string, headers?: HeaderBag, body?: unknown }} PlainRequest  `url` may be a path; `body` is parsed JSON or a JSON string. */
/** @typedef {{ status: number, headers?: HeaderBag, body?: unknown }} PlainResponse */

/**
 * @typedef {object} RecordInput
 * @property {Request | PlainRequest} request   A Request clone taken before handling (body unread), or a plain object.
 * @property {Response | PlainResponse} response The response being returned; a Response is cloned only when sampled.
 * @property {string} route      Route template such as `/v1/programs/:id`.
 * @property {{ kind: string }} [actor]
 * @property {string} [session]  A stable caller identifier; only its salted daily hash is stored. Defaults to the
 *                               `x-intersite-session` header; with neither, the request is a session of its own.
 * @property {"ok" | "warn" | "rejected" | "error"} [outcome]
 * @property {string} [id]
 * @property {string | Date} [at]
 */

/**
 * @typedef {object} UiInput
 * @property {string} page        Browser path; reduced again here.
 * @property {string} [name]      Action name, when the event happened during one.
 * @property {"ok" | "warn" | "rejected" | "error"} outcome
 * @property {string} [errorName] Such as `TypeError`. Never the message.
 * @property {string} [session]
 * @property {{ kind: string }} [actor]
 * @property {string} [release]
 * @property {import("../shared/case.mjs").UiStep} [step]  A step the tracker reported (`steps: true`); dropped when malformed.
 */

/** @typedef {{ route: string, actor?: { kind: string }, session?: string } | undefined} Described */

/** `*` is one path segment, `**` is any depth. @param {string} glob */
function globToRegExp(glob) {
  const source = glob.replace(/\/\*\*|\*\*|\*|[.+?^${}()|[\]\\]/g, (part) => {
    if (part === "/**") return "(?:/.*)?";
    if (part === "**") return ".*";
    return part === "*" ? "[^/]+" : `\\${part}`;
  });
  return new RegExp(`^${source}$`);
}

const MOUNT = /^(?:[a-z]{1,20}|v\d{1,3})$/;

/**
 * The route template's segments lined up with the path's. A server mounted under a prefix (`/api/v1/me` for the route
 * `/v1/me`) has extra leading segments: the template is matched against the path's tail, and a prefix segment that is a
 * short lowercase word or a version stands for itself; anything else in it is scrubbed like a value.
 * @param {string[]} segments @param {string[]} template
 */
function templateFor(segments, template) {
  const extra = segments.length - template.length;
  if (extra <= 0) return template;
  const [root, ...rest] = template;
  if (rest.some((part, index) => !part.startsWith(":") && part !== segments[extra + 1 + index])) return template;
  // A prefix word maps to itself (kept as is); anything else maps to nothing, which never equals it (scrubbed).
  return [root, ...segments.slice(1, extra + 1).map((segment) => (MOUNT.test(segment) ? segment : ":")), ...rest];
}

/** cyrb53: a fast 53-bit non-cryptographic hash, used only for the sampling decision. @param {string} text */
function quickHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** @param {unknown} message @returns {message is Request | Response} */
const isFetchMessage = (message) => typeof (/** @type {{ arrayBuffer?: unknown }} */ (message)?.arrayBuffer) === "function";

/** @param {HeaderBag | undefined} headers @param {string} name @returns {string | null} */
function header(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  if (typeof headers.get === "function") return /** @type {Headers} */ (headers).get(name);
  const value = /** @type {Record<string, unknown>} */ (headers)[name];
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** @param {unknown} body */
function discard(body) {
  const stream = /** @type {ReadableStream | undefined} */ (body);
  // oxlint-disable-next-line intersite/no-empty-catch -- cancelling a body that already closed can reject; nothing to recover
  if (typeof stream?.cancel === "function" && !stream.locked) stream.cancel().catch(() => {});
}

/** Plain JSON data only: a Buffer or class instance under a body is not something the scrubber understands. @param {unknown} value */
function isJsonData(value) {
  if (Array.isArray(value) || ["number", "boolean"].includes(typeof value)) return true;
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads at most `limit` bytes; undefined when the stream is longer. @param {ReadableStream<Uint8Array>} stream @param {number} limit */
async function readLimited(stream, limit) {
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      // oxlint-disable-next-line intersite/no-empty-catch -- the oversized body is being dropped either way
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * @param {Request | Response | PlainRequest | PlainResponse} message @param {number} limit
 * @returns {Promise<{ json: unknown } | { omitted: "not json" | "too large" }>}
 */
async function readJson(message, limit) {
  const plain = !isFetchMessage(message);
  const body = message.body;
  if (body === undefined || body === null || (plain && body === "")) return { json: null };
  const type = header(message.headers, "content-type");
  // A Request or Response must say it is JSON; a plain object with no content-type is trusted to be parsed JSON.
  if (type === null ? !plain : !/\bjson\b/i.test(type)) return { omitted: "not json" };
  if (Number(header(message.headers, "content-length")) > limit) return { omitted: "too large" };
  let text;
  if (plain) {
    text = typeof body === "string" ? body : isJsonData(body) ? JSON.stringify(body) : undefined;
    if (text === undefined) return { omitted: "not json" };
    if (enc.encode(text).byteLength > limit) return { omitted: "too large" };
  } else {
    text = await readLimited(/** @type {ReadableStream<Uint8Array>} */ (body), limit);
    if (text === undefined) return { omitted: "too large" };
  }
  if (text.trim() === "") return { json: null };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { omitted: "not json" };
  }
}

/** Gives up on a case that takes too long to build (a stalled body), so it cannot hold its batch. @template T @param {Promise<T>} promise */
function withDeadline(promise) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, TIMEOUT_MS, undefined);
  });
  return /** @type {Promise<T | undefined>} */ (Promise.race([promise, late])).finally(() => clearTimeout(timer));
}

const resolved = Promise.resolve();

// ponytail: one warning per isolate or process, so a broken setup is visible without a line per request; a capture
// that recovers stays quiet. Make it per endpoint if one process ever sends to two collectors.
let warned = false;
/** @param {string} endpoint @param {unknown} error */
function warnUndelivered(endpoint, error) {
  if (warned) return;
  warned = true;
  console.error(`intersite capture: cases are not reaching ${endpoint} (${error instanceof Error ? error.message : error}); check the collector URL and token, and that this runtime may call it`);
}

/** @param {string} reason */
const disabled = (reason) => {
  console.error(`intersite capture disabled: ${reason}`);
  return {
    record: () => resolved,
    recordUi: () => resolved,
    /** @param {typeof fetch} fetcher */
    wrapFetch: (fetcher) => fetcher,
  };
};

/**
 * The settings and batch queue one capture works from.
 * @param {CaptureOptions} options
 */
function captureState(options) {
  const { project, url, token, fetcher, release } = options;
  const salt = options.salt ?? token;
  const idPattern = new RegExp(options.idPattern ?? DEFAULT_ID_PATTERN);
  return {
    project,
    token,
    fetcher,
    release,
    salt,
    idPattern,
    sample: options.sample ?? 0.05,
    maxBodyBytes: options.maxBodyBytes ?? 32_768,
    include: (options.include ?? ["/**"]).map(globToRegExp),
    exclude: (options.exclude ?? []).map(globToRegExp),
    ttlDays: { ...DEFAULT_TTL_DAYS, ...options.ttlDays },
    scrubber: createScrubber({ salt, idPattern: idPattern.source, redactKeys: options.redactKeys, keepKeys: options.keepKeys }),
    endpoint: `${url.replace(/\/+$/, "")}/v1/cases`,
    // ponytail: the queue lives in this capture instance and flushes on a timer; in a Worker build one per request (as in
    // the example), since workerd forbids I/O across request contexts. A shared cross-request queue needs waitUntil plumbing.
    /** @type {{ item: Promise<unknown>, done: () => void }[]} */
    queue: [],
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    timer: undefined,
  };
}

/** @typedef {ReturnType<typeof captureState>} Capture */

/**
 * Synchronous, so an unsampled request costs nothing else. Whole sessions per UTC day.
 * @param {Capture} capture @param {string} outcome @param {string} session @param {number} ms
 */
const sampled = (capture, outcome, session, ms) =>
  outcome !== "ok" ||
  (Number.isFinite(ms) && quickHash(`${capture.salt}|${session}|${Math.floor(ms / 86_400_000)}`) / 2 ** 53 < capture.sample);

/** Every segment that is not an ID or a short lowercase word becomes `_`. Never trusts the client's reduction. @param {Capture} capture @param {unknown} page */
function reducePage(capture, page) {
  if (typeof page !== "string" || !page.startsWith("/") || page.length > 2048) return undefined;
  const reduced = reduce(page, capture.scrubber.isId);
  return reduced.length <= 256 ? reduced : undefined;
}

/** @param {Capture} capture @param {unknown} name @param {unknown} page */
function actionOf(capture, name, page) {
  const reduced = reducePage(capture, page);
  return typeof name === "string" && ACTION_NAME.test(name) && reduced ? { action: { name, page: reduced } } : {};
}

/** The tab's step that caused a request, from its `x-intersite-step` header. @param {string | null} value */
function stepOf(value) {
  const step = { n: Number(value) };
  return value !== null && /^\d{1,7}$/.test(value) && !stepProblem(step, false) ? { step } : {};
}

/** @param {{ kind: string } | undefined} actor */
const actorOf = (actor) => ({ kind: /^[a-z][a-z0-9_-]{0,31}$/.test(actor?.kind ?? "") ? /** @type {{ kind: string }} */ (actor).kind : "unknown" });

/**
 * Fields every case shares. `session` is the raw caller value; only its salted daily HMAC is stored.
 * @param {Capture} capture @param {string} rawSession @param {string} at @param {string} outcome @param {string} id
 */
async function base(capture, rawSession, at, outcome, id) {
  return {
    v: /** @type {1} */ (1),
    id,
    project: capture.project,
    session: (await capture.scrubber.hash(`${rawSession}|${at.slice(0, 10)}`)).slice(0, 32),
    seq: Date.parse(at),
    at,
    release: capture.release,
    outcome: /** @type {import("../shared/case.mjs").Case["outcome"]} */ (outcome),
    ttlDays: capture.ttlDays[/** @type {keyof Capture["ttlDays"]} */ (outcome)],
  };
}

/** POSTs one batch of built cases. @param {Capture} capture @param {unknown[]} cases */
async function send(capture, cases) {
  if (cases.length === 0) return;
  // A timer, not AbortSignal.timeout: Node does not wait for that one, so a process with nothing else to do would exit
  // with record() still pending and its cases lost.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), TIMEOUT_MS);
  try {
    const sent = await (capture.fetcher ?? globalThis).fetch(capture.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${capture.token}` },
      body: JSON.stringify({ cases }),
      signal: abort.signal,
    });
    discard(sent.body);
    if (!sent.ok) throw new Error(`the collector answered ${sent.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Sends up to 50 queued cases as one POST. Entries join a batch when `record` is called, so one tick's cases share a POST. @param {Capture} capture */
function flush(capture) {
  clearTimeout(capture.timer);
  capture.timer = undefined;
  const batch = capture.queue.slice(0, MAX_BATCH);
  capture.queue = capture.queue.slice(MAX_BATCH);
  if (capture.queue.length > 0) capture.timer = setTimeout(() => flush(capture), 0);
  if (batch.length === 0) return;
  Promise.all(batch.map((entry) => withDeadline(entry.item)))
    .then((items) => send(capture, items.filter((item) => item !== undefined)))
    // A failed send drops its cases: record() must never reject into the request it observes.
    .catch((error) => warnUndelivered(capture.endpoint, error))
    .finally(() => {
      for (const entry of batch) entry.done();
    });
}

/** @param {Capture} capture @param {Promise<unknown>} build A case, or undefined to drop it. @returns {Promise<void>} */
function enqueue(capture, build) {
  // A case that fails to build is dropped, never surfaced: capture must not disturb the request it observes.
  const dropped = () => undefined;
  const item = build.then((value) => (caseProblem(value) ? undefined : value)).catch(dropped);
  return new Promise((done) => {
    capture.queue.push({ item, done: () => done(undefined) });
    if (capture.queue.length >= MAX_BATCH) flush(capture);
    else capture.timer ??= setTimeout(() => flush(capture), 0);
  });
}

/**
 * The path's segments, each one that is not the route's own literal scrubbed under its parameter's name. Not async, so
 * awaiting it costs no extra tick: workerd refuses to read the request body once the response is sent, so `build` must
 * reach `readJson(request)` within the same few microtasks it always has.
 * @param {Capture} capture @param {string[]} segments @param {string} route
 */
function scrubPath(capture, segments, route) {
  const routeParts = templateFor(segments, route.split("/"));
  return Promise.all(
    segments.map(async (segment, index) => {
      const template = routeParts[index];
      if (segment === "" || (segment === template && !template.startsWith(":"))) return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        decoded = segment;
      }
      const scrubbed = await capture.scrubber.scrub(decoded, template?.startsWith(":") ? template.slice(1) : "");
      return encodeURIComponent(String(scrubbed));
    }),
  );
}

/**
 * @param {Capture} capture @param {RecordInput} input @param {Request | PlainRequest} request @param {Response | PlainResponse} response
 * @param {{ status: number, outcome: string, at: string, session: string, id: string }} known
 */
async function build(capture, input, request, response, { status, outcome, at, session, id }) {
  const { route } = input;
  const { scrubber } = capture;
  const requestUrl = new URL(request.url, "http://localhost");
  const path = requestUrl.pathname;
  if (!capture.include.some((glob) => glob.test(path)) || capture.exclude.some((glob) => glob.test(path))) return undefined;

  const pathParts = await scrubPath(capture, path.split("/"), route);

  /** @type {Record<string, string>} */
  const query = {};
  for (const [key, value] of requestUrl.searchParams) {
    query[await scrubber.scrubKey(key)] = String(await scrubber.scrub(value, key));
  }

  const requestBody = await readJson(request, capture.maxBodyBytes);
  const body = "json" in requestBody ? await scrubber.scrub(requestBody.json) : { $omitted: requestBody.omitted };

  const responseBody = await readJson(response, MAX_RESPONSE_BYTES);
  const json = "json" in responseBody ? await scrubber.scrubKeys(responseBody.json) : null;
  const code = /** @type {{ code?: unknown } | null} */ (json)?.code;
  /** @type {import("../shared/case.mjs").Case} */
  const item = {
    ...(await base(capture, session, at, outcome, id)),
    actor: actorOf(input.actor),
    request: { method: request.method.toUpperCase(), route, path: pathParts.join("/"), query, body },
    response: {
      status,
      shape: shapeOf(json),
      ids: await keptIds(capture, json),
      // Only on errors: a 2xx `code` is as likely an invite or verification code as an error code.
      ...(status >= 400 && typeof code === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(code) ? { errorCode: code } : {}),
    },
    ...actionOf(capture, header(request.headers, "x-intersite-action"), header(request.headers, "x-intersite-page")),
    ...stepOf(header(request.headers, "x-intersite-step")),
  };
  if (caseProblem(item)) item.request.body = { $omitted: "too large" };
  return item;
}

/**
 * The response's IDs that the scrubber would keep in a request under the same key: a secret shaped like an ID
 * (`whsec_…` under `webhookSecret`, `sk_…`) is not one. The key is the nearest object key above the value.
 * @param {Capture} capture @param {unknown} json
 */
async function keptIds(capture, json) {
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [pointer, value] of Object.entries(idsOf(json, capture.idPattern))) {
    const key = pointer.split("/").filter((part) => part !== "" && !/^\d+$/.test(part)).at(-1) ?? "";
    if ((await capture.scrubber.scrub(value, key)) === value) kept[pointer] = value;
  }
  return kept;
}

/** @param {Capture} capture @param {RecordInput} input @returns {Promise<void>} */
function record(capture, input) {
  const request = input?.request;
  // Skipped or unusable: free the request copy's body (cancelling is not reading) so its tee does not buffer.
  const skip = () => {
    discard(isFetchMessage(request) ? request.body : undefined);
    return resolved;
  };
  try {
    const response = input.response;
    const status = response?.status;
    if (!Number.isInteger(status) || typeof request?.url !== "string" || typeof request.method !== "string") return skip();
    if (header(request.headers, "x-intersite-replay") !== null) return skip();
    // The outcome comes from the status alone, so the sampling decision is made before any body is touched.
    const outcome = input.outcome ?? (status >= 500 ? "error" : status >= 400 ? "rejected" : "ok");
    const ms = input.at === undefined ? Date.now() : new Date(input.at).getTime();
    // With no caller session and no tab header, each request is its own session, so sampling takes about `sample` of them.
    const id = input.id ?? crypto.randomUUID();
    const session = String(input.session ?? header(request.headers, "x-intersite-session") ?? id);
    if (!sampled(capture, outcome, session, ms)) return skip();
    // Clone synchronously, before the caller returns the original and the runtime starts streaming it.
    const copy = isFetchMessage(response) ? response.clone() : response;
    const known = { status: /** @type {number} */ (status), outcome, at: new Date(ms).toISOString(), session, id };
    return enqueue(
      capture,
      build(capture, input, request, copy, known).finally(() => {
        discard(isFetchMessage(copy) ? copy.body : undefined);
        discard(isFetchMessage(request) ? request.body : undefined);
      }),
    );
  } catch {
    return skip();
  }
}

/** @param {Capture} capture @param {UiInput} input @returns {Promise<void>} */
function recordUi(capture, input) {
  try {
    const page = reducePage(capture, input?.page);
    const outcome = input.outcome;
    const ms = Date.now();
    const at = new Date(ms).toISOString();
    const id = crypto.randomUUID();
    const session = String(input.session ?? id);
    if (!page || !OUTCOMES.includes(outcome) || (input.step !== undefined && stepProblem(input.step, true))) return resolved;
    if (!sampled(capture, outcome, session, ms)) return resolved;
    const errorName = typeof input.errorName === "string" && ERROR_NAME.test(input.errorName) ? { errorCode: input.errorName } : {};
    return enqueue(
      capture,
      base(capture, session, at, outcome, id).then((fields) => ({
        ...fields,
        release: typeof input.release === "string" ? input.release : capture.release,
        actor: actorOf(input.actor),
        request: { method: UI_METHOD, route: page, path: page, query: {}, body: null },
        response: { status: 0, shape: "null", ids: {}, ...errorName },
        ...actionOf(capture, input.name, page),
        ...(input.step !== undefined && { step: input.step }),
      })),
    );
  } catch {
    return resolved;
  }
}

/** @param {Capture} capture @param {typeof fetch} inner @param {(request: Request) => Described} describe @returns {typeof fetch} */
function wrapFetch(capture, inner, describe) {
  return (input, init) => {
    /** @type {Request | undefined} */
    let copy;
    /** @type {Described} */
    let described;
    try {
      // A copy taken before `inner` consumes the original; a streamed body is left out rather than stolen.
      const source = input instanceof Request ? input.clone() : input;
      copy = new Request(source, init?.body instanceof ReadableStream ? { ...init, body: null } : init);
      described = copy.url.startsWith(capture.endpoint) ? undefined : describe(copy);
    } catch {
      described = undefined;
    }
    const pending = inner(input, init);
    if (!copy || !described || typeof described.route !== "string") {
      discard(copy?.body);
      return pending;
    }
    const request = copy;
    const { route, actor, session } = described;
    // Registered before the caller's own `then`, so the response is cloned before the caller reads it.
    Promise.resolve(pending).then(
      (response) => record(capture, { request, response, route, actor, session }),
      () => discard(request.body),
    );
    return pending;
  };
}

/**
 * @param {CaptureOptions} options
 * @returns {{
 *   record(input: RecordInput): Promise<void>,
 *   recordUi(input: UiInput): Promise<void>,
 *   wrapFetch(fetcher: typeof fetch, describe: (request: Request) => Described): typeof fetch,
 * }}
 */
export function createCapture(options) {
  // Construction must not throw either: a Worker usually builds this per request, so a missing secret would 500 everything.
  try {
    if (!options.project || !options.url || !options.token) return disabled("project, url and token are required");
    const capture = captureState(options);
    return {
      record: (input) => record(capture, input),
      recordUi: (input) => recordUi(capture, input),
      wrapFetch: (inner, describe) => wrapFetch(capture, inner, describe),
    };
  } catch (error) {
    return disabled(error instanceof Error ? error.message : String(error));
  }
}
