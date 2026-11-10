// @ts-check
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { startNodeCollector } from "../../collector/node.mjs";
import { makeCase } from "../collector/make-case.mjs";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));

test("audit lists what capture kept, widest key first, and leaves fakes and IDs out", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-audit-")));
  mkdirSync(join(dir, ".intersite"));
  const collector = await startNodeCollector({ port: 0, dbPath: join(dir, ".intersite/cases.db"), ingestToken: "local-ingest", readToken: "local-read", dailyCap: { ok: 5000, other: 5000 } });
  writeFileSync(join(dir, "intersite.yml"), `project: p\ncollector: { url: "${collector.url}" }\n`);
  const handles = ["maria", "jdoe", "sam"];
  const cases = handles.map((who, index) => makeCase({
    id: `c${index}`, session: `s${index}`,
    request: {
      method: "POST", route: "/teams/:team/notes", path: "/teams/blue/notes", query: { sort: "newest" },
      body: { who, status: "active", note: "text-0a1b2c3d", email: "u0a1b2c3d@example.test", owner: "user_8fK2abQ9", tags: [{ label: "urgent" }] },
    },
  }));
  const sent = await fetch(`${collector.url}/v1/cases`, { method: "POST", headers: { authorization: "Bearer local-ingest", "content-type": "application/json" }, body: JSON.stringify({ cases }) });
  assert.equal((await sent.json()).accepted, 3);
  await collector.stop();

  const out = await new Promise((done) => execFile(process.execPath, [bin, "audit"], { cwd: dir }, (_error, stdout) => done(stdout)));
  assert.deepEqual(String(out).trim().split("\n"), [
    'body.who: 3 kept values: "jdoe", "maria", "sam"',
    'body.status: 1 kept value: "active"',
    'body.tags.label: 1 kept value: "urgent"',
    'path /teams/:team/notes: 1 kept value: "blue"',
    'query.sort: 1 kept value: "newest"',
    "ok audit: 3 cases, 5 keys with kept values; a key that holds personal data goes in capture.redactKeys; an enum that was faked goes in capture.keepKeys",
  ]);
});
