// @ts-check
// The `ui` replay mode (CONTRACT.md "Replay modes"): drives Chrome (or Lightpanda) through the project's playwright-core.
// Loaded only when that mode is asked for, so the other modes never need a browser.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";

import { UI_METHOD } from "../shared/case.mjs";
import { learnIds, prepare, resolveIds } from "./run.mjs";

/** Closing a browser whose connection already dropped has nothing left to do. */
const alreadyClosed = () => undefined;

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {import("./run.mjs").Step} Step */
/** @typedef {import("./run.mjs").Context} Context */

/** Longest wait for a page to go quiet, how long "quiet" is, and how long an element may take to appear. */
const SETTLE_CAP = 3000;
const QUIET = 300;
const FIND_CAP = 1000;
const READS = ["GET", "HEAD", UI_METHOD];
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];
const LIGHTPANDA_MISSING = "replay.browser lightpanda needs the lightpanda binary on PATH; install it with "
  + "curl -fsSL https://pkg.lightpanda.io/install.sh | bash (it goes to ~/.local/bin), or set replay.browserUrl to a running one";
/** A 1x1 transparent GIF stands in for every image, so an image-only link or button keeps a box to click. */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** @param {unknown} error */
const firstLine = (error) => String(error instanceof Error ? error.message : error).split("\n")[0];

/**
 * One browser for the run. Throws a one-line setup error when playwright-core or the browser is missing.
 * @param {{ uiTarget: string, headed: boolean, cwd: string, browser?: string, browserUrl?: string }} options
 */
export async function openBrowser({ uiTarget, headed, cwd, browser: engine = "chrome", browserUrl = "" }) {
  if (!uiTarget) throw new Error("ui mode needs replay.uiTarget in intersite.yml");
  if (engine !== "chrome" && engine !== "lightpanda") throw new Error(`replay.browser must be chrome or lightpanda, got ${engine}`);
  /** @type {typeof import("playwright-core").chromium} */
  let chromium;
  try {
    ({ chromium } = createRequire(join(cwd, "package.json"))("playwright-core"));
  } catch {
    throw new Error("ui mode needs playwright-core in the project: npm install --save-dev playwright-core");
  }
  const { browser, stop } = browserUrl ? await connect(chromium, browserUrl)
    : engine === "lightpanda" ? await startLightpanda(chromium) : await launchChrome(chromium, headed);
  const base = uiTarget.replace(/\/$/, "");

  return {
    close: stop,
    /**
     * Every distinct action of one session, in order. Returns the first skip reason, if any.
     * @param {Case[]} cases @param {Step[]} steps @param {Context} replayContext
     */
    async replay(cases, steps, replayContext) {
      const { target, adapter } = replayContext;
      await adapter.reset?.({ target });
      /** @type {Map<string, string>} recorded ID -> replayed ID */
      const ids = new Map();
      const kind = cases.find((item) => item.actor.kind !== "anonymous")?.actor.kind;
      const origins = new Set([new URL(base).origin, new URL(target).origin]);
      const { cookies, headers: signInHeaders } = splitCookie(kind ? await adapter.signIn(kind, { target, other: false }) : {});
      const context = await browser.newContext();
      // ponytail: cookies are scoped by host, not port, so another server on the app's or the API's host also gets them.
      await context.addCookies(cookies.flatMap((cookie) => [...origins].map((url) => ({ ...cookie, url }))));
      /** @type {string | undefined} */
      let skipped;
      try {
        const page = await context.newPage();
        const watch = await watchPage(page, origins, signInHeaders);
        const { problems, settle, problem } = watch;
        const actions = actionGroups(cases);

        for (const { name, page: path, cases: group } of actions.values()) {
          /** @param {Step["result"]} result @param {string} [reason] @param {Partial<Step>} [extra] */
          const record = (result, reason, extra) => steps.push({ mode: "ui", caseId: group[0].id, method: name, route: path, result, ...(reason && { reason }), ...extra });
          const url = await remap(path, ids, replayContext);
          if (url.skip) {
            record("skipped", url.skip);
            skipped ??= url.skip;
            continue;
          }
          problems.error.length = problems.server.length = problems.console.length = 0;
          try {
            await page.goto(base + url.path, { waitUntil: "load", timeout: 10_000 });
            await settle();
            if (problem()) { record("failed", problem()); continue; }
            if (name === UI_METHOD) { record("passed"); continue; }
            const element = page.locator(`[data-intersite="${name}"]`).first();
            if (!(await element.waitFor({ state: "attached", timeout: FIND_CAP }).then(() => true, () => false))) {
              record("failed", `action ${name} not found on ${path}`);
              continue;
            }
            if (group.every((item) => READS.includes(item.request.method))) {
              await element.click({ timeout: 2000 });
              await settle();
              record(problem() ? "failed" : "passed", problem());
              continue;
            }
            if (!(await element.isVisible()) || !(await element.isEnabled())) {
              record("failed", `action ${name} on ${path} is hidden or disabled`);
              continue;
            }
            const writes = group.filter((item) => WRITES.includes(item.request.method));
            const prepared = writes.length === 1 ? await prepare(writes[0], ids, replayContext) : undefined;
            if (prepared?.skip !== undefined) {
              record("skipped", prepared.skip);
              skipped ??= prepared.skip;
              continue;
            }
            const fills = prepared && (await fillsFor(element, prepared.request.body));
            if (!fills) { record("passed", undefined, { checked: "presence" }); continue; }

            const reason = await submitWrite(watch, fills, writes[0], ids);
            record(reason ? "failed" : "passed", reason);
          } catch (error) {
            record("failed", firstLine(error));
          }
        }
      } finally {
        await context.close();
      }
      return skipped;
    },
  };
}

/**
 * Chrome Headless Shell when Playwright has it installed (`npx playwright install chromium-headless-shell`), else the
 * installed Google Chrome. Headed runs always use Chrome: the shell has no window.
 * @param {typeof import("playwright-core").chromium} chromium @param {boolean} headed
 */
async function launchChrome(chromium, headed) {
  // No extra switches: Playwright already turns off background networking, updates, sync and throttling, and
  // --disable-gpu measured no better.
  // The headless shell is optional: when Playwright has not installed it, the installed Chrome below is used.
  const noShell = () => undefined;
  const shell = headed ? undefined : await chromium.launch({ channel: "chromium-headless-shell" }).catch(noShell);
  try {
    const browser = shell ?? (await chromium.launch({ channel: "chrome", headless: !headed }));
    return { browser, stop: () => browser.close() };
  } catch (error) {
    throw new Error(`ui mode could not start Google Chrome; install it from https://www.google.com/chrome/ (${firstLine(error)})`);
  }
}

/**
 * A browser already running with the Chrome DevTools Protocol at `url` (replay.browserUrl). Closing only disconnects.
 * @param {typeof import("playwright-core").chromium} chromium @param {string} url
 */
async function connect(chromium, url) {
  try {
    const browser = await chromium.connectOverCDP(url, { timeout: 10_000 });
    return { browser, stop: () => browser.close() };
  } catch (error) {
    throw new Error(`ui mode could not connect to replay.browserUrl ${url} (${firstLine(error)})`);
  }
}

/**
 * Starts `lightpanda serve` from PATH on a free local port, connects to it, and stops it on close.
 * @param {typeof import("playwright-core").chromium} chromium
 */
async function startLightpanda(chromium) {
  const port = await freePort();
  const child = spawn("lightpanda", ["serve", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { LIGHTPANDA_DISABLE_TELEMETRY: "true", ...process.env },
  });
  const exited = new Promise((done) => { child.once("close", done); child.once("error", done); });
  /** @type {string | undefined} why the process is gone, once it is */
  let gone;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => {
    gone = /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" ? LIGHTPANDA_MISSING : `ui mode could not start lightpanda (${firstLine(error)})`;
  });
  child.once("exit", (code) => { gone ??= `lightpanda exited with code ${code} before it accepted a connection (${firstLine(stderr.trim())})`; });
  const stop = async () => { child.kill(); await exited; };
  // ponytail: polls the port until it answers; read lightpanda's "listening" log line instead if its format is ever documented.
  for (const end = Date.now() + 10_000; ;) {
    try {
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}`, { timeout: 2000 });
      return { browser, stop: async () => { await browser.close().catch(alreadyClosed); await stop(); } };
    } catch (error) {
      if (gone || Date.now() > end) {
        await stop();
        throw new Error(gone ?? `ui mode could not connect to lightpanda on port ${port} (${firstLine(error)})`);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}

/** A local TCP port that was free a moment ago. */
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  await new Promise((done) => server.close(done));
  return port;
}

/**
 * Routes the page's requests to the app and the API with the sign-in headers, and watches its problems and traffic.
 * @param {import("playwright-core").Page} page @param {Set<string>} origins @param {Record<string, string>} signInHeaders
 */
async function watchPage(page, origins, signInHeaders) {
  /** @type {{ error: string[], server: string[], console: string[] }} */
  const problems = { error: [], server: [], console: [] };
  /** @type {import("playwright-core").Request[]} requests to the app or the API since the action began */
  const sent = [];
  /** @type {Map<import("playwright-core").Request, Promise<string>>} write answers, kept as they pass: a page that navigates afterwards takes the body with it */
  const bodies = new Map();
  // The sign-in headers go to the app and the API only, never to a third party the page loads from.
  await page.route((url) => origins.has(url.origin), async (route) => {
    const headers = { ...(await route.request().allHeaders()), ...signInHeaders };
    if (!WRITES.includes(route.request().method())) return route.continue({ headers });
    const answer = await route.fetch({ headers });
    bodies.set(route.request(), answer.text());
    return route.fulfill({ response: answer });
  });
  // Registered last, so it runs first: images, fonts and media cost decode time and memory and no check reads them.
  await page.route(() => true, (route) => {
    const type = route.request().resourceType();
    if (type === "image") return route.fulfill({ contentType: "image/gif", body: PIXEL });
    // An empty answer, not an abort: Chrome logs an aborted request as a console error, which would fail the step.
    if (type === "font" || type === "media") return route.fulfill({ body: "" });
    return route.fallback();
  });
  let inflight = 0;
  let lastActivity = Date.now();
  page.on("pageerror", (error) => problems.error.push(`page error: ${firstLine(error)}`));
  page.on("console", (message) => { if (message.type() === "error") problems.console.push(`console error: ${message.text()}`); });
  page.on("request", (request) => {
    inflight++;
    lastActivity = Date.now();
    if (origins.has(new URL(request.url()).origin)) sent.push(request);
  });
  const finished = () => { inflight--; lastActivity = Date.now(); };
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 500 && origins.has(url.origin)) problems.server.push(`${response.status()} from ${response.request().method()} ${url.pathname}`);
  });
  const settle = async () => {
    const end = Date.now() + SETTLE_CAP;
    while (Date.now() < end && (inflight > 0 || Date.now() - lastActivity < QUIET)) await new Promise((done) => setTimeout(done, 50));
  };
  const problem = () => [...problems.error, ...problems.server, ...problems.console][0];
  return { problems, sent, bodies, settle, problem };
}

/**
 * The session's UI cases grouped by action name and page, in first-seen order.
 * @param {Case[]} cases
 */
function actionGroups(cases) {
  /** @type {Map<string, { name: string, page: string, cases: Case[] }>} */
  const actions = new Map();
  for (const item of cases) {
    if (!item.action && item.request.method !== UI_METHOD) continue;
    const name = item.action?.name ?? UI_METHOD;
    const path = item.action?.page ?? item.request.path;
    const key = `${name} ${path}`;
    if (!actions.has(key)) actions.set(key, { name, page: path, cases: [] });
    actions.get(key)?.cases.push(item);
  }
  return actions;
}

/**
 * Fills and submits the form, then checks the recorded write was sent and answered as recorded; returns the failure reason, if any.
 * @param {Awaited<ReturnType<typeof watchPage>>} watch
 * @param {{ steps: (() => Promise<unknown>)[], submit: () => Promise<unknown> }} fills
 * @param {Case} write @param {Map<string, string>} ids
 */
async function submitWrite(watch, fills, write, ids) {
  const { problems, sent, bodies, settle, problem } = watch;
  sent.length = 0;
  bodies.clear();
  for (const fill of fills.steps) await fill();
  await fills.submit();
  await settle();
  const route = routePattern(write.request.route);
  const request = sent.find((item) => item.method() === write.request.method && route.test(new URL(item.url()).pathname));
  const response = await request?.response();
  const wanted = `${write.request.method} ${write.request.route}`;
  if (!request) return `no ${wanted} request was sent`;
  if (!response) return `${wanted} got no answer`;
  // A recorded server error is the bug, not the answer to keep (as in the baseline mode): any answer below 500 passes.
  const fixed = write.response.status >= 500 && response.status() < 500;
  if (response.status() !== write.response.status && !fixed) return `status ${response.status()}, recorded ${write.response.status} for ${wanted}`;
  // Chrome logs every 4xx/5xx answer as a console error; the recorded status was expected, so its log is too.
  const expected = `console error: Failed to load resource: the server responded with a status of ${response.status()} `;
  problems.console = problems.console.filter((message) => !message.startsWith(expected));
  if (problem()) return problem();
  let json;
  try { json = JSON.parse((await bodies.get(request)) ?? ""); } catch { json = undefined; } // not JSON: it created no IDs to map
  learnIds(write, json, ids);
  return undefined;
}

/**
 * The adapter's sign-in headers, with a `cookie` header taken out as browser cookies.
 * @param {Record<string, string>} signIn
 * @returns {{ cookies: { name: string, value: string }[], headers: Record<string, string> }}
 */
function splitCookie(signIn) {
  /** @type {Record<string, string>} */
  const headers = {};
  const cookies = [];
  for (const [name, value] of Object.entries(signIn)) {
    if (name.toLowerCase() !== "cookie") { headers[name.toLowerCase()] = String(value); continue; }
    for (const pair of String(value).split(";")) {
      const at = pair.indexOf("=");
      if (at > 0) cookies.push({ name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() });
    }
  }
  return { cookies, headers };
}

/**
 * The page path with recorded IDs swapped for replayed ones (created earlier in the session, or from `resolveId`).
 * A `_` segment (capture reduced it) cannot be rebuilt, so the action is skipped.
 * @param {string} page @param {Map<string, string>} ids @param {Context} context
 * @returns {Promise<{ path: string, skip?: undefined } | { skip: string }>}
 */
async function remap(page, ids, context) {
  const segments = page.split("/");
  if (segments.includes("_")) return { skip: `page ${page} has a segment capture reduced to _, which cannot be resolved` };
  const skip = await resolveIds(segments.filter((segment) => context.pattern.test(segment)), ids, context);
  return skip ? { skip } : { path: segments.map((segment) => ids.get(segment) ?? segment).join("/") };
}

/**
 * How to fill the action's form from a recorded JSON body and submit it, or undefined when the body is not a JSON
 * object (or empty) or a top-level key names no control in the form. The form is the element itself, or its closest
 * `<form>` ancestor; nested objects and arrays are left as the page has them.
 * @param {import("playwright-core").Locator} element @param {unknown} body
 * @returns {Promise<{ steps: (() => Promise<unknown>)[], submit: () => Promise<unknown> } | undefined>}
 */
async function fillsFor(element, body) {
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) return undefined;
  const form = element.locator("xpath=ancestor-or-self::form[1]");
  const hasForm = (await form.count()) > 0;
  const steps = [];
  for (const [key, value] of Object.entries(body ?? {})) {
    const named = JSON.stringify(key);
    const control = form.locator(`[name=${named}], [id=${named}]`).first();
    if (!hasForm || !(await control.count())) return undefined;
    if (value !== null && typeof value === "object") continue;
    const kind = await control.evaluate((el) => (el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase()));
    const text = String(value ?? "");
    if (kind === "radio") {
      const option = typeof value === "boolean" ? control : form.locator(`input[type=radio][name=${named}][value=${JSON.stringify(text)}]`).first();
      if (!(await option.count())) return undefined;
      if (value !== false) steps.push(() => option.check());
    } else if (kind === "checkbox") {
      const on = typeof value === "boolean" ? value : text === (await control.inputValue());
      steps.push(() => control.setChecked(on));
    } else if (kind === "select") {
      steps.push(() => control.selectOption(text));
    } else if (kind === "hidden") {
      steps.push(() => control.evaluate((el, v) => { /** @type {HTMLInputElement} */ (el).value = v; }, text));
    } else {
      steps.push(() => control.fill(text));
    }
  }
  const isSubmit = await element.evaluate((el) => el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && ["submit", "image"].includes(el.type)));
  const control = form.locator("button:not([type]), button[type=submit], input[type=submit], input[type=image]").first();
  const submit = async () => {
    if (isSubmit || !hasForm) return element.click({ timeout: 2000 });
    if (await control.count()) return control.click({ timeout: 2000 });
    return form.evaluate((el) => /** @type {HTMLFormElement} */ (el).requestSubmit());
  };
  return { steps, submit };
}

/**
 * Matches a request path against a recorded route template: `:name` stands for one segment, and the path may carry a
 * prefix (the web app's `/api` in front of the server's routes).
 * @param {string} route
 */
function routePattern(route) {
  // ponytail: knows only `:name` parameters; add `{name}`, `[name]` and `*` if a project's capture records those.
  const body = route.split("/").map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^(?:/.*)?${body}$`);
}
