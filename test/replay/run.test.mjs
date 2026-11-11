// @ts-check
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, beforeEach, test } from "node:test";

import { replaySessions } from "../../replay/run.mjs";
import { DEFAULT_ID_PATTERN } from "../../shared/shape.mjs";
import * as adapter from "./adapter.mjs";
import { listSession, notesSession, preexistingSession, recorded, startTarget } from "./helpers.mjs";

/** @type {Awaited<ReturnType<typeof startTarget>>} */
let target;
beforeEach(async () => { target = await startTarget(); });
afterEach(() => target.close());

/**
 * @param {import("../../shared/case.mjs").Case[]} cases
 * @param {import("../../replay/run.mjs").Mode[]} [modes]
 * @param {import("../../replay/run.mjs").Adapter} [use]
 */
async function replay(cases, modes = ["baseline"], use = adapter) {
  const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: target.url, adapter: use, modes, idPattern: DEFAULT_ID_PATTERN });
  return result;
}
/** @param {import("../../replay/run.mjs").SessionResult} result */
const failures = (result) => result.steps.filter((step) => step.result === "failed").map((step) => `${step.mode} ${step.caseId} ${step.reason}`);

test("a healthy session passes every step and the invariant", async () => {
  const result = await replay(notesSession());
  assert.deepEqual(result.steps.map((step) => `${step.method} ${step.route} ${step.result}`), [
    "POST /notes passed",
    "GET /notes/:id passed",
    "POST /notes/:id/comments passed",
    "POST /notes/:id/archive passed",
    "INVARIANT ledger balances passed",
  ]);
  assert.equal(result.skipped, undefined);
});

test("a changed status is reported with both statuses", async () => {
  target.bugs.add("status");
  assert.deepEqual(failures(await replay(notesSession())), ["baseline s-notes-2 status recorded 200, got 410"]);
});

test("a changed response shape is reported with the pointer", async () => {
  target.bugs.add("shape");
  assert.deepEqual(failures(await replay(notesSession())), ["baseline s-notes-2 /note/text: missing"]);
});

test("an ID created in step 1 is remapped into later paths and bodies, with the replay header", async () => {
  await replay(notesSession());
  const comment = target.log.find((entry) => entry.path.endsWith("/comments"));
  assert.equal(comment?.path, "/notes/note_000001/comments");
  assert.deepEqual(comment?.body, { noteId: "note_000001", text: "c" });
  assert.equal(comment?.headers["x-intersite-replay"], "s-notes-3");
});

test("the adapter's headers go on every request, anonymous ones too, and a signed-in header wins over them", async () => {
  const anonymous = notesSession().map((item, index) => (index === 1 ? { ...item, actor: { kind: "anonymous" } } : item));
  await replay(anonymous, ["baseline"], { ...adapter, headers: ({ caseId }) => ({ "api-version": "2026-01", "idempotency-key": caseId, "x-tenant": "z" }) });
  const sent = target.log.map((entry) => `${entry.headers["api-version"]} ${entry.headers["idempotency-key"]} ${entry.headers["x-tenant"]}`);
  assert.deepEqual(sent.slice(0, 2), ["2026-01 s-notes-1 a", "2026-01 s-notes-2 z"]);
});

test("an actor kind the adapter cannot sign in skips its session with the reason; other sessions still run", async () => {
  const signIn = async (/** @type {string} */ kind) => {
    if (kind === "auditor") throw new Error("no seeded auditor");
    return { "x-tenant": "a" };
  };
  const auditor = notesSession("s-aud").map((item) => ({ ...item, actor: { kind: "auditor" } }));
  const results = await replaySessions({ sessions: [{ session: "s-aud", cases: auditor }, { session: "s-notes", cases: notesSession() }], target: target.url,
    adapter: { ...adapter, signIn }, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN });
  assert.equal(results[0].skipped, "signIn could not sign in auditor: no seeded auditor");
  assert.deepEqual(results[0].steps.map((step) => step.result), ["skipped", "skipped", "skipped", "skipped"]);
  assert.ok(results[1].steps.every((step) => step.result === "passed"));
});

test("an ID the session did not create is skipped without resolveId and runs with it", async () => {
  const { resolveId: _resolveId, ...withoutResolve } = adapter;
  const skipped = await replay([...preexistingSession(), ...notesSession("s-notes", 6000)], ["baseline"], withoutResolve);
  assert.equal(skipped.skipped, "note_prod99 was not created by this session and the adapter has no resolveId");
  assert.deepEqual(skipped.steps.filter((s) => s.method !== "INVARIANT").map((s) => s.result), ["skipped", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal(failures(skipped).length, 0);

  const resolved = await replay(preexistingSession());
  assert.deepEqual(resolved.steps.map((s) => s.result), ["passed", "passed"]);
  assert.equal(target.log.at(-1)?.path, "/notes/note_seed01");

  const unknown = await replay(preexistingSession("note_gone77"));
  assert.equal(unknown.skipped, "resolveId gave nothing for note_gone77");
});

test("twice catches a write that fails when repeated", async () => {
  assert.deepEqual(failures(await replay(notesSession(), ["twice"])), []);
  target.bugs.add("twice");
  assert.deepEqual(failures(await replay(notesSession(), ["twice"])), ["twice s-notes-4 second send got 500, first got 200"]);
});

test("cross-tenant catches a read of another tenant's record", async () => {
  const healthy = await replay(notesSession(), ["cross-tenant"]);
  assert.deepEqual(healthy.steps.map((s) => `${s.caseId} ${s.result}`), ["s-notes-2 passed", "s-notes-3 passed", "s-notes-4 passed"]);
  target.bugs.add("leak");
  const leaky = failures(await replay(notesSession(), ["cross-tenant"]));
  assert.ok(leaky.includes("cross-tenant s-notes-2 another account got 200, expected 400, 401, 403, 404 or 422"), leaky.join("\n"));
});

test("cross-tenant sends each GET that names no ID as another account and fails when it lists a record this session created", async () => {
  const scoped = await replay(listSession(), ["cross-tenant"]);
  assert.deepEqual(scoped.steps.map((s) => `${s.caseId} ${s.route} ${s.result}`), ["s-list-3 /notes/:id passed", "s-list-4 /notes passed", "s-list-5 /plans passed"],
    "the shared plan catalogue both accounts see is not a leak");

  target.bugs.add("list-leak");
  const leaky = await replay(listSession(), ["cross-tenant"]);
  assert.deepEqual(failures(leaky), ["cross-tenant s-list-4 another account's response contains note_000001 (and 1 more), created by this session"]);
  assert.equal(leaky.steps.find((s) => s.result === "failed")?.sent, "GET /notes");
});

test("a route in crossTenantIgnore is public by design: neither its access check nor its list check reports, other routes still do", async () => {
  target.bugs.add("leak");
  target.bugs.add("list-leak");
  /** @param {{ route: string, why: string }[]} crossTenantIgnore */
  const run = async (crossTenantIgnore) => {
    const [result] = await replaySessions({ sessions: [{ session: "s", cases: listSession() }], target: target.url, adapter, modes: ["cross-tenant"], idPattern: DEFAULT_ID_PATTERN, crossTenantIgnore });
    return failures(result);
  };
  assert.deepEqual((await run([])).map((line) => line.split(" ")[1]), ["s-list-3", "s-list-4"]);
  assert.deepEqual(await run([{ route: "GET /notes/:id", why: "notes are published to the network" }, { route: "/notes", why: "the note directory is public" }]), []);
  assert.deepEqual((await run([{ route: "POST /notes/:id", why: "another method of the route" }])).map((line) => line.split(" ")[1]), ["s-list-3", "s-list-4"]);
});

test("cross-tenant treats a GET whose only ID is in the query as a filtered list: an empty answer passes, a leak fails", async () => {
  const filtered = listSession().map((item) => (item.id === "s-list-4" ? { ...item, request: { ...item.request, query: { after: "note_prodL1" } } } : item));
  const scoped = await replay(filtered, ["cross-tenant"]);
  assert.deepEqual(failures(scoped), []);
  target.bugs.add("list-leak");
  assert.deepEqual(failures(await replay(filtered, ["cross-tenant"])), ["cross-tenant s-list-4 another account's response contains note_000001 (and 1 more), created by this session"]);
});

test("cross-tenant counts a 400 or 422 as a refusal (validated before access) and a 409 as an answer about the record", async () => {
  const answers = { "/notes/note_8fK2abQ9": 422, "/notes/note_9gL3bcR0": 409 };
  const server = createServer((request, response) => {
    const status = request.headers["x-tenant"] === "b" ? answers[/** @type {keyof typeof answers} */ (request.url)] : 200;
    response.writeHead(status, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  try {
    const cases = Object.keys(answers).map((path, index) => recorded({ id: `c${index}`, session: "s", seq: index, method: "PATCH", route: "/notes/:id", path, body: {}, status: 200, json: {} }));
    const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: url, adapter: { ...adapter, resolveId: async (id) => id }, modes: ["cross-tenant"], idPattern: DEFAULT_ID_PATTERN });
    assert.deepEqual(result.steps.map((step) => `${step.caseId} ${step.result}`), ["c0 passed", "c1 failed"]);
  } finally {
    server.close();
  }
});

test("cross-tenant fails an owner's answer that holds a record another account's leaky write created", async () => {
  /** @param {number} status @param {unknown} body */
  const answer = (status, body) => new Response(JSON.stringify(body), { status });
  /** A server whose comment route ignores the tenant and whose note read lists every comment. @type {typeof fetch} */
  const leaky = async (url, init) => {
    const tenant = /** @type {Record<string, string> | undefined} */ (init?.headers)?.["x-tenant"];
    const { pathname } = new URL(String(url));
    if (pathname === "/notes") return answer(201, { note: { id: "note_000001", text: "hi" } });
    if (pathname.endsWith("/comments")) return answer(201, { comment: { id: tenant === "b" ? "cmt_other01" : "cmt_mine001" } });
    return tenant === "b" ? answer(404, {}) : answer(200, { note: { id: "note_000001", comments: ["cmt_other01", "cmt_mine001"] } });
  };
  const [create, , comment] = notesSession();
  const read = recorded({ id: "s-notes-5", session: "s-notes", seq: 1005, method: "GET", route: "/notes/:id", path: "/notes/note_prodA1", status: 200, json: {} });
  const [result] = await replaySessions({
    sessions: [{ session: "s", cases: [create, comment, read] }], target: target.url, adapter: { signIn: adapter.signIn }, modes: ["cross-tenant"], idPattern: DEFAULT_ID_PATTERN, fetch: leaky,
  });
  assert.deepEqual(failures(result), [
    "cross-tenant s-notes-3 another account got 201, expected 400, 401, 403, 404 or 422",
    "cross-tenant s-notes-5 this session's response contains cmt_other01, created by another account",
  ]);
});

test("a failing invariant is reported", async () => {
  target.bugs.add("ledger");
  assert.deepEqual(failures(await replay(notesSession())), ["baseline s-notes-4 ledger is off by 1"]);
});

/** A fetch that remembers each request's URL, headers and body, and how many were in flight at once. */
function spyFetch() {
  /** @type {{ url: string, headers: Record<string, string>, body: any }[]} */
  const sent = [];
  let inFlight = 0;
  let most = 0;
  /** @type {typeof fetch} */
  const spy = async (url, init) => {
    sent.push({ url: String(url), headers: /** @type {Record<string, string>} */ (init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    most = Math.max(most, ++inFlight);
    try { return await fetch(url, init); } finally { inFlight--; }
  };
  return { spy, sent, most: () => most };
}

const DAY = 86_400_000;

test("dates in the query and body move forward by the case's age and keep their format; x-intersite-time is sent", async () => {
  const at = Date.now() - 10 * DAY;
  const item = recorded({ id: "d-1", session: "d", seq: at, method: "POST", route: "/notes", path: "/notes", status: 201, json: { note: { id: "note_prodD1", text: "hi" } },
    body: { text: "hi", startsAt: "2026-03-01T09:30:00.250Z", day: "2026-03-01", local: "2026-03-01T23:30:00+02:00", prose: "due 2026-03-01 at noon" } });
  item.request.query = { from: "2026-03-01T09:30:00Z", on: "2026-03-01" };

  const { spy, sent } = spyFetch();
  await replaySessions({ sessions: [{ session: "d", cases: [item] }], target: target.url, adapter, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN, fetch: spy, now: at + 10 * DAY });
  const [request] = sent;
  const query = new URL(request.url).searchParams;
  /** @param {string} shifted @param {string} original */
  const movedBy = (shifted, original) => Date.parse(shifted) - Date.parse(original);
  for (const [shifted, original] of [[request.body.startsAt, "2026-03-01T09:30:00.250Z"], [query.get("from"), "2026-03-01T09:30:00Z"], [request.body.local, "2026-03-01T23:30:00+02:00"]]) {
    const moved = movedBy(String(shifted), original);
    assert.equal(moved, 10 * DAY, `${original} -> ${shifted}`);
  }
  assert.match(request.body.startsAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(String(query.get("from")), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(request.body.local, /^2026-03-1[12]T\d\d:\d\d:\d\d\+02:00$/);
  assert.equal(request.body.day, "2026-03-11");
  assert.equal(query.get("on"), "2026-03-11");
  assert.equal(request.body.prose, "due 2026-03-01 at noon");
  assert.equal(request.headers["x-intersite-time"], item.at);

  const unchanged = spyFetch();
  await replaySessions({ sessions: [{ session: "d", cases: [item] }], target: target.url, adapter, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN, fetch: unchanged.spy, shiftDates: false });
  assert.deepEqual(unchanged.sent[0].body, item.request.body);
  assert.equal(new URL(unchanged.sent[0].url).search, "?from=2026-03-01T09%3A30%3A00Z&on=2026-03-01");
});

test("twice does not resend a write whose first send already failed: that is baseline's finding", async () => {
  let hits = 0;
  const failing = createServer((_request, response) => {
    hits += 1;
    response.writeHead(500, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((done) => failing.listen(0, "127.0.0.1", () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (failing.address()).port}`;
  try {
    const cases = [recorded({ id: "c1", session: "s", seq: 1, method: "POST", route: "/notes", path: "/notes", body: { text: "hi" }, status: 500, json: {} })];
    const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: url, adapter: { signIn: async () => ({}) }, modes: ["twice"], idPattern: DEFAULT_ID_PATTERN });
    assert.deepEqual(result.steps.map((step) => `${step.result} ${step.reason}`), ["skipped the first send already got 500, so a resend says nothing about repeating it"]);
    assert.equal(hits, 1);
  } finally {
    failing.close();
  }
});

test("UI cases are left out of baseline, twice and cross-tenant without counting as skipped", async () => {
  const uiCase = recorded({ id: "s-notes-ui", session: "s-notes", seq: 1002, method: "UI", route: "/notes/:id", path: "/notes/note_prodA1", status: 0, json: null });
  const result = await replay([...notesSession(), uiCase], ["baseline", "twice", "cross-tenant"]);
  assert.ok(result.steps.every((step) => step.caseId !== "s-notes-ui"));
  assert.ok(result.steps.every((step) => step.result === "passed"), failures(result).join("\n"));
  assert.equal(result.skipped, undefined);
});

test("--concurrency runs sessions at once, each with its own ID map, and one at a time when the adapter resets", async () => {
  const { reset: _reset, ...noReset } = adapter;
  const sessions = ["c1", "c2", "c3", "c4", "c5", "c6"].map((name, i) => ({ session: name, cases: notesSession(name, 1000 * i) }));
  const parallel = spyFetch();
  const results = await replaySessions({ sessions, target: target.url, adapter: noReset, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN, fetch: parallel.spy, concurrency: 6 });
  assert.ok(parallel.most() > 1, "requests overlapped");
  assert.deepEqual(results.map((result) => result.session), ["c1", "c2", "c3", "c4", "c5", "c6"]);
  assert.deepEqual(results.flatMap(failures), []);
  const comments = target.log.filter((entry) => entry.path.endsWith("/comments"));
  assert.equal(comments.length, 6);
  for (const entry of comments) assert.equal(entry.path, `/notes/${entry.body.noteId}/comments`);
  assert.equal(new Set(comments.map((entry) => entry.body.noteId)).size, 6, "each session commented on the note it created");

  const serial = spyFetch();
  await replaySessions({ sessions, target: target.url, adapter, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN, fetch: serial.spy, concurrency: 6 });
  assert.equal(serial.most(), 1);
});

test("a request the server drops (it crashed or hung up) fails its step instead of aborting the run", async () => {
  const dropping = createServer((request) => request.socket.destroy());
  await new Promise((done) => dropping.listen(0, "127.0.0.1", () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (dropping.address()).port}`;
  try {
    const cases = [recorded({ id: "c1", session: "s", seq: 1, method: "POST", route: "/notes", path: "/notes", body: { text: "hi" }, status: 201, json: {} })];
    const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: url, adapter: { signIn: async () => ({}) }, modes: ["baseline", "twice"], idPattern: DEFAULT_ID_PATTERN });
    const [baseline, twice] = result.steps.map((step) => `${step.mode} ${step.result} ${step.reason}`);
    assert.match(baseline, /^baseline failed status recorded 201, got no answer \(\w+\)$/);
    // The first send already failed (baseline's finding), so twice does not resend it.
    assert.equal(twice, "twice skipped the first send already got 0, so a resend says nothing about repeating it");
    assert.equal(result.steps.length, 2);
  } finally {
    dropping.close();
  }
});

test("a stream (server-sent events) the server keeps open is judged on its status, not waited on forever", { timeout: 10_000 }, async () => {
  const streaming = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
  });
  await new Promise((done) => streaming.listen(0, "127.0.0.1", () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (streaming.address()).port}`;
  try {
    const cases = [recorded({ id: "c1", session: "s", seq: 1, method: "GET", route: "/events", path: "/events", status: 200, json: null })];
    const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: url, adapter: { signIn: async () => ({}) }, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN });
    assert.deepEqual(result.steps.map((step) => step.result), ["passed"]);
  } finally {
    streaming.closeAllConnections();
    streaming.close();
  }
});

test("a step whose body capture did not keep is skipped with the reason, not sent as a placeholder", async () => {
  const cases = notesSession().map((item, index) => (index === 2 ? { ...item, request: { ...item.request, body: { $omitted: "not json" } } } : item));
  const result = await replay(cases);
  assert.deepEqual(result.steps.map((step) => `${step.result} ${step.reason ?? ""}`.trim()), [
    "passed", "passed", "skipped the request body was not recorded (not json), so it cannot be sent again", "passed", "passed",
  ]);
  assert.ok(!target.log.some((entry) => entry.path.endsWith("/comments")));
});

test("a refusal is compared by its error code, not by the optional fields of its body", async () => {
  const refusing = createServer((request, response) => {
    const body = request.url === "/a" ? { code: "invalid_request", detail: "x" } : { code: "not_allowed", detail: "y", fix: "z" };
    response.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((done) => refusing.listen(0, "127.0.0.1", () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (refusing.address()).port}`;
  try {
    const refusal = (/** @type {string} */ path, /** @type {string} */ code) => ({
      ...recorded({ id: path, session: "s", seq: path.length, method: "POST", route: path, path, body: {}, status: 422, json: { code, detail: "x", fix: "w", errors: [] } }),
      outcome: /** @type {const} */ ("rejected"),
    });
    const cases = [refusal("/a", "invalid_request"), refusal("/bb", "invalid_request")].map((item) => ({ ...item, response: { ...item.response, errorCode: "invalid_request" } }));
    const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: url, adapter: { signIn: async () => ({}) }, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN });
    assert.deepEqual(result.steps.map((step) => `${step.result} ${step.reason ?? ""}`.trim()), ["passed", "failed error code recorded invalid_request, got not_allowed"]);
  } finally {
    refusing.close();
  }
});

test("for the contract's echo check only credential headers count as sent secrets, not an account selector or origin", async () => {
  const signIn = async () => ({ cookie: "sid=session-secret-123", "lucra-account": "acct_8fK2abQ9xyz", origin: "https://app.example.test", authorization: "Bearer token-abc-123" });
  const [result] = await replaySessions({ sessions: [{ session: "s", cases: notesSession() }], target: target.url, adapter: { ...adapter, signIn }, modes: ["contract"], idPattern: DEFAULT_ID_PATTERN });
  assert.deepEqual(result.live?.["s-notes-1"]?.sent, ["sid=session-secret-123", "Bearer token-abc-123"]);
});

test("a redirect is compared as the recorded answer, not followed to its target", async () => {
  const redirecting = createServer((_request, response) => response.writeHead(302, { location: "https://app.unreachable.invalid/inbox" }).end());
  await new Promise((done) => redirecting.listen(0, "127.0.0.1", () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (redirecting.address()).port}`;
  try {
    const cases = [recorded({ id: "c1", session: "s", seq: 1, method: "GET", route: "/clicks/:id", path: "/clicks/ntf_8fK2abQ9", status: 302, json: null })];
    const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: url, adapter: { signIn: async () => ({}), resolveId: async (id) => id }, modes: ["baseline"], idPattern: DEFAULT_ID_PATTERN });
    assert.deepEqual(result.steps.map((step) => `${step.result} ${step.reason ?? ""}`), ["passed "]);
  } finally {
    redirecting.close();
  }
});

test("a server error production recorded fails while it still happens and passes once fixed, whatever the fixed answer", async () => {
  const [create, , , archive] = notesSession();
  // Production archived the note twice, and the second time crashed.
  const again = { ...recorded({ id: "s-notes-5", session: "s-notes", seq: 1005, method: "POST", route: "/notes/:id/archive", path: "/notes/note_prodA1/archive", status: 500, json: { error: "already archived" } }) };
  target.bugs.add("twice");
  assert.deepEqual(failures(await replay([create, archive, again])), ["baseline s-notes-5 still fails as production did: status recorded 500, got 500"]);
  target.bugs.clear();
  assert.deepEqual(failures(await replay([create, archive, again])), [], "fixed: the second archive no longer crashes");
});
