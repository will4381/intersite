// @ts-check
// Capture inside the real Workers runtime (workerd, through the miniflare that wrangler ships), not Node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { convertV4MiniflareOptions, Miniflare } from "miniflare";

import { caseProblem } from "../../shared/case.mjs";

const root = new URL("../..", import.meta.url);
const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(readFileSync(new URL("collector/wrangler.jsonc", root), "utf8"))?.[1];

test("in workerd, a Worker records a scrubbed case after responding, and the client still gets its response", async (t) => {
  /** @type {(body: any) => void} */
  let received = () => {};
  const arrived = new Promise((done) => { received = done; });
  const collector = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accepted: 1, dropped: [] }));
    received({ auth: req.headers.authorization, path: req.url, body: JSON.parse(text) });
  });
  await new Promise((done) => collector.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (collector.address());

  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      // Listed by hand: miniflare 5 does not follow imports. Entry first.
      modules: ["test/capture/worker-fixture.mjs", "capture/index.mjs", "capture/scrub.mjs", "shared/case.mjs", "shared/shape.mjs"].map((file) => ({
        type: /** @type {const} */ ("ESModule"),
        path: fileURLToPath(new URL(file, root)),
      })),
      modulesRoot: fileURLToPath(root),
      compatibilityDate,
      bindings: { COLLECTOR: `http://127.0.0.1:${port}` },
    }],
    host: "127.0.0.1",
    port: 0,
  }));
  t.after(async () => {
    await mf.dispose();
    await new Promise((done) => collector.close(done));
  });
  const url = await mf.ready;

  const response = await fetch(new URL("/notes", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer real-user-token", "x-intersite-action": "note.create", "x-intersite-page": "/notes" },
    body: JSON.stringify({ text: "hi", email: "real.person@gmail.com" }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { note: { id: "note_abc12345", text: "stored" } });

  const sent = await arrived;
  assert.equal(sent.auth, "Bearer ingest");
  assert.equal(sent.path, "/v1/cases");
  const [recorded] = sent.body.cases;
  assert.equal(caseProblem(recorded), undefined);
  assert.equal(recorded.response.status, 201);
  assert.deepEqual(recorded.response.ids, { "/note/id": "note_abc12345" });
  assert.deepEqual(recorded.action, { name: "note.create", page: "/notes" });
  const stored = JSON.stringify(recorded);
  for (const secret of ["real.person", "real-user-token", "user-7"]) assert.ok(!stored.includes(secret), `${secret} left the Worker`);
});
