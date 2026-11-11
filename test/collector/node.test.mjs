// @ts-check
// What only the Node runtime has: a database file that outlives the process, and cleanup on start.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startNodeCollector } from "../../collector/node.mjs";
import { makeCase } from "./make-case.mjs";

const tokens = { ingestToken: "test-ingest", readToken: "test-read" };

/** @param {string} url @param {string} id */
const status = async (url, id) =>
  (await fetch(`${url}/v1/cases/${id}?project=p`, { headers: { authorization: `Bearer ${tokens.readToken}` } })).status;

test("node: cases persist across a restart, and cleanup on start deletes the expired ones", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "intersite-node-")), "cases.db");
  const first = await startNodeCollector({ dbPath, ...tokens });
  const posted = await fetch(`${first.url}/v1/cases`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.ingestToken}`, "content-type": "application/json" },
    body: JSON.stringify({ cases: [makeCase({ id: "kept" }), makeCase({ id: "old", session: "s2", atMs: Date.now() - 30 * 86_400_000, ttlDays: 1 })] }),
  });
  assert.deepEqual(await posted.json(), { accepted: 2, dropped: [] });
  assert.equal(await status(first.url, "old"), 200);
  await first.stop();

  const second = await startNodeCollector({ dbPath, ...tokens });
  try {
    assert.equal(await status(second.url, "kept"), 200);
    assert.equal(await status(second.url, "old"), 404);
  } finally {
    await second.stop();
  }
});

test("node: a chatty recent session does not crowd the other sessions out of the sample", async () => {
  const collector = await startNodeCollector({ ...tokens, dailyCap: { ok: 10_000, other: 10_000 } });
  try {
    const now = Date.now();
    const quiet = ["old1", "old2"].map((session, index) => makeCase({ id: session, session, atMs: now - 3_600_000 * (index + 1) }));
    const chatty = Array.from({ length: 5_050 }, (_, index) => makeCase({ id: `busy-${index}`, session: "busy", atMs: now - index }));
    const all = [...quiet, ...chatty];
    for (let index = 0; index < all.length; index += 50) {
      const body = JSON.stringify({ cases: all.slice(index, index + 50) });
      await fetch(`${collector.url}/v1/cases`, { method: "POST", headers: { authorization: `Bearer ${tokens.ingestToken}`, "content-type": "application/json" }, body });
    }
    const listed = await (await fetch(`${collector.url}/v1/sessions?project=p&sample=3&seed=1`, { headers: { authorization: `Bearer ${tokens.readToken}` } })).json();
    assert.deepEqual(listed.sessions.map((/** @type {{ session: string }} */ item) => item.session).sort(), ["busy", "old1", "old2"]);
  } finally {
    await collector.stop();
  }
});

test("node: the collector never times out an idle connection itself, so a client reusing one after a blocked event loop is not reset; stop still closes it", async () => {
  const collector = await startNodeCollector(tokens);
  const health = await fetch(`${collector.url}/health`);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get("connection"), "keep-alive");
  // With a server-side timeout, Node announces it here (`timeout=5`) and closes the socket when it passes: a command that
  // serves the collector in-process and blocks its loop with git (check's gates) then reuses that socket and gets ECONNRESET.
  assert.equal(health.headers.get("keep-alive"), null);
  await collector.stop();
});
