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
