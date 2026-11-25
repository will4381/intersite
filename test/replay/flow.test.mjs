// @ts-check
// Flows end to end: a user clicks through a tiny ads app in Chrome with the tracker's steps on, capture records the
// session, toFlow turns it into a flow, and runFlows plays it back against the app. Needs the installed Google Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { createCapture } from "../../capture/index.mjs";
import { flowProblem, runFlows, toFlow } from "../../replay/flow.mjs";
import { reduceLabel, stepProblem } from "../../shared/case.mjs";
import { DEFAULT_ID_PATTERN } from "../../shared/shape.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** How the app misbehaves: "healthy", "500" (saving an ad fails), "renamed" (the ads list lost its name). */
let mode = "healthy";
/** @type {{ id: string, headline: string, budget: number }[]} */
let ads = [];
/** @type {any[]} cases capture sent to the collector */
let recorded = [];
let app = "";
/** @type {import("node:http").Server} */
let server;

const capture = createCapture({
  project: "ads", url: "http://collector.test", token: "t", release: "r1", sample: 1,
  fetcher: { fetch: async (_url, init) => (recorded.push(...JSON.parse(String(init?.body)).cases), new Response("{}")) },
});

/** @param {string} body */
const page = (body) => `<!doctype html><link rel="icon" href="data:,"><title>ads</title>
<nav data-intersite="nav"><a href="/ads">Paid ads</a></nav><main>${body}</main>
<script type="module">
import { createTracker } from "/track/index.mjs";
const tracker = createTracker({ steps: true, onUi: (event) => navigator.sendBeacon("/ui", JSON.stringify(event)) });
const form = document.querySelector("form");
if (form) form.onsubmit = async (event) => {
  event.preventDefault();
  const body = { headline: form.elements.headline.value, budget: Number(form.elements.budget.value) };
  const response = await tracker.fetch("/api/ads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.ok) location.href = "/ads/" + (await response.json()).ad.id;
};
document.title = "ready";
</script>`;

/** @param {import("node:http").IncomingMessage} req */
async function text(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const html = (/** @type {string} */ body) => res.writeHead(200, { "content-type": "text/html" }).end(page(body));
    if (path.startsWith("/track/") || path.startsWith("/shared/")) return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(`${root}${path}`));
    if (path === "/ui") {
      await capture.recordUi(JSON.parse(await text(req)));
      return res.writeHead(204).end();
    }
    if (path === "/__reset") {
      ads = [];
      return res.writeHead(204).end();
    }
    if (path === "/api/ads" && req.method === "POST") {
      const body = await text(req);
      const ad = { id: `ad_${String(ads.length + 1).padStart(6, "0")}`, ...JSON.parse(body) };
      const status = mode === "500" ? 500 : 201;
      if (status === 201) ads.push(ad);
      const answer = status === 201 ? { ad } : { error: "broken" };
      await capture.record({ request: { method: "POST", url: path, headers: /** @type {any} */ (req.headers), body }, response: { status, body: answer }, route: "/api/ads" });
      return res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    }
    if (path === "/ads") {
      const list = mode === "renamed" ? "ads.items" : "ads.list";
      return html(`<ul data-intersite="${list}">${ads.map((ad) => `<li><a href="/ads/${ad.id}">${ad.headline}</a></li>`).join("")}</ul><a href="/ads/new" data-intersite="ad.new">New ad</a>`);
    }
    if (path === "/ads/new") return html('<form data-intersite="ad.form"><input name="headline"><select name="budget"><option>10</option><option>50</option></select><button>Save</button></form>');
    const ad = ads.find((item) => path === `/ads/${item.id}`);
    return ad ? html(`<h1>${ad.headline}</h1>`) : html("<h1>Home</h1>");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  app = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
});

after(() => new Promise((done) => server.close(done)));

beforeEach(() => {
  mode = "healthy";
  ads = [];
});

const adapter = {
  signIn: async () => ({}),
  /** @param {{ target: string }} options */
  reset: async ({ target }) => void (await fetch(`${target}/__reset`, { method: "POST" })),
};
/** @param {import("../../replay/flow.mjs").Flow} flow @param {Partial<import("../../replay/flow.mjs").RunOptions>} [extra] */
const play = async (flow, extra = {}) => (await runFlows([{ file: "ads.json", flow }], {
  uiTarget: app, target: app, adapter, pattern: new RegExp(DEFAULT_ID_PATTERN), headed: false,
  network: "none", timing: "fast", concurrency: 1, ...extra,
}))[0].steps;

/** Clicks through the app as a user would, and returns the recorded session's cases. */
async function recordSession() {
  recorded = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const user = await browser.newPage();
    const ready = () => user.waitForFunction(() => document.title === "ready");
    await user.goto(`${app}/`);
    await ready();
    await user.click("text=Paid ads");
    await ready();
    await user.click("text=New ad");
    await ready();
    await user.reload();
    await ready();
    await user.fill("[name=headline]", "Spring sale");
    await user.selectOption("[name=budget]", "50");
    await user.click("text=Save");
    await user.waitForURL(/\/ads\/ad_/);
    await ready();
    await user.click("text=Paid ads");
    await ready();
    await user.click("[data-intersite='ads.list'] li a >> nth=0");
    await user.waitForURL(/\/ads\/ad_/);
    await ready();
  } finally {
    await browser.close();
  }
  // Beacons arrive on their own time: wait until the last page's load step is in.
  for (let tries = 0; tries < 50 && recorded.filter((item) => item.step?.kind === "nav").length < 8; tries++) await new Promise((done) => setTimeout(done, 100));
  return recorded;
}

test("a session the tracker recorded becomes a flow that replays, and fails when the app breaks", async () => {
  const cases = await recordSession();
  for (const item of cases) assert.equal(new Set(cases.map((c) => c.session)).size, 1, `one session, got ${item.session}`);
  const flow = toFlow(cases);
  assert.equal(flowProblem(flow), undefined);
  const write = flow.steps.find((step) => step.expect);
  assert.deepEqual(flow.steps.map((step) => Object.keys(step).filter((key) => key !== "at")), [
    ["open"], ["click"], ["open"], ["click"], ["open"], ["reload"], ["fill"], ["click", "expect", "ids"], ["open"], ["click"], ["open"], ["click"], ["open"],
  ]);
  assert.deepEqual(flow.steps[1].click, { in: "nav", role: "link", label: "Paid ads" });
  assert.equal(flow.steps[3].click, "ad.new");
  assert.deepEqual(Object.keys(flow.steps[6].fill ?? {}).sort(), ["budget", "headline"], "a field records when it loses focus, so the order is the browser's");
  assert.equal(flow.steps[6].fill?.budget, 50);
  assert.notEqual(flow.steps[6].fill?.headline, "Spring sale", "typed text is stored scrubbed");
  assert.deepEqual(write, { click: { in: "ad.form", role: "button", label: "Save" }, at: write?.at, expect: "POST /api/ads 201", ids: { "/ad/id": "ad_000001" } });
  assert.deepEqual(flow.steps[11].click, { in: "ads.list", nth: 0, role: "link" }, "a list item's text is data, so it is found by position");
  assert.ok(flow.env && typeof flow.env.viewport?.[0] === "number", "the first load carries the device");

  const passed = await play(flow);
  assert.deepEqual(passed.map((step) => step.result), flow.steps.map(() => "passed"), JSON.stringify(passed));

  mode = "500";
  const failed = await play(flow);
  assert.equal(failed.at(-1)?.result, "failed");
  assert.equal(failed.at(-1)?.index, 7);
  assert.match(String(failed.at(-1)?.reason), /500/);

  mode = "renamed";
  const renamed = await play(flow);
  assert.equal(renamed.at(-1)?.index, 11);
  assert.match(String(renamed.at(-1)?.reason), /not found on \/ads/);
});

test("a hand-written flow checks text, and the recorded connection slows it down", async () => {
  /** @type {import("../../replay/flow.mjs").Flow} */
  const flow = {
    env: { rtt: 600, viewport: [390, 844], mobile: true },
    steps: [{ open: "/ads/new" }, { fill: { headline: "Fresh", budget: 10 } }, { click: { in: "ad.form", role: "button", label: "Save" }, expect: "POST /api/ads 201" }, { see: "Fresh" }],
  };
  assert.equal(flowProblem(flow), undefined);
  let start = Date.now();
  const quick = await play(flow);
  const quickMs = Date.now() - start;
  assert.deepEqual(quick.map((step) => step.result), ["passed", "passed", "passed", "passed"], JSON.stringify(quick));
  start = Date.now();
  const slow = await play(flow, { network: "recorded" });
  assert.deepEqual(slow.map((step) => step.result), ["passed", "passed", "passed", "passed"], JSON.stringify(slow));
  assert.ok(Date.now() - start > quickMs + 1500, `600 ms round trips should cost well over a second more (${Date.now() - start} ms vs ${quickMs} ms)`);

  const missing = await play({ steps: [{ open: "/" }, { see: "Nowhere" }] });
  assert.match(String(missing.at(-1)?.reason), /"Nowhere" is not on \//);
});

test("intersite flow plays the project's flows and names a malformed one", async () => {
  // Inside the repository, so the project resolves playwright-core as a real one would from its own node_modules.
  mkdirSync(`${root}.intersite`, { recursive: true });
  const project = mkdtempSync(`${root}.intersite/flow-cli-`);
  try {
    writeFileSync(`${project}/intersite.yml`, `project: ads\nreplay:\n  target: ${app}\n  uiTarget: ${app}\n  adapter: .intersite/adapter.mjs\n`);
    mkdirSync(`${project}/.intersite/flows`, { recursive: true });
    writeFileSync(`${project}/.intersite/adapter.mjs`, "export async function signIn() { return {}; }\n");
    writeFileSync(`${project}/.intersite/flows/home.json`, JSON.stringify({ steps: [{ open: "/" }, { click: { in: "nav", role: "link", label: "Paid ads" } }, { see: "New ad" }] }));
    // Not spawnSync: the app the flow drives is served by this process, which must keep answering.
    const cli = (/** @type {string[]} */ ...args) => new Promise((done) => {
      const child = spawn(process.execPath, [`${root}bin/intersite.mjs`, "flow", ...args], { cwd: project, env: { ...process.env, INTERSITE_OFFLINE: "1" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
    /** @type {any} */
    const passed = await cli();
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout.trim(), "ok flow: 1 of 1 flows passed");

    writeFileSync(`${project}/.intersite/flows/bad.json`, JSON.stringify({ steps: [{ open: "/", see: "x" }] }));
    /** @type {any} */
    const bad = await cli();
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /^intersite flow: \.intersite\/flows\/bad\.json: step 1: needs exactly one of open, reload, click, fill, see/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("flowProblem names the step that is wrong", () => {
  assert.match(String(flowProblem({ steps: [] })), /non-empty/);
  assert.match(String(flowProblem({ steps: [{ open: "/" }, { click: "ad.save", fill: {} }] })), /^step 2: needs exactly one of/);
  assert.match(String(flowProblem({ steps: [{ click: { nth: 0 } }] })), /^step 1: click needs in/);
  assert.match(String(flowProblem({ steps: [{ click: "ad.save", expect: "POST /ads" }] })), /expect must read/);
  assert.match(String(flowProblem({ env: { rtt: 7 }, steps: [{ open: "/" }] })), /env.rtt must be one of/);
  assert.match(String(flowProblem({ steps: [{ see: "x", at: 5 }] })), /at does not go on a see step/);
});

test("steps keep no typed text or names, and refuse fields they do not have", () => {
  assert.equal(reduceLabel("Message Alice Smith"), "Message _ _");
  assert.equal(reduceLabel("Save changes"), "Save changes");
  assert.equal(reduceLabel("alice@example.com 42"), undefined);
  assert.equal(stepProblem({ n: 3, kind: "fill", field: "email" }, true), undefined);
  assert.match(String(stepProblem({ n: 3, kind: "fill", field: "email", value: "a@b.c" }, true)), /step.value does not belong/);
  assert.match(String(stepProblem({ n: 3, kind: "click", label: "Alice Smith" }, true)), /needs a name or a role|reduced/);
  assert.match(String(stepProblem({ n: 3, kind: "nav" }, false)), /holds n only/);
});
