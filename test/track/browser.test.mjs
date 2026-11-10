// @ts-check
// The tracker in a real browser: real DOM events, `closest`, sessionStorage and fetch. Needs the installed Google Chrome.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";

import { chromium } from "playwright-core";

const root = new URL("../..", import.meta.url);

const html = `<!doctype html><link rel="icon" href="data:,"><title>app</title>
<div data-intersite="note.create"><button id="go"><span id="inner">Go</span></button></div>
<button id="boom" data-intersite="note.delete">Boom</button>
<script type="module">
import { createTracker } from "/track/index.mjs";
const tracker = createTracker({ onUi: (event) => fetch("/ui", { method: "POST", body: JSON.stringify(event) }) });
document.getElementById("go").onclick = () => tracker.fetch("/api/echo").then(() => { document.title = "sent"; });
document.getElementById("boom").onclick = () => { throw new TypeError("the customer's secret message"); };
document.title = "ready";
</script>`;

test("in Chrome, a click inside a named element stamps the request, and a thrown error is reported by name only", async (t) => {
  /** @type {import("node:http").IncomingHttpHeaders[]} */
  const api = [];
  /** @type {any[]} */
  const ui = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path.startsWith("/track/") || path.startsWith("/shared/")) {
      return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(new URL(`.${path}`, root)));
    }
    if (path === "/api/echo") {
      api.push(req.headers);
      return res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (path === "/ui") {
      let text = "";
      for await (const chunk of req) text += chunk;
      ui.push(JSON.parse(text));
      return res.writeHead(204).end();
    }
    return res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const browser = await chromium.launch({ channel: "chrome", headless: true }).catch((error) => {
    throw new Error(`the tracker's browser test needs Google Chrome installed: ${error.message.split("\n")[0]}`);
  });
  t.after(async () => {
    await browser.close();
    await new Promise((done) => server.close(done));
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/app/users/alice@example.com`);
  await page.waitForFunction(() => document.title === "ready");

  await page.click("#inner");
  await page.waitForFunction(() => document.title === "sent");
  await page.evaluate(() => { document.title = "again"; });
  await page.click("#inner");
  await page.waitForFunction(() => document.title === "sent");

  assert.equal(api.length, 2);
  assert.equal(api[0]["x-intersite-action"], "note.create");
  assert.equal(api[0]["x-intersite-page"], "/app/users/_");
  assert.match(String(api[0]["x-intersite-session"]), /^[0-9a-f]{16,}$/);
  assert.equal(api[1]["x-intersite-session"], api[0]["x-intersite-session"]);

  await page.click("#boom");
  await page.waitForResponse((response) => response.url().endsWith("/ui"));
  assert.deepEqual(ui, [{ page: "/app/users/_", outcome: "error", name: "note.delete", errorName: "TypeError" }]);
});
