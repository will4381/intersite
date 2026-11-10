// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startLocalCollector } from "../../collector/local.mjs";

const DAY = 86_400_000;
/** @type {Awaited<ReturnType<typeof startLocalCollector>>} */
let collector;
before(async () => {
  collector = await startLocalCollector();
});
after(() => collector?.stop());

/** @param {Record<string, any>} [over] */
function makeCase(over = {}) {
  const { route = "/things/:id", atMs = Date.now(), ...rest } = over;
  return {
    v: 1,
    id: `req-${Math.random().toString(36).slice(2)}`,
    project: "p",
    session: "s1",
    seq: atMs,
    at: new Date(atMs).toISOString(),
    release: "abc",
    outcome: "ok",
    actor: { kind: "creator" },
    request: { method: "GET", route, path: "/things/1", query: {}, body: null },
    response: { status: 200, shape: { id: "string" }, ids: {} },
    ttlDays: 14,
    ...rest,
  };
}

/** @param {string} method @param {string} path @param {string | undefined} token @param {unknown} [body] @param {string} [base] */
async function call(method, path, token, body, base = collector.url) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: /** @type {any} */ (await response.json()) };
}
/** @param {unknown[]} cases @param {string} [base] @param {string} [token] */
const ingest = (cases, base, token = collector.ingestToken) => call("POST", "/v1/cases", token, { cases }, base);
/** @param {string} query */
const sessions = async (query) => (await call("GET", `/v1/sessions?${query}`, collector.readToken)).body.sessions;

test("auth: missing or wrong token is 401, each token only does its own job", async () => {
  assert.deepEqual((await call("GET", "/health", undefined)).body, { ok: true });
  assert.equal((await call("GET", "/v1/sessions?project=p", undefined)).status, 401);
  assert.equal((await call("GET", "/v1/sessions?project=p", "nope")).status, 401);
  assert.equal((await call("POST", "/v1/cases", "nope", { cases: [] })).status, 401);
  assert.equal((await call("GET", "/v1/sessions?project=p", collector.ingestToken)).status, 403);
  assert.equal((await call("POST", "/v1/results", collector.ingestToken, { project: "p", release: "x", results: [] })).status, 403);
  assert.equal((await ingest([makeCase()], undefined, collector.readToken)).status, 403);
  assert.equal((await call("GET", "/v1/sessions?project=p", collector.readToken)).status, 200);
});

test("ingest: stores valid cases, drops invalid with its reason, ignores duplicates, refuses over 50", async () => {
  const good = makeCase({ project: "ing", id: "good-1" });
  const bad = makeCase({ project: "ing", id: "bad-1", ttlDays: 0 });
  const first = await ingest([good, bad]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { accepted: 1, dropped: [{ id: "bad-1", reason: "ttlDays must be 1 to 365" }] });
  assert.deepEqual((await call("GET", "/v1/cases/good-1?project=ing", collector.readToken)).body.cases, [good]);
  assert.deepEqual((await ingest([good])).body, { accepted: 0, dropped: [] });
  const tooMany = Array.from({ length: 51 }, (_, i) => makeCase({ project: "ing", id: `many-${i}` }));
  assert.equal((await ingest(tooMany)).status, 413);
  assert.equal((await call("GET", "/v1/cases/many-0?project=ing", collector.readToken)).status, 404);
});

test("ingest: the daily cap per outcome class drops the overflow with reason cap", async () => {
  const capped = await startLocalCollector({ dailyCap: { ok: 2, other: 1 } });
  try {
    const cases = ["a", "b", "c"].map((id) => makeCase({ id, project: "cap" }));
    const errors = ["d", "e"].map((id) => makeCase({ id, project: "cap", outcome: "error" }));
    const result = await ingest([...cases, ...errors], capped.url, capped.ingestToken);
    assert.deepEqual(result.body, { accepted: 3, dropped: [{ id: "c", reason: "cap" }, { id: "e", reason: "cap" }] });
    const later = await ingest([makeCase({ id: "f", project: "cap" })], capped.url, capped.ingestToken);
    assert.deepEqual(later.body.dropped, [{ id: "f", reason: "cap" }]);
  } finally {
    await capped.stop();
  }
});

test("sessions: filters by outcome, route and since; cases come back in seq order", async () => {
  const now = Date.now();
  await ingest([
    makeCase({ project: "q", session: "s1", id: "s1-b", seq: 2, route: "/a" }),
    makeCase({ project: "q", session: "s1", id: "s1-a", seq: 1, route: "/a" }),
    makeCase({ project: "q", session: "s2", id: "s2-a", seq: 1, route: "/b" }),
    makeCase({ project: "q", session: "s2", id: "s2-b", seq: 2, route: "/b", outcome: "error" }),
    makeCase({ project: "q", session: "s3", id: "s3-a", atMs: now - 10 * DAY, route: "/a" }),
  ]);
  /** @param {any[]} found */
  const names = (found) => found.map((s) => s.session).sort();
  assert.deepEqual(names(await sessions("project=q")), ["s1", "s2", "s3"]);
  const errored = await sessions("project=q&outcome=error");
  assert.deepEqual(names(errored), ["s2"]);
  assert.deepEqual(errored[0].cases.map((/** @type {any} */ c) => c.id), ["s2-a", "s2-b"]);
  assert.deepEqual(names(await sessions("project=q&outcome=error&outcome=warn")), ["s2"]);
  const onA = await sessions("project=q&route=%2Fa");
  assert.deepEqual(names(onA), ["s1", "s3"]);
  assert.deepEqual(onA.find((/** @type {any} */ s) => s.session === "s1").cases.map((/** @type {any} */ c) => c.id), ["s1-a", "s1-b"]);
  assert.deepEqual(names(await sessions(`project=q&since=${new Date(now - DAY).toISOString()}`)), ["s1", "s2"]);
  assert.equal((await call("GET", "/v1/sessions?project=q&outcome=bogus", collector.readToken)).status, 400);
});

test("sessions: same seed gives the same sample, a different seed can differ, sample is capped at 200", async () => {
  for (let batch = 0; batch < 5; batch++) {
    const cases = Array.from({ length: 50 }, (_, i) => makeCase({ project: "many", session: `m${batch * 50 + i}`, id: `m-${batch}-${i}` }));
    assert.equal((await ingest(cases)).body.accepted, 50);
  }
  /** @param {number} seed */
  const pick = async (seed) => (await sessions(`project=many&sample=5&seed=${seed}`)).map((/** @type {any} */ s) => s.session);
  const first = await pick(1);
  assert.equal(first.length, 5);
  assert.deepEqual(await pick(1), first);
  const others = await Promise.all([2, 3, 4, 5].map(pick));
  assert.ok(others.some((other) => JSON.stringify(other) !== JSON.stringify(first)));
  assert.equal((await sessions("project=many&sample=500&seed=1")).length, 200);
  assert.equal((await sessions("project=many")).length, 20);
});

test("GET /v1/cases/:id returns the case and only the earlier cases of its session", async () => {
  await ingest([1, 2, 3].map((seq) => makeCase({ project: "hist", session: "h", id: `h${seq}`, seq })));
  const found = await call("GET", "/v1/cases/h2?project=hist", collector.readToken);
  assert.equal(found.body.session, "h");
  assert.deepEqual(found.body.cases.map((/** @type {any} */ c) => c.id), ["h1", "h2"]);
  assert.equal((await call("GET", "/v1/cases/h2?project=other", collector.readToken)).status, 404);
});

test("results: a failed session leaves known_good=1 and returns after a later pass", async () => {
  await ingest([makeCase({ project: "res", session: "ra", id: "ra1" }), makeCase({ project: "res", session: "rb", id: "rb1" })]);
  /** @param {{ session: string, pass: boolean }[]} results */
  const record = (results) => call("POST", "/v1/results", collector.readToken, { project: "res", release: "r1", results });
  const good = async () => (await sessions("project=res&known_good=1")).map((/** @type {any} */ s) => s.session).sort();
  assert.deepEqual((await record([{ session: "ra", pass: true }, { session: "rb", pass: true }])).body, { recorded: 2 });
  assert.deepEqual(await good(), ["ra", "rb"]);
  await record([{ session: "ra", pass: false }]);
  assert.deepEqual(await good(), ["rb"]);
  await record([{ session: "ra", pass: true }]);
  assert.deepEqual(await good(), ["ra", "rb"]);
});

test("cleanup: deletes expired cases, keeps pinned and unexpired ones", async () => {
  const old = Date.now() - 30 * DAY;
  await ingest([
    makeCase({ project: "gc", session: "g1", id: "expired", atMs: old, ttlDays: 1 }),
    makeCase({ project: "gc", session: "g2", id: "pinned", atMs: old, ttlDays: 1 }),
    makeCase({ project: "gc", session: "g3", id: "fresh" }),
  ]);
  assert.deepEqual((await call("POST", "/v1/cases/pinned/pin", collector.readToken, { project: "gc", pinned: true })).body, { pinned: true });
  assert.equal((await call("POST", "/v1/cases/nope/pin", collector.readToken, { project: "gc", pinned: true })).status, 404);
  assert.equal((await fetch(`${collector.url}/cdn-cgi/local/scheduled`)).status, 200);
  const status = async (/** @type {string} */ id) => (await call("GET", `/v1/cases/${id}?project=gc`, collector.readToken)).status;
  assert.equal(await status("expired"), 404);
  assert.equal(await status("pinned"), 200);
  assert.equal(await status("fresh"), 200);
});

test("intersite deploy --dry-run prints the generated config and runs nothing", () => {
  const project = mkdtempSync(join(tmpdir(), "intersite-deploy-"));
  writeFileSync(join(project, "intersite.json"), JSON.stringify({ project: "demo", collector: { name: "demo-collector", domain: "intersite.example.com" } }));
  // A fake npx on PATH records any call; a dry run must never reach it.
  const bin = mkdtempSync(join(tmpdir(), "intersite-bin-"));
  const marker = join(bin, "called");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> "${marker}"\n`);
  chmodSync(join(bin, "npx"), 0o755);
  const cli = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "deploy", "--dry-run"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"name": "demo-collector"/);
  assert.match(run.stdout, /"pattern": "intersite\.example\.com",\s*"custom_domain": true/);
  assert.match(run.stdout, /wrangler@4 deploy -c /);
  assert.equal(existsSync(marker), false);
  const written = readFileSync(join(project, ".intersite", "wrangler.jsonc"), "utf8");
  assert.match(written, /"crons": \[\s*"17 3 \* \* \*"\s*\]/);
});
