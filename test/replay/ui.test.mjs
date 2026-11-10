// @ts-check
// The `ui` mode against a tiny web app in front of the toy target. Needs the installed Google Chrome.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { replaySessions } from "../../replay/run.mjs";
import { DEFAULT_ID_PATTERN } from "../../shared/shape.mjs";
import * as adapter from "./adapter.mjs";
import { recorded, startTarget } from "./helpers.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hasChrome = existsSync("/Applications/Google Chrome.app")
  || ["chrome", "google-chrome"].some((name) => spawnSync("which", [name]).status === 0);

/** @type {Awaited<ReturnType<typeof startTarget>>} */
let target;
/** How the web app misbehaves: "healthy", "renamed", "throws", "console" or "500". */
let mode = "healthy";
let appUrl = "";
/** @type {import("node:http").Server} */
let app;

/** The notes page: an Open button that reads through /api, and a New button that writes. */
const html = () => `<!doctype html><link rel="icon" href="data:,"><title>notes</title>
<button id="open" data-intersite="${mode === "renamed" ? "note.view" : "note.open"}">Open</button>
<button id="create" data-intersite="note.create">New</button><p id="out"></p>
<script>
${mode === "throws" ? 'throw new Error("boom on load");' : ""}
document.getElementById("open").onclick = async () => {
  ${mode === "console" ? 'console.error("handler failed");' : ""}
  const response = await fetch("/api/notes/note_seed01");
  document.getElementById("out").textContent = response.status;
};
document.getElementById("create").onclick = () => fetch("/api/notes", { method: "POST", body: JSON.stringify({ text: "x" }) });
</script>`;

before(async () => {
  target = await startTarget();
  app = createServer(async (req, res) => {
    const path = req.url ?? "/";
    if (!path.startsWith("/api/")) return res.writeHead(200, { "content-type": "text/html" }).end(html());
    if (mode === "500") return res.writeHead(500).end("{}");
    let body = "";
    for await (const chunk of req) body += chunk;
    const tenant = req.headers["x-tenant"];
    const answer = await fetch(target.url + path.slice(4), {
      method: req.method, body: body || undefined, headers: typeof tenant === "string" ? { "x-tenant": tenant } : {},
    });
    res.writeHead(answer.status, { "content-type": "application/json" }).end(await answer.text());
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", () => done(undefined)));
  appUrl = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.address()).port}`;
});
after(() => Promise.all([target.close(), new Promise((done) => app.close(done))]));
beforeEach(() => { mode = "healthy"; target.log.length = 0; });

const page = "/notes/note_prod99";
const session = [
  { ...recorded({ id: "u-1", session: "u", seq: 1, method: "GET", route: "/notes/:id", path: "/notes/note_prod99", status: 200, json: { note: { id: "note_prod99", text: "seed" } } }), action: { name: "note.open", page } },
  { ...recorded({ id: "u-2", session: "u", seq: 2, method: "POST", route: "/notes", path: "/notes", body: { text: "x" }, status: 201, json: { note: { id: "note_prodU2", text: "x" } } }), action: { name: "note.create", page } },
  recorded({ id: "u-3", session: "u", seq: 3, method: "UI", route: page, path: page, status: 0, json: null }),
  { ...recorded({ id: "u-4", session: "u", seq: 4, method: "GET", route: "/x/:slug", path: "/x/hello-world", status: 200, json: {} }), action: { name: "x.open", page: "/x/_" } },
];

/** @param {string} [cwd] */
async function replayUi(cwd = root) {
  assert.ok(hasChrome, "the ui replay tests need Google Chrome installed (https://www.google.com/chrome/)");
  const [result] = await replaySessions({
    sessions: [{ session: "u", cases: session }], target: target.url, uiTarget: appUrl, adapter, modes: ["ui"], idPattern: DEFAULT_ID_PATTERN, cwd,
  });
  return result.steps.map((step) => `${step.caseId} ${step.method} ${step.route} ${step.result}${step.reason ? `: ${step.reason}` : ""}`);
}

test("a healthy page passes; a read action is clicked signed in, a write is only checked, a _ page is skipped", async () => {
  assert.deepEqual(await replayUi(), [
    "u-1 note.open /notes/note_prod99 passed",
    "u-2 note.create /notes/note_prod99 passed",
    "u-3 UI /notes/note_prod99 passed",
    "u-4 x.open /x/_ skipped: page /x/_ has a segment capture reduced to _, which cannot be resolved",
  ]);
  const reads = target.log.filter((entry) => entry.method === "GET" && entry.path === "/notes/note_seed01");
  assert.equal(reads.length, 1, "the Open button was clicked once, on the page with the remapped ID");
  assert.equal(reads[0].headers["x-tenant"], "a", "the adapter's signIn headers reached the API");
  assert.ok(target.log.every((entry) => entry.method !== "POST"), "the New button, which writes, was not clicked");
});

test("an element that lost its data-intersite name is reported as not found", async () => {
  mode = "renamed";
  assert.equal((await replayUi())[0], "u-1 note.open /notes/note_prod99 failed: action note.open not found on /notes/note_prod99");
});

test("a page that throws on load is reported", async () => {
  mode = "throws";
  assert.equal((await replayUi())[0], "u-1 note.open /notes/note_prod99 failed: page error: boom on load");
});

test("a click whose handler logs console.error or gets a 500 is reported", async () => {
  mode = "console";
  assert.deepEqual((await replayUi()).slice(0, 2), [
    "u-1 note.open /notes/note_prod99 failed: console error: handler failed",
    "u-2 note.create /notes/note_prod99 passed",
  ]);
  mode = "500";
  assert.equal((await replayUi())[0], "u-1 note.open /notes/note_prod99 failed: 500 from GET /api/notes/note_seed01");
});

test("without playwright-core in the project, ui mode says what to install", async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "intersite-ui-")));
  await assert.rejects(replayUi(empty), { message: "ui mode needs playwright-core in the project: npm install --save-dev playwright-core" });
});
