// @ts-check
// The `ui` mode against a tiny web app in front of the toy target. Needs the installed Google Chrome.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePath = existsSync(macChrome) ? macChrome
  : ["google-chrome", "chrome"].map((name) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim()).find(Boolean) ?? "";
const hasChrome = chromePath !== "";

/** @type {Awaited<ReturnType<typeof startTarget>>} */
let target;
/** How the web app misbehaves: "healthy", "renamed", "throws", "console", "500", and on the form page "wrong-shape", "sends-nothing" or "no-color". "cookie" signs in by the `session` cookie instead of `x-tenant`, and its pages load a script from a third party. "assets" pages load a stylesheet, a web font, an image and a video. */
let mode = "healthy";
let appUrl = "";
/** @type {import("node:http").Server} */
let app;
/** The path of every request the app got. @type {string[]} */
const appPaths = [];
/** Requests the app turned away in "cookie" mode for lacking the session cookie. */
const rejected = [];
/** The `x-sign-in` header of each request the app got in "cookie" mode. */
const appSignIn = [];
/** A third-party server on another host and port; every request it gets, with its headers. @type {import("node:http").Server} */
let third;
let thirdUrl = "";
/** @type {import("node:http").IncomingHttpHeaders[]} */
const thirdSeen = [];
const thirdParty = () => (mode === "cookie" ? `<script src="${thirdUrl}/tag.js"></script>` : "")
  + (mode === "assets" ? '<link rel="stylesheet" href="/s.css"><img src="/i.png"><video src="/v.mp4" autoplay></video>' : "");

/** The new-note page: a form whose controls are named after the API's body keys; saving opens the new note. */
const form = () => `<!doctype html><link rel="icon" href="data:,"><title>new note</title>${thirdParty()}
<form data-intersite="note.add" id="f"><input name="text">
${mode === "no-color" ? "" : '<select name="color"><option>red</option><option>blue</option></select>'}
<input type="checkbox" id="pinned"><button>Save</button></form>
<script>
f.onsubmit = async (event) => {
  event.preventDefault();
  ${mode === "sends-nothing" ? "if (!f.dataset.ready) return;" : ""}
  const response = await fetch("/api/notes", { method: "POST", body: JSON.stringify(${mode === "wrong-shape" ? "{ note: { text: f.text.value } }" : '{ text: f.text.value, color: f.elements.color?.value, pinned: f.querySelector("#pinned").checked }'}) });
  if (response.ok) location.href = "/notes/" + (await response.json()).note.id;
};
</script>`;

/** The notes page: an Open button that reads the note in the address through /api, and a New button that writes. */
const html = () => `<!doctype html><link rel="icon" href="data:,"><title>notes</title>${thirdParty()}
<button id="open" data-intersite="${mode === "renamed" ? "note.view" : "note.open"}">Open</button>
<button id="create" data-intersite="note.create">New</button><p id="out"></p>
<script>
${mode === "throws" ? 'throw new Error("boom on load");' : ""}
document.getElementById("open").onclick = async () => {
  ${mode === "console" ? 'console.error("handler failed");' : ""}
  const response = await fetch("/api" + location.pathname);
  document.getElementById("out").textContent = response.status;
};
document.getElementById("create").onclick = () => fetch("/api/notes", { method: "POST", body: JSON.stringify({ text: "x" }) });
</script>`;

before(async () => {
  target = await startTarget();
  app = createServer(async (req, res) => {
    const path = req.url ?? "/";
    appPaths.push(path);
    if (path === "/s.css") return res.writeHead(200, { "content-type": "text/css" }).end("@font-face { font-family: f; src: url(/f.woff2) } body { font-family: f }");
    const signedIn = mode === "cookie" && /(?:^|; )session=abc(?:;|$)/.test(req.headers.cookie ?? "");
    if (mode === "cookie") appSignIn.push(req.headers["x-sign-in"]);
    if (mode === "cookie" && !signedIn) {
      rejected.push(`${req.method} ${path}`);
      return res.writeHead(401, { "content-type": "text/html" }).end("sign in");
    }
    if (!path.startsWith("/api/")) return res.writeHead(200, { "content-type": "text/html" }).end(path === "/new" ? form() : html());
    if (mode === "500") return res.writeHead(500).end("{}");
    let body = "";
    for await (const chunk of req) body += chunk;
    const tenant = signedIn ? "a" : req.headers["x-tenant"];
    const answer = await fetch(target.url + path.slice(4), {
      method: req.method, body: body || undefined, headers: typeof tenant === "string" ? { "x-tenant": tenant } : {},
    });
    res.writeHead(answer.status, { "content-type": "application/json" }).end(await answer.text());
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", () => done(undefined)));
  appUrl = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.address()).port}`;
  third = createServer((req, res) => {
    thirdSeen.push(req.headers);
    res.writeHead(200, { "content-type": "text/javascript" }).end();
  });
  await new Promise((done) => third.listen(0, "127.0.0.1", () => done(undefined)));
  // Another host as well as another port: a browser scopes cookies by host, so 127.0.0.1:<any port> shares them.
  thirdUrl = `http://localhost:${/** @type {import("node:net").AddressInfo} */ (third.address()).port}`;
});
after(() => Promise.all([target.close(), new Promise((done) => app.close(done)), new Promise((done) => third.close(done))]));
beforeEach(() => { mode = "healthy"; target.log.length = 0; rejected.length = 0; thirdSeen.length = 0; appSignIn.length = 0; appPaths.length = 0; });

const page = "/notes/note_prod99";
const session = [
  { ...recorded({ id: "u-1", session: "u", seq: 1, method: "GET", route: "/notes/:id", path: "/notes/note_prod99", status: 200, json: { note: { id: "note_prod99", text: "seed" } } }), action: { name: "note.open", page } },
  { ...recorded({ id: "u-2", session: "u", seq: 2, method: "POST", route: "/notes", path: "/notes", body: { text: "x" }, status: 201, json: { note: { id: "note_prodU2", text: "x" } } }), action: { name: "note.create", page } },
  recorded({ id: "u-3", session: "u", seq: 3, method: "UI", route: page, path: page, status: 0, json: null }),
  { ...recorded({ id: "u-4", session: "u", seq: 4, method: "GET", route: "/x/:slug", path: "/x/hello-world", status: 200, json: {} }), action: { name: "x.open", page: "/x/_" } },
];

/**
 * @param {string} [cwd] @param {import("../../shared/case.mjs").Case[]} [cases]
 * @param {{ browser?: string, browserUrl?: string }} [engine]
 */
async function replayUi(cwd = root, cases = session, signIn = adapter.signIn, engine = {}) {
  assert.ok(hasChrome, "the ui replay tests need Google Chrome installed (https://www.google.com/chrome/)");
  const [result] = await replaySessions({
    sessions: [{ session: "u", cases }], target: target.url, uiTarget: appUrl, adapter: { ...adapter, signIn }, modes: ["ui"], idPattern: DEFAULT_ID_PATTERN, cwd, ...engine,
  });
  return result.steps.map((step) => `${step.caseId} ${step.method} ${step.route} ${step.result}${step.reason ? `: ${step.reason}` : ""}${step.checked ? ` (${step.checked})` : ""}`);
}

test("a healthy page passes; a read action is clicked signed in, a write is only checked, a _ page is skipped", async () => {
  assert.deepEqual(await replayUi(), [
    "u-1 note.open /notes/note_prod99 passed",
    "u-2 note.create /notes/note_prod99 passed (presence)",
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
    "u-2 note.create /notes/note_prod99 passed (presence)",
  ]);
  mode = "500";
  assert.equal((await replayUi())[0], "u-1 note.open /notes/note_prod99 failed: 500 from GET /api/notes/note_seed01");
});

test("without playwright-core in the project, ui mode says what to install", async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "intersite-ui-")));
  await assert.rejects(replayUi(empty), { message: "ui mode needs playwright-core in the project: npm install --save-dev playwright-core" });
});

/** Fill in the new-note form and save it, then open the note it created. */
const writeSession = [
  { ...recorded({ id: "w-1", session: "w", seq: 1, method: "POST", route: "/notes", path: "/notes", body: { text: "from prod", color: "blue", pinned: true }, status: 201, json: { note: { id: "note_prodW1", text: "from prod" } } }), action: { name: "note.add", page: "/new" } },
  { ...recorded({ id: "w-2", session: "w", seq: 2, method: "GET", route: "/notes/:id", path: "/notes/note_prodW1", status: 200, json: { note: { id: "note_prodW1", text: "from prod" } } }), action: { name: "note.open", page: "/notes/note_prodW1" } },
];

test("a write action's form is filled from the recorded body and submitted; a later read opens the record it created", async () => {
  assert.deepEqual(await replayUi(root, writeSession), ["w-1 note.add /new passed", "w-2 note.open /notes/note_prodW1 passed"]);
  const posts = target.log.filter((entry) => entry.method === "POST");
  assert.deepEqual(posts.map((entry) => entry.body), [{ text: "from prod", color: "blue", pinned: true }]);
  assert.ok(target.log.some((entry) => entry.method === "GET" && entry.path === "/notes/note_000001"), "the Open button read the note the form created");
});

test("a form that sends the wrong payload shape fails with the status the server answered", async () => {
  mode = "wrong-shape";
  assert.equal((await replayUi(root, writeSession))[0], "w-1 note.add /new failed: status 400, recorded 201 for POST /notes");
});

test("a form whose submit handler sends nothing fails because the request never went out", async () => {
  mode = "sends-nothing";
  assert.equal((await replayUi(root, writeSession))[0], "w-1 note.add /new failed: no POST /notes request was sent");
});

test("a body key with no matching control falls back to checking the action is there", async () => {
  mode = "no-color";
  assert.equal((await replayUi(root, writeSession))[0], "w-1 note.add /new passed (presence)");
  assert.ok(target.log.every((entry) => entry.method !== "POST"), "nothing was submitted");
});

test("a write production answered with 400 passes when the replay is answered 400 too", async () => {
  mode = "wrong-shape";
  const rejected = { ...writeSession[0], response: { ...writeSession[0].response, status: 400, ids: {} } };
  assert.deepEqual(await replayUi(root, [rejected]), ["w-1 note.add /new passed"]);
});

test("an adapter that signs in with a cookie reaches the app and the API on page loads, clicks and submitted forms", async () => {
  mode = "cookie";
  const signIn = async () => ({ cookie: "session=abc" });
  assert.deepEqual(await replayUi(root, writeSession, signIn), ["w-1 note.add /new passed", "w-2 note.open /notes/note_prodW1 passed"]);
  assert.deepEqual(rejected, [], "every request carried the session cookie");
  assert.deepEqual(target.log.map((entry) => `${entry.method} ${entry.path} ${entry.headers["x-tenant"]}`), ["POST /notes a", "GET /notes/note_000001 a"]);
});

test("the sign-in cookie and headers reach the app and the API, never a third party the page loads from", async () => {
  mode = "cookie";
  const signIn = async () => ({ Cookie: "session=abc; theme=dark", "x-sign-in": "secret-header" });
  assert.deepEqual(await replayUi(root, writeSession, signIn), ["w-1 note.add /new passed", "w-2 note.open /notes/note_prodW1 passed"]);
  assert.deepEqual(rejected, [], "every request to the app carried the session cookie");
  assert.ok(appSignIn.length > 0 && appSignIn.every((value) => value === "secret-header"), "every request to the app carried the sign-in header");
  assert.ok(thirdSeen.length > 0, "the page loaded the third-party script");
  for (const headers of thirdSeen) {
    assert.equal(headers.cookie, undefined, "no cookie went to the third party");
    assert.equal(headers["x-sign-in"], undefined, "no sign-in header went to the third party");
  }
});

test("images, fonts and media are answered in the browser, never fetched; stylesheets still load", async () => {
  mode = "assets";
  assert.deepEqual(await replayUi(root, session.slice(0, 3)), [
    "u-1 note.open /notes/note_prod99 passed",
    "u-2 note.create /notes/note_prod99 passed (presence)",
    "u-3 UI /notes/note_prod99 passed",
  ]);
  assert.ok(appPaths.includes("/s.css"), "the stylesheet loaded, so visibility checks see the page's real layout");
  assert.deepEqual(appPaths.filter((path) => ["/i.png", "/f.woff2", "/v.mp4"].includes(path)), []);
});

const healthy = [
  "u-1 note.open /notes/note_prod99 passed",
  "u-2 note.create /notes/note_prod99 passed (presence)",
  "u-3 UI /notes/note_prod99 passed",
];

/**
 * Runs `fn` with PATH starting at a fresh folder holding `files` (name -> shell script), then restores PATH.
 * @param {Record<string, string>} files @param {(dir: string) => Promise<void>} fn
 */
async function withPath(files, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-path-")));
  for (const [name, script] of Object.entries(files)) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { await fn(dir); } finally { process.env.PATH = saved; }
}

test("replay.browser lightpanda with no lightpanda on PATH says how to install it", async () => {
  const saved = process.env.PATH;
  process.env.PATH = realpathSync(mkdtempSync(join(tmpdir(), "intersite-empty-")));
  try {
    await assert.rejects(replayUi(root, session.slice(0, 1), adapter.signIn, { browser: "lightpanda" }), {
      message: "replay.browser lightpanda needs the lightpanda binary on PATH; install it with curl -fsSL https://pkg.lightpanda.io/install.sh | bash"
        + " (it goes to ~/.local/bin), or set replay.browserUrl to a running one",
    });
  } finally { process.env.PATH = saved; }
});

test("replay.browser lightpanda starts lightpanda serve on a local port, connects over CDP, and stops it afterwards (a stand-in, not the real engine)", async () => {
  const fake = fileURLToPath(new URL("./fake-lightpanda.mjs", import.meta.url));
  await withPath({ lightpanda: `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n` }, async (dir) => {
    process.env.FAKE_LIGHTPANDA_LOG = join(dir, "args.log");
    process.env.FAKE_LIGHTPANDA_CHROME = chromePath;
    assert.deepEqual(await replayUi(root, session.slice(0, 3), adapter.signIn, { browser: "lightpanda" }), healthy);
    const args = readFileSync(join(dir, "args.log"), "utf8").trim();
    assert.match(args, /^serve --host 127\.0\.0\.1 --port \d+$/);
    const port = args.split(" ").at(-1);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`), "lightpanda was stopped when the run ended");
  });
});

test("replay.browserUrl connects to a browser that is already running and leaves it running", async () => {
  assert.ok(hasChrome, "this test needs Google Chrome installed");
  const chrome = spawn(chromePath, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${mkdtempSync(join(tmpdir(), "intersite-cdp-"))}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const closed = new Promise((done) => chrome.once("close", done));
  try {
    const url = await new Promise((done) => {
      let log = "";
      chrome.stderr.on("data", (chunk) => {
        log += chunk;
        const found = /DevTools listening on ws:\/\/([^/]+)\//.exec(log);
        if (found) done(`http://${found[1]}`);
      });
    });
    assert.deepEqual(await replayUi(root, session.slice(0, 3), adapter.signIn, { browserUrl: url }), healthy);
    assert.equal(chrome.exitCode, null, "the browser is still running");
  } finally {
    chrome.kill();
    await closed;
  }
});
