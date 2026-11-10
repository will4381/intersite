// @ts-check
// The local loop a project gets with no setup beyond a config file: named actions in the browser, capture on the
// server, the SQLite collector, and the CLI reading the project's own case database without anything running.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createCapture } from "../capture/index.mjs";
import { startNodeCollector } from "../collector/node.mjs";
import { createTracker } from "../track/index.mjs";
import { startTarget } from "./replay/helpers.mjs";

const bin = fileURLToPath(new URL("../bin/intersite.mjs", import.meta.url));
const adapter = fileURLToPath(new URL("./replay/adapter.mjs", import.meta.url));

/** Runs the real CLI in `cwd`. @param {string} cwd @param {string[]} args @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
function cli(cwd, args) {
  return new Promise((done) => {
    execFile(process.execPath, [bin, ...args], { cwd }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

/** The few DOM pieces the tracker touches. */
function page() {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  const events = { addEventListener: (/** @type {string} */ type, /** @type {Function} */ listener) => void listeners.set(type, listener), removeEventListener: () => {} };
  /** @type {Map<string, string>} */
  const stored = new Map();
  return {
    events,
    storage: { getItem: (/** @type {string} */ key) => stored.get(key) ?? null, setItem: (/** @type {string} */ key, /** @type {string} */ value) => void stored.set(key, value) },
    /** A click on an element carrying `data-intersite="<name>"`. @param {string} name */
    click(name) {
      const element = { getAttribute: () => name, closest() { return this; } };
      listeners.get("click")?.({ target: element });
    },
  };
}

test("named actions flow from the browser to stored cases, and the CLI reads them with no collector running", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-local-")));
  mkdirSync(join(dir, ".intersite"));
  const production = await startTarget();
  const local = await startTarget();
  const collector = await startNodeCollector({
    port: 0, dbPath: join(dir, ".intersite/cases.db"), ingestToken: "local-ingest", readToken: "local-read", dailyCap: { ok: 5000, other: 5000 },
  });
  t.after(() => Promise.all([production.close(), local.close()]));
  writeFileSync(join(dir, "intersite.yml"), [
    "project: demo",
    `collector: { url: "${collector.url}" }`,
    "replay:",
    `  target: ${local.url}`,
    `  adapter: ${relative(dir, adapter)}`,
    "",
  ].join("\n"));

  // The server: handles a request, then records it the way the README shows.
  const capture = createCapture({ project: "demo", url: collector.url, token: "local-ingest", release: "prod1", sample: 1 });
  let tick = Date.parse("2026-11-10T12:00:00.000Z");
  /** @type {typeof fetch} */
  const server = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("x-tenant", "a");
    const copy = request.clone();
    const response = await fetch(request);
    const route = new URL(request.url).pathname === "/notes" ? "/notes" : "/notes/:id";
    await capture.record({ request: copy, response, route, actor: { kind: "member" }, at: new Date((tick += 10)) });
    return response;
  };

  // The browser: two named actions, each followed by the request it causes.
  const dom = page();
  const location = { origin: production.url, href: `${production.url}/notes`, pathname: "/notes" };
  const tracker = createTracker({ fetch: server, document: dom.events, window: dom.events, storage: dom.storage, location });
  for (let i = 0; i < 2; i++) await fetch(`${production.url}/notes`, { method: "POST", headers: { "x-tenant": "a" }, body: JSON.stringify({ text: "old" }) });
  dom.click("note.create");
  const created = await (await tracker.fetch(`${production.url}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).json();
  dom.click("note.open");
  await tracker.fetch(`${production.url}/notes/${created.note.id}`);
  await collector.stop();

  const actions = await cli(dir, ["actions"]);
  assert.equal(actions.stderr, "");
  assert.deepEqual(actions.stdout.trim().split("\n").map((line) => line.replace(/ last=.*$/, "")), [
    "note.create /notes ok=1 warn=0 rejected=0 error=0",
    "note.open /notes ok=1 warn=0 rejected=0 error=0",
  ]);

  const healthy = await cli(dir, ["replay", "--action", "note.open", "--seed", "1"]);
  assert.equal(healthy.stdout, "ok replay: 1 sessions; steps: 3 passed, 0 failed, 0 skipped; seed 1\n");
  assert.equal(healthy.code, 0); // two requests and the adapter's invariant
  // Production's note_000003 became the local server's note_000001 on the way through.
  assert.ok(local.log.some((entry) => entry.method === "GET" && entry.path === "/notes/note_000001"));

  local.bugs.add("shape");
  const broken = await cli(dir, ["replay", "--action", "note.open", "--seed", "1"]);
  assert.equal(broken.code, 1);
  const fail = broken.stdout.split("\n").find((line) => line.startsWith("FAIL"));
  assert.match(String(fail), /^FAIL baseline \S+ GET \/notes\/:id: \/note\/text: missing \| rerun: intersite replay --id \S+ --mode baseline$/);

  const caseId = String(fail).split(" ")[2];
  const rerun = await cli(dir, ["replay", "--id", caseId, "--mode", "baseline", "--verbose"]);
  assert.equal(rerun.code, 1);
  assert.match(rerun.stdout, /\n {2}sent: GET \/notes\/note_000001\n {2}got: 200 \{"note":\{"id":"note_000001","body":"hi"\}\}/);

  assert.equal((await cli(dir, ["pin", caseId])).stdout, `ok pin: ${caseId} pinned\n`);
});
