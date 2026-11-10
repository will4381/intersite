// @ts-check
// The route suite runs against both runtimes from this one list, so workerd and Node cannot drift.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startLocalCollector } from "../../collector/local.mjs";
import { startNodeCollector } from "../../collector/node.mjs";
import { makeCase } from "./make-case.mjs";

const DAY = 86_400_000;

/** @typedef {{ url: string, ingestToken: string, readToken: string, stop: () => Promise<unknown>, cleanup: () => Promise<unknown> }} Running */
/** @type {{ name: string, start: (options?: { dailyCap?: { ok?: number, other?: number } }) => Promise<Running> }[]} */
const RUNTIMES = [
  {
    name: "workerd",
    async start(options) {
      const running = await startLocalCollector(options);
      return { ...running, cleanup: async () => assert.equal((await fetch(`${running.url}/cdn-cgi/local/scheduled`)).status, 200) };
    },
  },
  {
    name: "node",
    async start(options) {
      const tokens = { ingestToken: randomBytes(24).toString("base64url"), readToken: randomBytes(24).toString("base64url") };
      return { ...tokens, ...(await startNodeCollector({ ...options, ...tokens })) };
    },
  },
];

for (const runtime of RUNTIMES) {
  describe(runtime.name, () => {
    /** @type {Running} */
    let collector;
    before(async () => {
      collector = await runtime.start();
    });
    after(() => collector?.stop());

    /** @param {string} method @param {string} path @param {string | undefined} token @param {unknown} [body] @param {string} [base] */
    async function call(method, path, token, body, base = collector.url) {
      const response = await fetch(base + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, headers: response.headers, body: /** @type {any} */ (await response.json()) };
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
      const capped = await runtime.start({ dailyCap: { ok: 2, other: 1 } });
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
      await collector.cleanup();
      const status = async (/** @type {string} */ id) => (await call("GET", `/v1/cases/${id}?project=gc`, collector.readToken)).status;
      assert.equal(await status("expired"), 404);
      assert.equal(await status("pinned"), 200);
      assert.equal(await status("fresh"), 200);
    });

    test("actions: stored on the case, filter sessions, and the inventory counts per outcome per name and page", async () => {
      const now = Date.now();
      const save = { name: "program.save", page: "/programs/_" };
      const ui = makeCase({
        project: "act", session: "a3", id: "ui-1", outcome: "error", action: save, atMs: now,
        request: { method: "UI", route: "/programs/_", path: "/programs/_", query: {}, body: null },
        response: { status: 0, shape: null, ids: {}, errorCode: "TypeError" },
      });
      await ingest([
        makeCase({ project: "act", session: "a1", id: "a1-1", action: save, atMs: now - 2000 }),
        makeCase({ project: "act", session: "a1", id: "a1-2", action: save, outcome: "warn", atMs: now - 1000 }),
        makeCase({ project: "act", session: "a2", id: "a2-1", action: { name: "program.open", page: "/programs" }, atMs: now - 10 * DAY }),
        makeCase({ project: "act", session: "a4", id: "a4-1" }),
        ui,
      ]);
      assert.deepEqual((await call("GET", "/v1/cases/ui-1?project=act", collector.readToken)).body.cases, [ui]);
      assert.deepEqual((await call("GET", "/v1/cases/a1-1?project=act", collector.readToken)).body.cases[0].action, save);
      const saved = await sessions("project=act&action=program.save");
      assert.deepEqual(saved.map((/** @type {any} */ s) => s.session).sort(), ["a1", "a3"]);
      assert.deepEqual((await sessions("project=act&action=program.save&outcome=error")).map((/** @type {any} */ s) => s.session), ["a3"]);

      const inventory = await call("GET", "/v1/actions?project=act", collector.readToken);
      assert.equal(inventory.status, 200);
      assert.deepEqual(inventory.body.actions, [
        { name: "program.save", page: "/programs/_", ok: 1, warn: 1, rejected: 0, error: 1, lastAt: ui.at },
        { name: "program.open", page: "/programs", ok: 1, warn: 0, rejected: 0, error: 0, lastAt: new Date(now - 10 * DAY).toISOString() },
      ]);
      const recent = await call("GET", `/v1/actions?project=act&since=${new Date(now - DAY).toISOString()}`, collector.readToken);
      assert.deepEqual(recent.body.actions.map((/** @type {any} */ a) => a.name), ["program.save"]);
      assert.equal((await call("GET", "/v1/actions?project=act&since=nope", collector.readToken)).status, 400);
      assert.equal((await call("GET", "/v1/actions?project=act", collector.ingestToken)).status, 403);
    });

    test("CORS: only POST /v1/cases answers preflight and carries the headers", async () => {
      const preflight = await fetch(`${collector.url}/v1/cases`, {
        method: "OPTIONS",
        headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
      const posted = await ingest([makeCase({ project: "cors" })]);
      assert.equal(posted.status, 200);
      assert.equal(posted.headers.get("access-control-allow-origin"), "*");
      const read = await call("GET", "/v1/sessions?project=cors", collector.readToken);
      assert.equal(read.status, 200);
      assert.equal(read.headers.get("access-control-allow-origin"), null);
    });
  });
}

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
