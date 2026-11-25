// @ts-check
// The `ui` replay mode (CONTRACT.md "Replay modes"): each session's named actions are played by intersite-core's
// browser engine (core/src/flow.rs), the one that plays flows, over the DevTools protocol with no automation library.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { ensureCore } from "../gates/core.mjs";
import { UI_METHOD } from "../shared/case.mjs";
import { prepare, resolveIds } from "./run.mjs";

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {import("./run.mjs").Step} Step */
/** @typedef {import("./run.mjs").Context} Context */

const READS = ["GET", "HEAD", UI_METHOD];
export const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * @typedef {object} EngineOptions
 * @property {string} uiTarget @property {string} target @property {boolean} headed
 * @property {string} browser "chrome" or "lightpanda" @property {string} browserUrl
 * @property {"recorded" | "none"} network @property {"fast" | "recorded"} timing
 * @property {number} concurrency  Jobs at once, each in its own browser context.
 */

/**
 * Starts intersite-core's browser engine and resolves once its browser is up; throws its one-line error (no Chrome,
 * no lightpanda, an unreachable replay.browserUrl) when it cannot start. `run` plays one job: a flow's steps, or a
 * `ui` session's actions. A job sent without `prepared` asks `onPrepare` for its reset, sign-in and IDs first.
 * @param {EngineOptions} options
 * @param {(index: number) => Promise<Record<string, unknown>>} [onPrepare]
 */
export async function startEngine(options, onPrepare) {
  const child = spawn(ensureCore(), ["flow"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {
    // The engine exited (its error is on stderr, reported below): a line it no longer needs has nowhere to go.
  });
  const exited = new Promise((done) => child.on("close", done));
  const failure = (/** @type {unknown} */ code) => new Error(stderr.trim().replace(/^intersite-core: /, "") || `intersite-core exited with ${code}`);
  const send = (/** @type {unknown} */ message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  /** @type {Map<number, { done: (steps: any[]) => void, fail: (error: Error) => void }>} */
  const waiting = new Map();
  /** @type {(ready: boolean) => void} */
  let started = () => undefined;
  const ready = new Promise((done) => { started = done; });
  (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (message.ready) started(true);
      else if (message.prepare !== undefined) {
        const index = message.prepare;
        // A job that cannot start (sign-in failed) is one failure, not the end of the run.
        (onPrepare ?? (async () => ({})))(index).then(
          (prepared) => send({ prepared: index, ...prepared }),
          (error) => send({ prepared: index, error: error instanceof Error ? error.message.split("\n")[0] : String(error) }),
        );
      } else {
        waiting.get(message.index)?.done(message.steps);
        waiting.delete(message.index);
      }
    }
  })();
  exited.then((code) => {
    started(false);
    for (const { fail } of waiting.values()) fail(failure(code));
    waiting.clear();
  });
  send({ options });
  if (!(await ready)) throw failure(await exited);
  let next = 0;
  return {
    /** @param {unknown} flow @param {Record<string, unknown>} [prepared] @returns {Promise<any[]>} */
    run(flow, prepared) {
      const index = next++;
      const result = new Promise((done, fail) => waiting.set(index, { done, fail }));
      send({ run: index, flow, ...(prepared && { prepared }) });
      return result;
    },
    async close() {
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw failure(code);
    },
  };
}

/**
 * One browser for the run, in the engine. Throws a one-line setup error when the browser is missing.
 * @param {{ uiTarget: string, target: string, headed: boolean, browser?: string, browserUrl?: string, concurrency: number }} options
 */
export async function openBrowser({ uiTarget, target, headed, browser = "chrome", browserUrl = "", concurrency }) {
  if (!uiTarget) throw new Error("ui mode needs replay.uiTarget in intersite.yml");
  const engine = await startEngine({ uiTarget, target, headed, browser, browserUrl, network: "none", timing: "fast", concurrency });
  return {
    close: engine.close,
    /**
     * Every distinct action of one session, in order. Returns the first skip reason, if any.
     * @param {Case[]} cases @param {Step[]} steps @param {Context} context
     */
    async replay(cases, steps, context) {
      const groups = [...actionGroups(cases).values()];
      const { actions, ...prepared } = await prepareSession(cases, groups, context);
      const results = await engine.run({ actions }, prepared);
      if (results[0]?.verb === "start") throw new Error(results[0].reason);
      /** @type {string | undefined} */
      let skipped;
      for (const { index, result, reason, checked } of results) {
        const { name, page, cases: group } = groups[index];
        steps.push({ mode: "ui", caseId: group[0].id, method: name, route: page, result, ...(reason && { reason }), ...(checked && { checked }) });
        if (result === "skipped") skipped ??= reason;
      }
      return skipped;
    },
  };
}

/**
 * A session's reset and sign-in, and its actions as the engine plays them: every ID their pages and write bodies name
 * that the session does not create is resolved here (one with no answer skips what needs it), and write bodies get
 * their dates shifted. IDs the session creates are swapped by the engine as their answers come in.
 * @param {Case[]} cases @param {{ name: string, page: string, cases: Case[] }[]} groups @param {Context} context
 */
async function prepareSession(cases, groups, context) {
  const { target, adapter, pattern } = context;
  await adapter.reset?.({ target });
  const kind = cases.find((item) => item.actor.kind !== "anonymous")?.actor.kind;
  const { cookies, headers } = splitCookie(kind ? await adapter.signIn(kind, { target, other: false }) : {});
  const writesOf = (/** @type {Case[]} */ group) => group.filter((item) => WRITES.includes(item.request.method));
  // Only an action's one write is submitted, so only its answer creates IDs.
  const created = groups.flatMap(({ cases: group }) => (writesOf(group).length === 1 ? Object.values(writesOf(group)[0].response.ids) : []));
  /** @type {Map<string, string>} recorded ID -> replayed ID; one the session creates stands for itself until learned */
  const ids = new Map(created.map((id) => [id, id]));
  /** @type {Record<string, string>} */
  const unresolved = {};
  const actions = [];
  for (const { name, page, cases: group } of groups) {
    for (const id of page.split("/").filter((segment) => pattern.test(segment) && !ids.has(segment) && !unresolved[segment])) {
      const reason = await resolveIds([id], ids, context);
      if (reason) unresolved[id] = reason;
    }
    const writes = writesOf(group);
    const reads = group.every((item) => READS.includes(item.request.method));
    actions.push({ name, page, reads, ...(writes.length === 1 && { write: await writeOf(writes[0], ids, context) }) });
  }
  const resolved = Object.fromEntries([...ids].filter(([recorded, replayed]) => recorded !== replayed));
  return { actions, cookies, headers, ids: resolved, unresolved };
}

/** @param {Case} write @param {Map<string, string>} ids @param {Context} context */
async function writeOf(write, ids, context) {
  const prepared = await prepare(write, ids, context);
  if (prepared.skip !== undefined) return { skip: prepared.skip };
  const { method, route } = write.request;
  return { expect: `${method} ${route} ${write.response.status}`, body: prepared.request.body ?? null, ids: write.response.ids };
}

/**
 * The session's UI cases grouped by action name and page, in first-seen order.
 * @param {Case[]} cases
 */
function actionGroups(cases) {
  /** @type {Map<string, { name: string, page: string, cases: Case[] }>} */
  const actions = new Map();
  for (const item of cases) {
    // A recorded step (track's `steps: true`) is what flows are made of; this mode checks named actions.
    if ((!item.action && item.request.method !== UI_METHOD) || (item.request.method === UI_METHOD && item.step)) continue;
    const name = item.action?.name ?? UI_METHOD;
    const path = item.action?.page ?? item.request.path;
    const key = `${name} ${path}`;
    if (!actions.has(key)) actions.set(key, { name, page: path, cases: [] });
    actions.get(key)?.cases.push(item);
  }
  return actions;
}

/**
 * The adapter's sign-in headers, with a `cookie` header taken out as browser cookies.
 * @param {Record<string, string>} signIn
 * @returns {{ cookies: { name: string, value: string }[], headers: Record<string, string> }}
 */
export function splitCookie(signIn) {
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
