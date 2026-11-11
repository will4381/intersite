// @ts-check
// Its own file: the warning is once per process, so other tests' failing collectors must not have used it up.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCapture } from "../../capture/index.mjs";

test("a collector that refuses or cannot be reached is reported once on stderr, without the token, and record still resolves", async () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    for (const fetcher of [{ fetch: async () => new Response("no", { status: 500 }) }, { fetch: async () => { throw new TypeError("fetch failed"); } }]) {
      const instance = createCapture({ project: "acme", url: "http://127.0.0.1:8790", token: "ingest-secret", release: "r", sample: 1, fetcher });
      const request = new Request("https://a.test/v1/x");
      assert.equal(await instance.record({ request, response: Response.json({ ok: 1 }), route: "/v1/x", session: "s" }), undefined);
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines, ["intersite capture: cases are not reaching http://127.0.0.1:8790/v1/cases (the collector answered 500); check the collector URL and token, and that this runtime may call it"]);
});
