// @ts-check

/**
 * Capture: samples real API requests in production, scrubs them, and sends each as a case to the collector.
 * `record` never rejects and never touches the response the caller returns.
 *
 * @example Cloudflare Worker
 * import { createCapture } from "intersite/capture";
 * export default {
 *   async fetch(request, env, ctx) {
 *     const capture = createCapture({ project: "acme", url: env.INTERSITE_URL, token: env.INTERSITE_INGEST_TOKEN, release: env.RELEASE });
 *     const copy = request.clone();
 *     const { response, route, user } = await handle(request, env); // your router
 *     ctx.waitUntil(capture.record({ request: copy, response, route, actor: { kind: user?.role ?? "anonymous" }, session: user?.id ?? "anonymous" }));
 *     return response;
 *   },
 * };
 */

import { caseProblem } from "../shared/case.mjs";
import { DEFAULT_ID_PATTERN, idsOf, shapeOf } from "../shared/shape.mjs";
import { createScrubber } from "./scrub.mjs";

const DEFAULT_TTL_DAYS = { ok: 14, warn: 90, rejected: 30, error: 90 };
// ponytail: response bodies over 1 MiB are recorded with shape "null", make it an option if large list endpoints matter.
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 3000;

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
 * @property {string[]} [redactKeys]
 * @property {string} [idPattern]
 * @property {Partial<Record<"ok" | "warn" | "rejected" | "error", number>>} [ttlDays]
 */

/**
 * @typedef {object} RecordInput
 * @property {Request} request   A clone taken before handling, body unread.
 * @property {Response} response The response being returned; `record` clones it.
 * @property {string} route      Route template such as `/v1/programs/:id`.
 * @property {{ kind: string }} actor
 * @property {string} session    A stable caller identifier; only its salted daily hash is stored.
 * @property {"ok" | "warn" | "rejected" | "error"} [outcome]
 * @property {string} [id]
 * @property {string | Date} [at]
 */

/** `*` is one path segment, `**` is any depth. @param {string} glob */
function globToRegExp(glob) {
  const source = glob.replace(/\/\*\*|\*\*|\*|[.+?^${}()|[\]\\]/g, (part) => {
    if (part === "/**") return "(?:/.*)?";
    if (part === "**") return ".*";
    return part === "*" ? "[^/]+" : `\\${part}`;
  });
  return new RegExp(`^${source}$`);
}

/** @param {ReadableStream | null | undefined} body */
function discard(body) {
  // oxlint-disable-next-line intersite/no-empty-catch -- cancelling a body that already closed can reject; nothing to recover
  if (body && !body.locked) body.cancel().catch(() => {});
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
 * @param {Request | Response} message @param {number} limit
 * @returns {Promise<{ json: unknown } | { omitted: "not json" | "too large" }>}
 */
async function readJson(message, limit) {
  if (!message.body) return { json: null };
  if (!/\bjson\b/i.test(message.headers.get("content-type") ?? "")) return { omitted: "not json" };
  if (Number(message.headers.get("content-length")) > limit) return { omitted: "too large" };
  const text = await readLimited(message.body, limit);
  if (text === undefined) return { omitted: "too large" };
  if (text.trim() === "") return { json: null };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { omitted: "not json" };
  }
}

/** @param {string} reason */
const disabled = (reason) => {
  console.error(`intersite capture disabled: ${reason}`);
  return { record: () => Promise.resolve() };
};

/**
 * @param {CaptureOptions} options
 * @returns {{ record(input: RecordInput): Promise<void> }}
 */
export function createCapture(options) {
  // Construction must not throw either: a Worker usually builds this per request, so a missing secret would 500 everything.
  try {
    const { project, url, token, fetcher, release } = options;
    if (!project || !url || !token) return disabled("project, url and token are required");
    const sample = options.sample ?? 0.05;
    const maxBodyBytes = options.maxBodyBytes ?? 32_768;
    const include = (options.include ?? ["/**"]).map(globToRegExp);
    const exclude = (options.exclude ?? []).map(globToRegExp);
    const ttlDays = { ...DEFAULT_TTL_DAYS, ...options.ttlDays };
    const idPattern = new RegExp(options.idPattern ?? DEFAULT_ID_PATTERN);
    const scrubber = createScrubber({ salt: options.salt ?? token, idPattern: idPattern.source, redactKeys: options.redactKeys });
    const endpoint = `${url.replace(/\/+$/, "")}/v1/cases`;

    /** @param {RecordInput} input @param {Response} response */
    async function run(input, response) {
      const { request, route } = input;
      if (request.headers.has("x-intersite-replay")) return;
      const requestUrl = new URL(request.url);
      const path = requestUrl.pathname;
      if (!include.some((glob) => glob.test(path)) || exclude.some((glob) => glob.test(path))) return;

      const status = response.status;
      const outcome = input.outcome ?? (status >= 500 ? "error" : status >= 400 ? "rejected" : "ok");
      const at = new Date(input.at ?? Date.now()).toISOString();
      const session = (await scrubber.hash(`${input.session}|${at.slice(0, 10)}`)).slice(0, 32);
      if (outcome === "ok" && Number.parseInt(session.slice(0, 13), 16) / 2 ** 52 >= sample) return;

      const routeParts = route.split("/");
      const pathParts = await Promise.all(
        path.split("/").map(async (segment, index) => {
          const template = routeParts[index];
          if (segment === "" || (segment === template && !template.startsWith(":"))) return segment;
          let decoded = segment;
          try {
            decoded = decodeURIComponent(segment);
          } catch {
            decoded = segment;
          }
          const scrubbed = await scrubber.scrub(decoded, template?.startsWith(":") ? template.slice(1) : "");
          return encodeURIComponent(String(scrubbed));
        }),
      );

      /** @type {Record<string, string>} */
      const query = {};
      for (const [key, value] of requestUrl.searchParams) {
        query[await scrubber.scrubKey(key)] = String(await scrubber.scrub(value, key));
      }

      const requestBody = await readJson(request, maxBodyBytes);
      const body = "json" in requestBody ? await scrubber.scrub(requestBody.json) : { $omitted: requestBody.omitted };

      const responseBody = await readJson(response, MAX_RESPONSE_BYTES);
      const json = "json" in responseBody ? await scrubber.scrubKeys(responseBody.json) : null;
      const code = /** @type {any} */ (json)?.code;
      /** @type {import("../shared/case.mjs").Case} */
      const item = {
        v: 1,
        id: input.id ?? crypto.randomUUID(),
        project,
        session,
        seq: Date.parse(at),
        at,
        release,
        outcome,
        actor: { kind: /^[a-z][a-z0-9_-]{0,31}$/.test(input.actor?.kind ?? "") ? input.actor.kind : "unknown" },
        request: { method: request.method, route, path: pathParts.join("/"), query, body },
        response: {
          status,
          shape: shapeOf(json),
          ids: idsOf(json, idPattern),
          // Only on errors: a 2xx `code` is as likely an invite or verification code as an error code.
          ...(status >= 400 && typeof code === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(code) ? { errorCode: code } : {}),
        },
        ttlDays: ttlDays[outcome],
      };
      if (caseProblem(item)) item.request.body = { $omitted: "too large" };
      if (caseProblem(item)) return;

      // ponytail: one case per POST, batch per isolate (the collector takes up to 50) if request volume makes this costly.
      const sent = await (fetcher ?? globalThis).fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ cases: [item] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      discard(sent.body);
    }

    return {
      record(input) {
        // Clone synchronously, before the caller returns the original and the runtime starts streaming it.
        /** @type {Response | undefined} */
        let response;
        try {
          response = input.response.clone();
        } catch {
          discard(input?.request?.body);
          return Promise.resolve();
        }
        const copy = response;
        return run(input, copy)
          // oxlint-disable-next-line intersite/no-empty-catch -- record() must never reject into the request it observes
          .catch(() => {})
          .finally(() => {
            discard(copy.body);
            discard(input.request?.body);
          });
      },
    };
  } catch (error) {
    return disabled(error instanceof Error ? error.message : String(error));
  }
}
