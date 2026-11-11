// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCapture } from "../../capture/index.mjs";
import { UI_METHOD, caseProblem } from "../../shared/case.mjs";

const TOKEN = "ingest-secret-token-1234";

/** @param {object} [overrides] */
function capture(overrides = {}) {
  /** @type {any[]} */
  const cases = [];
  /** @type {number[]} */
  const posts = [];
  const fetcher = {
    /** @param {string} _url @param {RequestInit} init */
    async fetch(_url, init) {
      const batch = JSON.parse(String(init.body)).cases;
      posts.push(batch.length);
      cases.push(...batch);
      return Response.json({ accepted: batch.length, dropped: [] });
    },
  };
  const instance = createCapture({ project: "acme", url: "https://collector.test", token: TOKEN, release: "abc123", sample: 1, fetcher: /** @type {any} */ (fetcher), ...overrides });
  return { instance, cases, posts };
}

/** Waits until `check` holds, for work `record` was not awaited for. @param {() => boolean} check */
async function until(check) {
  for (let tries = 0; tries < 100 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
}

const AT = "2026-11-10T12:00:00.000Z";

test("an unsampled ok record never clones or reads a body", async () => {
  const { instance, cases } = capture({ sample: 0 });
  /** @type {string[]} */
  const touched = [];
  const methods = ["clone", "text", "json", "arrayBuffer", "blob", "formData", "getReader"];
  /** Logs any read of `body` and any call of a body method. @template {object} T @param {T} target @param {string} label @returns {T} */
  const spy = (target, label) =>
    new Proxy(target, {
      get(object, key) {
        if (key === "body") touched.push(`${label}.body`);
        const value = Reflect.get(object, key);
        if (typeof value !== "function") return value;
        return (/** @type {unknown[]} */ ...args) => {
          if (methods.includes(String(key))) touched.push(`${label}.${String(key)}()`);
          return value.apply(object, args);
        };
      },
    });
  for (let index = 0; index < 50; index++) {
    const response = spy(Response.json({ id: "prog_8fK2abQ9" }), "response");
    const request = spy({ method: "GET", url: "/v1/x", headers: {}, body: { secret: 1 } }, "request");
    await instance.record({ request, response, route: "/v1/x", actor: { kind: "user" }, session: `user-${index}` });
  }
  assert.deepEqual(touched, []);
  assert.equal(cases.length, 0);

  // Not ok is still always recorded.
  await instance.record({ request: new Request("https://a.test/v1/x"), response: new Response("", { status: 500 }), route: "/v1/x", actor: { kind: "user" }, session: "s" });
  assert.equal(cases.length, 1);
});

test("the synchronous sampling decision is the same for every case of one session and day", async () => {
  const { instance, cases } = capture({ sample: 0.5 });
  const times = ["00:00:00", "06:30:00", "12:00:01", "18:45:10", "23:59:59"].map((time) => `2026-11-10T${time}.000Z`);
  for (let index = 0; index < 100; index++) {
    for (const at of times) {
      await instance.record({ request: new Request("https://a.test/v1/x"), response: Response.json({}), route: "/v1/x", actor: { kind: "user" }, session: `user-${index}`, at });
    }
  }
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of cases) counts.set(item.session, (counts.get(item.session) ?? 0) + 1);
  assert.ok([...counts.values()].every((count) => count === times.length), "a session is recorded whole or not at all");
  assert.ok(counts.size > 30 && counts.size < 70, `sampled ${counts.size} of 100 sessions`);
});

test("plain-object input gives the same case as the equivalent Request and Response", async () => {
  const { instance, cases } = capture();
  const body = { email: "alice@example.com", role: "editor", seats: 3 };
  const headers = { "content-type": "application/json", authorization: "Bearer live-token-xyz" };
  const responseBody = { id: "mem_7Gh3kLmN", owner: "alice@example.com" };
  const common = { route: "/v1/programs/:id/members", actor: { kind: "creator" }, session: "user_raw_42", id: "req-1", at: AT };
  await instance.record({
    ...common,
    request: new Request("https://api.acme.com/v1/programs/prog_8fK2abQ9/members?page=2", { method: "POST", headers, body: JSON.stringify(body) }),
    response: Response.json(responseBody, { status: 201 }),
  });
  await instance.record({
    ...common,
    request: { method: "POST", url: "/v1/programs/prog_8fK2abQ9/members?page=2", headers, body },
    response: { status: 201, headers: new Headers({ "content-type": "application/json" }), body: JSON.stringify(responseBody) },
  });
  assert.equal(cases.length, 2);
  assert.equal(caseProblem(cases[1]), undefined);
  assert.deepEqual(cases[1], cases[0]);
  assert.ok(!JSON.stringify(cases).includes("alice@example.com"));

  // Something that is not JSON data (a Buffer, a non-JSON string) is omitted, not walked byte by byte.
  await instance.record({ ...common, request: { method: "POST", url: "/v1/x", body: new Uint8Array([97, 108, 105]) }, response: { status: 200, body: "<html>alice</html>" } });
  assert.deepEqual(cases[2].request.body, { $omitted: "not json" });
  assert.equal(cases[2].response.shape, "null");
});

test("actions: a valid name and a server-reduced page become case.action; forged values are dropped or reduced", async () => {
  const { instance, cases } = capture();
  /** @param {Record<string, string>} headers @param {string} [session] */
  const record = (headers, session) => instance.record({ request: new Request("https://a.test/v1/x", { headers }), response: Response.json({}), route: "/v1/x", actor: { kind: "user" }, session, at: AT });

  await record({ "x-intersite-action": "program.save", "x-intersite-page": "/programs/prog_8fK2abQ9/edit" });
  await record({ "x-intersite-action": "program.save", "x-intersite-page": "/users/alice@example.com/Call Alice Smith/prog_8fK2abQ9/jdoe1987/settings?x=1" });
  await record({ "x-intersite-action": "Program Save!", "x-intersite-page": "/programs" });
  await record({ "x-intersite-action": "program.save", "x-intersite-page": "no-leading-slash" });
  assert.deepEqual(cases[0].action, { name: "program.save", page: "/programs/prog_8fK2abQ9/edit" });
  assert.deepEqual(cases[1].action, { name: "program.save", page: "/users/_/_/prog_8fK2abQ9/_/_" });
  assert.equal(cases[2].action, undefined);
  assert.equal(cases[3].action, undefined);
  assert.ok(!JSON.stringify(cases).match(/alice|Smith|jdoe/i));
  for (const item of cases) assert.equal(caseProblem(item), undefined);

  // The session header stands in when the caller gives none; with neither, each request is a session of its own.
  cases.length = 0;
  await record({ "x-intersite-session": "tab-123" });
  await record({}, "tab-123");
  await record({});
  await record({});
  assert.equal(cases[0].session, cases[1].session);
  assert.notEqual(cases[2].session, cases[3].session);
  assert.notEqual(cases[0].session, cases[2].session);
});

test("signed-out requests with no session are sampled one by one, not as one session of the day", async () => {
  const { instance, cases } = capture({ sample: 0.25 });
  for (let index = 0; index < 400; index++) {
    await instance.record({ request: new Request("https://a.test/v1/x"), response: Response.json({}), route: "/v1/x", actor: { kind: "anonymous" }, id: `case-${index}`, at: AT });
  }
  assert.ok(cases.length > 60 && cases.length < 140, `sampled ${cases.length} of 400 anonymous requests`);
  assert.equal(new Set(cases.map((item) => item.session)).size, cases.length);

  // A UI event with no session is its own session too.
  const ui = capture();
  await ui.instance.recordUi({ page: "/home", outcome: "error", errorName: "TypeError" });
  await ui.instance.recordUi({ page: "/home", outcome: "error", errorName: "TypeError" });
  assert.notEqual(ui.cases[0].session, ui.cases[1].session);
});

test("wrapFetch records one case and hands the caller the response untouched", async () => {
  const { instance, cases } = capture();
  /** @type {typeof fetch} */
  const inner = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    return Response.json({ id: "prog_8fK2abQ9", echo: text ? JSON.parse(text) : null }, { status: 201 });
  };
  const wrapped = instance.wrapFetch(inner, (request) => (new URL(request.url).pathname === "/skip" ? undefined : { route: "/rest/v1/programs", actor: { kind: "user" }, session: "u1" }));

  const response = await wrapped("https://db.example.test/rest/v1/programs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hello" }) });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "prog_8fK2abQ9", echo: { title: "Hello" } });
  await until(() => cases.length === 1);
  assert.equal(cases.length, 1);
  assert.equal(caseProblem(cases[0]), undefined);
  assert.equal(cases[0].request.method, "POST");
  assert.deepEqual(cases[0].response.ids, { "/id": "prog_8fK2abQ9" });

  // A Request input is still usable by the inner fetch; skipped calls record nothing.
  const fromRequest = await wrapped(new Request("https://db.example.test/skip", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.deepEqual(await fromRequest.json(), { id: "prog_8fK2abQ9", echo: {} });

  // A throwing describe never surfaces; a failing inner fetch reaches the caller unchanged.
  const throwing = instance.wrapFetch(inner, () => { throw new Error("describe broke"); });
  assert.equal((await throwing("https://db.example.test/x")).status, 201);
  const failing = instance.wrapFetch(async () => { throw new TypeError("offline"); }, () => ({ route: "/x" }));
  await assert.rejects(failing("https://db.example.test/x"), { message: "offline" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cases.length, 1);
});

test("recordUi sends a UI case that passes caseProblem, with the error name only", async () => {
  const { instance, cases } = capture();
  await instance.recordUi({ page: "/programs/prog_8fK2abQ9/alice@example.com", name: "program.save", outcome: "error", errorName: "TypeError", session: "tab-1" });
  await instance.recordUi({ page: "/programs", outcome: "warn", errorName: "Cannot read properties of undefined (reading 'x')", session: "tab-1", release: "def456" });
  await instance.recordUi({ page: "/programs", outcome: /** @type {any} */ ("bad"), session: "tab-1" });
  assert.equal(cases.length, 2);
  for (const item of cases) assert.equal(caseProblem(item), undefined);
  const [error, warn] = cases;
  assert.deepEqual(error.request, { method: UI_METHOD, route: "/programs/prog_8fK2abQ9/_", path: "/programs/prog_8fK2abQ9/_", query: {}, body: null });
  assert.deepEqual(error.response, { status: 0, shape: "null", ids: {}, errorCode: "TypeError" });
  assert.deepEqual(error.action, { name: "program.save", page: "/programs/prog_8fK2abQ9/_" });
  assert.equal(error.ttlDays, 90);
  assert.equal(warn.outcome, "warn");
  assert.equal(warn.release, "def456");
  assert.equal(warn.response.errorCode, undefined);
  assert.equal(warn.action, undefined);
  assert.ok(!JSON.stringify(cases).match(/alice|Cannot read/));
});

test("60 quick records make two POSTs, and each record resolves after its send", async () => {
  const { instance, cases, posts } = capture();
  const records = Array.from({ length: 60 }, (_, index) =>
    instance.record({ request: new Request("https://a.test/v1/x"), response: Response.json({}), route: "/v1/x", actor: { kind: "user" }, session: `s${index}` }),
  );
  const results = await Promise.all(records);
  assert.deepEqual(posts.toSorted((a, b) => b - a), [50, 10]);
  assert.equal(cases.length, 60);
  assert.ok(results.every((result) => result === undefined));
});
