// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCapture } from "../../capture/index.mjs";
import { caseProblem } from "../../shared/case.mjs";
import { captureOptions } from "../../shared/config.mjs";

const TOKEN = "ingest-secret-token-1234";

function collector() {
  /** @type {any[]} */
  const cases = [];
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  const fetcher = {
    /** @param {string} url @param {RequestInit} init */
    async fetch(url, init) {
      calls.push({ url, init });
      cases.push(...JSON.parse(String(init.body)).cases);
      return Response.json({ accepted: 1, dropped: [] });
    },
  };
  return { cases, calls, fetcher: /** @type {any} */ (fetcher) };
}

/** @param {object} [overrides] */
function capture(overrides = {}) {
  const sink = collector();
  const instance = createCapture({ project: "acme", url: "https://collector.test/", token: TOKEN, release: "abc123", sample: 1, fetcher: sink.fetcher, ...overrides });
  return { ...sink, instance };
}

/** @param {string} url @param {RequestInit} [init] */
const req = (url, init) => new Request(url, init);

test("records a scrubbed case that passes caseProblem, and leaks no secret or personal string", async () => {
  const { instance, cases, calls } = capture();
  const request = req("https://api.acme.com/v1/programs/prog_8fK2abQ9/members?invite=bob%40mail.com&page=2&status=active", {
    method: "POST",
    headers: {
      authorization: "Bearer live-session-token-xyz",
      cookie: "sid=cookie-value-987",
      "content-type": "application/json",
      "x-api-key": "header-api-key-555",
    },
    body: JSON.stringify({ password: "hunter2-very-secret", email: "alice@example.com", note: "Call Alice Smith", role: "editor", seats: 3, startsOn: "2026-12-01" }),
  });
  const response = Response.json({ id: "mem_7Gh3kLmN", program: { id: "prog_8fK2abQ9", owner: "alice@example.com" }, tags: ["a"] }, { status: 201 });

  await instance.record({ request, response, route: "/v1/programs/:id/members", actor: { kind: "creator" }, session: "user_raw_42", id: "req-1", at: "2026-11-10T12:00:00.000Z" });

  assert.equal(await response.text().then((text) => JSON.parse(text).id), "mem_7Gh3kLmN", "caller can still read the response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://collector.test/v1/cases");
  assert.equal(/** @type {any} */ (calls[0].init.headers).authorization, `Bearer ${TOKEN}`);
  const [item] = cases;
  assert.equal(caseProblem(item), undefined);

  const serialized = JSON.stringify(item);
  for (const secret of ["live-session-token-xyz", "cookie-value-987", "header-api-key-555", "hunter2-very-secret", "alice@example.com", "bob@mail.com", "bob%40mail.com", "Alice Smith", "user_raw_42", TOKEN]) {
    assert.ok(!serialized.includes(secret), `case contains ${secret}`);
  }
  assert.ok(!/authorization|cookie|x-api-key/i.test(serialized), "no headers stored");

  assert.equal(item.v, 1);
  assert.equal(item.id, "req-1");
  assert.equal(item.outcome, "ok");
  assert.equal(item.ttlDays, 14);
  assert.equal(item.seq, Date.parse("2026-11-10T12:00:00.000Z"));
  assert.match(item.session, /^[0-9a-f]{32}$/);
  assert.deepEqual(item.actor, { kind: "creator" });
  assert.equal(item.request.path, "/v1/programs/prog_8fK2abQ9/members");
  assert.equal(item.request.query.page, "2");
  assert.equal(item.request.query.status, "active");
  assert.match(item.request.query.invite, /^u[0-9a-f]{8}@example\.test$/);
  assert.equal(item.request.body.role, "editor");
  assert.equal(item.request.body.seats, 3);
  assert.equal(item.request.body.startsOn, "2026-12-01");
  assert.deepEqual(item.response, {
    status: 201,
    shape: { id: "string", program: { id: "string", owner: "string" }, tags: ["string"] },
    ids: { "/id": "mem_7Gh3kLmN", "/program/id": "prog_8fK2abQ9" },
  });
});

test("path parameters are scrubbed by their route name", async () => {
  const { instance, cases } = capture();
  await instance.record({ request: req("https://api.acme.com/v1/users/alice%40example.com/posts/123456"), response: new Response("ok"), route: "/v1/users/:email/posts/:n", actor: { kind: "admin" }, session: "s" });
  assert.match(cases[0].request.path, /^\/v1\/users\/u[0-9a-f]{8}%40example\.test\/posts\/\d{6}$/);
  assert.notEqual(cases[0].request.path.split("/").at(-1), "123456");
  assert.equal(cases[0].response.shape, "null");
  assert.deepEqual(cases[0].response.ids, {});
});

test("path and query values are kept only under a parameter name known to hold a code or a date", async () => {
  const { instance, cases } = capture();
  const url = "https://api.acme.com/v1/teams/maria/boards/active?sort=newest&who=jdoe&from=2026-01-01&born=1990-04-02";
  await instance.record({ request: req(url), response: new Response("ok"), route: "/v1/teams/:slug/boards/:state", actor: { kind: "user" }, session: "s" });
  const [, v1, teams, slug, boards, state] = cases[0].request.path.split("/");
  assert.deepEqual([v1, teams, boards, state], ["v1", "teams", "boards", "active"]);
  assert.match(slug, /^text-[0-9a-f]{8}$/);
  const { query } = cases[0].request;
  assert.equal(query.sort, "newest");
  assert.equal(query.from, "2026-01-01");
  assert.match(query.who, /^text-[0-9a-f]{8}$/);
  assert.match(query.born, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(query.born, "1990-04-02");
  assert.ok(!JSON.stringify(cases[0]).match(/maria|jdoe|1990/));
});

test("outcome, errorCode and ttlDays follow the status", async () => {
  const { instance, cases } = capture({ sample: 0, ttlDays: { rejected: 7 } });
  const base = { request: req("https://a.test/v1/x"), route: "/v1/x", actor: { kind: "anonymous" }, session: "s" };
  await instance.record({ ...base, response: Response.json({ code: "program_full", message: "Alice, it is full" }, { status: 409 }) });
  await instance.record({ ...base, request: req("https://a.test/v1/x"), response: new Response("boom", { status: 503 }) });
  await instance.record({ ...base, request: req("https://a.test/v1/x"), response: Response.json({ code: "INV1TE42" }), outcome: "warn" });
  await instance.record({ ...base, request: req("https://a.test/v1/x"), response: Response.json({}) });
  assert.deepEqual(cases.map((item) => [item.outcome, item.ttlDays, item.response.errorCode]), [
    ["rejected", 7, "program_full"],
    ["error", 90, undefined],
    ["warn", 90, undefined],
  ]);
  for (const item of cases) assert.equal(caseProblem(item), undefined);
});

test("sampling is by session and day, roughly `sample` of sessions, never the raw ID", async () => {
  const { instance, cases } = capture({ sample: 0.3 });
  const at = "2026-11-10T09:00:00.000Z";
  const record = (/** @type {string} */ session, /** @type {string} */ when = at) =>
    instance.record({ request: req("https://a.test/v1/x"), response: Response.json({}), route: "/v1/x", actor: { kind: "user" }, session, at: when });

  for (let index = 0; index < 1000; index++) await record(`user-${index}`);
  const share = cases.length / 1000;
  assert.ok(share > 0.25 && share < 0.35, `recorded ${share}`);
  assert.ok(cases.every((item) => !JSON.stringify(item).includes("user-")));

  // Every case of one session and day gets the same hash and the same decision, at any time of that day.
  const morning = cases.map((item) => item.session).sort();
  cases.length = 0;
  for (let index = 0; index < 1000; index++) await record(`user-${index}`, "2026-11-10T23:59:59.000Z");
  assert.deepEqual(cases.map((item) => item.session).sort(), morning);

  cases.length = 0;
  for (let index = 0; index < 1000; index++) await record(`user-${index}`, "2026-11-11T09:00:00.000Z");
  assert.ok(cases.every((item) => !morning.includes(item.session)), "a new day gives new session hashes");
});

test("a case that is not ok is always recorded, even at sample 0", async () => {
  const { instance, cases } = capture({ sample: 0 });
  for (let index = 0; index < 20; index++) {
    await instance.record({ request: req("https://a.test/v1/x"), response: new Response("", { status: 500 }), route: "/v1/x", actor: { kind: "user" }, session: `s${index}` });
  }
  assert.equal(cases.length, 20);
});

test("skips replayed traffic and excluded or not-included paths", async () => {
  const { instance, cases } = capture({ include: ["/v1/**"], exclude: ["/v1/webhooks/*", "/v1/internal/**"] });
  const record = (/** @type {string} */ url, /** @type {HeadersInit} */ headers = {}) =>
    instance.record({ request: req(url, { headers }), response: Response.json({}), route: "/", actor: { kind: "user" }, session: "s" });
  await record("https://a.test/v1/x", { "x-intersite-replay": "1" });
  await record("https://a.test/v1/webhooks/stripe");
  await record("https://a.test/v1/internal/a/b/c");
  await record("https://a.test/health");
  assert.equal(cases.length, 0);
  await record("https://a.test/v1/webhooks/stripe/extra");
  await record("https://a.test/v1/programs/abc");
  assert.equal(cases.length, 2);
});

test("oversized and non-JSON request bodies are omitted with a marker", async () => {
  const { instance, cases } = capture({ maxBodyBytes: 64 });
  const record = (/** @type {RequestInit} */ init) => instance.record({ request: req("https://a.test/v1/x", { method: "POST", ...init }), response: Response.json({}), route: "/v1/x", actor: { kind: "user" }, session: "s" });
  await record({ headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "x".repeat(100) }) });
  await record({ headers: { "content-type": "text/plain" }, body: "alice@example.com" });
  await record({ headers: { "content-type": "application/json" }, body: "{not json" });
  // A streamed body with no content-length is cut off at the limit too.
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode('"xxxxxxxxxxxxxxxxxxxx"')); controller.close(); } });
  await record({ headers: { "content-type": "application/json" }, body: stream, duplex: "half" });
  assert.deepEqual(cases.map((item) => item.request.body), [{ $omitted: "too large" }, { $omitted: "not json" }, { $omitted: "not json" }, { $omitted: "too large" }]);
  assert.ok(!JSON.stringify(cases).includes("alice"));
});

test("record resolves, and the response stays readable, when the collector fails", async () => {
  const failing = {
    unreachable: { fetch: async () => { throw new TypeError("fetch failed"); } },
    serverError: { fetch: async () => new Response("down", { status: 500 }) },
    hangs: {
      /** @param {string} _url @param {RequestInit} init */
      fetch: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    },
  };
  for (const [name, fetcher] of Object.entries(failing)) {
    const instance = createCapture({ project: "acme", url: "https://collector.test", token: TOKEN, release: "r", sample: 1, fetcher: /** @type {any} */ (fetcher) });
    const response = Response.json({ hello: "world" });
    const started = Date.now();
    const result = await instance.record({ request: req("https://a.test/v1/x"), response, route: "/v1/x", actor: { kind: "user" }, session: "s" });
    assert.equal(result, undefined, name);
    assert.deepEqual(await response.json(), { hello: "world" }, name);
    const elapsed = Date.now() - started;
    assert.ok(name !== "hangs" || (elapsed >= 2900 && elapsed < 5000), `${name} timed out after ${elapsed}ms`);
  }

  // A real unreachable collector over global fetch.
  const real = createCapture({ project: "acme", url: "http://127.0.0.1:9", token: TOKEN, release: "r", sample: 1 });
  const response = new Response("plain body");
  await real.record({ request: req("https://a.test/v1/x"), response, route: "/v1/x", actor: { kind: "user" }, session: "s" });
  assert.equal(await response.text(), "plain body");
});

test("bad input or config never throws", async () => {
  const { instance } = capture();
  assert.equal(await instance.record(/** @type {any} */ ({})), undefined);
  assert.equal(await instance.record(/** @type {any} */ ({ request: {}, response: new Response("x"), route: "/" })), undefined);
  const original = console.error;
  console.error = () => {};
  try {
    const missing = createCapture(/** @type {any} */ ({ project: "acme" }));
    assert.equal(await missing.record(/** @type {any} */ ({})), undefined);
    const badPattern = createCapture({ project: "acme", url: "https://c.test", token: "t", release: "r", idPattern: "(" });
    assert.equal(await badPattern.record(/** @type {any} */ ({})), undefined);
  } finally {
    console.error = original;
  }
});

test("captureOptions hands intersite.yml's capture section and project to createCapture, so its exclude applies", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-capture-options-"));
  writeFileSync(join(cwd, "intersite.yml"), "project: acme\ncapture:\n  sample: 1\n  exclude: [/webhooks/**]\n  redactKeys: [nickname]\n");
  const options = captureOptions(cwd);
  assert.equal(options.project, "acme");
  assert.deepEqual(options.exclude, ["/webhooks/**"]);
  assert.deepEqual(options.redactKeys, ["nickname"]);
  /** @type {any[]} */
  const sent = [];
  const fetcher = { fetch: async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => (sent.push(...JSON.parse(String(init.body)).cases), Response.json({ accepted: 1, dropped: [] })) };
  const capture = createCapture({ ...options, url: "http://collector.test", token: "t", release: "r", fetcher });
  const response = () => Response.json({ ok: true });
  await capture.record({ request: new Request("https://a.test/webhooks/stripe", { method: "POST" }), response: response(), route: "/webhooks/stripe" });
  await capture.record({ request: new Request("https://a.test/v1/me", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: "maria" }) }), response: response(), route: "/v1/me" });
  assert.deepEqual(sent.map((item) => item.request.route), ["/v1/me"]);
  assert.equal(sent[0].project, "acme");
  assert.notEqual(sent[0].request.body.nickname, "maria");
});

test("a server mounted under a prefix keeps the path's static words: /api/v1/me for the route /v1/me is not scrubbed", async () => {
  const { instance, cases } = capture();
  const paths = [["/api/v1/me", "/v1/me"], ["/api/v1/programs/prog_8fK2abQ9", "/v1/programs/:id"], ["/t/Maria%20Lopez/v1/me", "/v1/me"], ["/other/path", "/v1/me"]];
  for (const [path, route] of paths) await instance.record({ request: req(`https://api.acme.com${path}`), response: Response.json({}), route, session: "s" });
  const [mounted, withId, named, unrelated] = cases.map((item) => item.request.path);
  assert.equal(mounted, "/api/v1/me");
  assert.equal(withId, "/api/v1/programs/prog_8fK2abQ9");
  assert.match(named, /^\/t\/text-[0-9a-f]{8}\/v1\/me$/);
  assert.match(unrelated, /^\/text-[0-9a-f]{8}\/text-[0-9a-f]{8}$/);
});

test("a secret in the response shaped like an ID is not stored among the response's IDs", async () => {
  const { instance, cases } = capture();
  const response = Response.json({ id: "hook_8fK2abQ9", webhookSecret: "whsec_143Op6pcyIvNBbaJ", signing: { key: "sk_4eC39HqLyjWDarjtT1zdp7dc" }, accounts: ["acct_7Gh3kLmN"] }, { status: 201 });
  await instance.record({ request: req("https://api.acme.com/v1/hooks", { method: "POST" }), response, route: "/v1/hooks", session: "s" });
  assert.deepEqual(cases[0].response.ids, { "/id": "hook_8fK2abQ9", "/accounts/0": "acct_7Gh3kLmN" });
  assert.ok(!JSON.stringify(cases[0]).includes("whsec_143Op6"));
});
