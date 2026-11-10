// @ts-check
// The `ui` replay mode (CONTRACT.md "Replay modes"): drives the installed Chrome through the project's playwright-core.
// Loaded only when that mode is asked for, so the other modes never need a browser.
import { createRequire } from "node:module";
import { join } from "node:path";

import { UI_METHOD } from "../shared/case.mjs";

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {import("./run.mjs").Step} Step */
/** @typedef {import("./run.mjs").Context} Context */

/** Longest wait for a page to go quiet, how long "quiet" is, and how long an element may take to appear. */
const SETTLE_CAP = 3000;
const QUIET = 300;
const FIND_CAP = 1000;
const READS = ["GET", "HEAD", UI_METHOD];

/** @param {unknown} error */
const firstLine = (error) => String(error instanceof Error ? error.message : error).split("\n")[0];

/**
 * One browser for the run. Throws a one-line setup error when playwright-core or Chrome is missing.
 * @param {{ uiTarget: string, headed: boolean, cwd: string }} options
 */
export async function openBrowser({ uiTarget, headed, cwd }) {
  if (!uiTarget) throw new Error("ui mode needs replay.uiTarget in intersite.yml");
  /** @type {typeof import("playwright-core").chromium} */
  let chromium;
  try {
    ({ chromium } = createRequire(join(cwd, "package.json"))("playwright-core"));
  } catch {
    throw new Error("ui mode needs playwright-core in the project: npm install --save-dev playwright-core");
  }
  /** @type {import("playwright-core").Browser} */
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: !headed });
  } catch (error) {
    throw new Error(`ui mode could not start Google Chrome; install it from https://www.google.com/chrome/ (${firstLine(error)})`);
  }
  const base = uiTarget.replace(/\/$/, "");

  return {
    close: () => browser.close(),
    /**
     * Every distinct action of one session, in order. Returns the first skip reason, if any.
     * @param {Case[]} cases @param {Step[]} steps @param {Context} context
     */
    async replay(cases, steps, { target, adapter, pattern }) {
      await adapter.reset?.({ target });
      const kind = cases.find((item) => item.actor.kind !== "anonymous")?.actor.kind;
      const context = await browser.newContext({ extraHTTPHeaders: kind ? await adapter.signIn(kind, { target, other: false }) : {} });
      /** @type {string | undefined} */
      let skipped;
      try {
        const page = await context.newPage();
        const origins = new Set([new URL(base).origin, new URL(target).origin]);
        /** @type {{ error: string[], server: string[], console: string[] }} */
        const problems = { error: [], server: [], console: [] };
        let inflight = 0;
        let lastActivity = Date.now();
        page.on("pageerror", (error) => problems.error.push(`page error: ${firstLine(error)}`));
        page.on("console", (message) => { if (message.type() === "error") problems.console.push(`console error: ${message.text()}`); });
        page.on("request", () => { inflight++; lastActivity = Date.now(); });
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

        for (const { name, page: path, cases: group } of actions.values()) {
          /** @param {Step["result"]} result @param {string} [reason] */
          const record = (result, reason) => steps.push({ mode: "ui", caseId: group[0].id, method: name, route: path, result, ...(reason && { reason }) });
          const url = await remap(path, pattern, (id) => adapter.resolveId?.(id, { target }));
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
            } else if (!(await element.isVisible()) || !(await element.isEnabled())) {
              record("failed", `action ${name} on ${path} is hidden or disabled`);
            } else {
              record("passed");
            }
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
 * The page path with recorded IDs swapped for ones from `resolve`. A `_` segment (capture reduced it) cannot be
 * rebuilt, so the action is skipped.
 * @param {string} page @param {RegExp} pattern @param {(id: string) => Promise<string | undefined> | undefined} resolve
 * @returns {Promise<{ path: string, skip?: undefined } | { skip: string }>}
 */
async function remap(page, pattern, resolve) {
  const segments = [];
  for (const segment of page.split("/")) {
    if (segment === "_") return { skip: `page ${page} has a segment capture reduced to _, which cannot be resolved` };
    if (!pattern.test(segment)) { segments.push(segment); continue; }
    const resolved = await resolve(segment);
    if (resolved === undefined) return { skip: `resolveId gave nothing for ${segment}` };
    segments.push(resolved);
  }
  return { path: segments.join("/") };
}
