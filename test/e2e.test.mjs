// @ts-check
// The whole loop with the real parts: a "production" server records through capture into the real collector
// (workerd + D1, local), and replay pulls the session back out and runs it against a second, freshly seeded server.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCapture } from "../capture/index.mjs";
import { startLocalCollector } from "../collector/local.mjs";
import { listSessions, postResults } from "../replay/collector.mjs";
import { replaySessions } from "../replay/run.mjs";
import { DEFAULT_ID_PATTERN } from "../shared/shape.mjs";
import * as adapter from "./replay/adapter.mjs";
import { startTarget } from "./replay/helpers.mjs";

const EMAIL = "real.person@gmail.com";
const SESSION_SECRET = "Bearer prod-session-secret-9f8e7d";

test("capture → collector → replay: a real session is stored scrubbed, replays clean, and catches a regression", async (t) => {
  const collector = await startLocalCollector();
  const production = await startTarget();
  const local = await startTarget();
  t.after(() => Promise.all([collector.stop(), production.close(), local.close()]));

  const capture = createCapture({ project: "demo", url: collector.url, token: collector.ingestToken, release: "prod1", sample: 1 });
  let tick = Date.parse("2026-11-10T12:00:00.000Z");

  /** One production request, recorded the way a Worker would record it. @param {string} method @param {string} route @param {string} path @param {unknown} [body] */
  const serve = async (method, route, path, body) => {
    const request = new Request(production.url + path, {
      method,
      headers: { "x-tenant": "a", authorization: SESSION_SECRET, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const copy = request.clone();
    const response = await fetch(request);
    await capture.record({ request: copy, response, route, actor: { kind: "member" }, session: "user-42", at: new Date((tick += 10)) });
    return response.json();
  };

  // Production already has notes, so its IDs differ from the ones the local server will hand out.
  for (let i = 0; i < 2; i++) await fetch(`${production.url}/notes`, { method: "POST", headers: { "x-tenant": "a" }, body: JSON.stringify({ text: "old" }) });
  const { note } = await serve("POST", "/notes", "/notes", { text: "hi", email: EMAIL });
  assert.equal(note.id, "note_000003");
  await serve("GET", "/notes/:id", `/notes/${note.id}`);
  await serve("POST", "/notes/:id/comments", `/notes/${note.id}/comments`, { noteId: note.id, text: "c" });
  await serve("POST", "/notes/:id/archive", `/notes/${note.id}/archive`);

  const reader = { url: collector.url, token: collector.readToken, project: "demo" };
  const sessions = await listSessions(reader, []);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].cases.map((item) => `${item.request.method} ${item.request.route} ${item.response.status}`), [
    "POST /notes 201",
    "GET /notes/:id 200",
    "POST /notes/:id/comments 201",
    "POST /notes/:id/archive 200",
  ]);
  const stored = JSON.stringify(sessions);
  for (const secret of [EMAIL, "real.person", "prod-session-secret", "user-42"]) assert.ok(!stored.includes(secret), `${secret} reached the collector`);

  const replay = () => replaySessions({ sessions, target: local.url, adapter, modes: ["baseline", "twice", "cross-tenant"], idPattern: DEFAULT_ID_PATTERN });
  const failures = async () => (await replay()).flatMap((result) => result.steps).filter((step) => step.result !== "passed");

  assert.deepEqual(await failures(), []);
  // The local server made note_000001, so the recorded note_000003 had to be remapped for the later steps to pass.
  assert.ok(local.log.some((entry) => entry.path === "/notes/note_000001/archive"));
  assert.ok(local.log.every((entry) => !entry.path.includes("note_000003")));

  local.bugs.add("shape");
  const broken = await failures();
  assert.deepEqual(broken.map((step) => `${step.mode} ${step.route}: ${step.reason}`), ["baseline /notes/:id: /note/text: missing"]);
  local.bugs.delete("shape");

  await postResults(reader, "main1", [{ session: sessions[0].session, pass: false }]);
  assert.deepEqual(await listSessions(reader, [["known_good", "1"]]), []);
  await postResults(reader, "main2", [{ session: sessions[0].session, pass: true }]);
  assert.equal((await listSessions(reader, [["known_good", "1"]])).length, 1);
});
