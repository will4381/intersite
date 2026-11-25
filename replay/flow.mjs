// @ts-check
// Flows (CONTRACT.md "Flows"): a recorded session's steps as a JSON test, checked here and played by intersite-core.
import { ACTION_NAME, UI_METHOD, envProblem } from "../shared/case.mjs";
import { resolveIds } from "./run.mjs";
import { WRITES, splitCookie, startEngine } from "./ui.mjs";

/** @typedef {import("../shared/case.mjs").Case} Case */
/** @typedef {import("../shared/case.mjs").Env} Env */
/** @typedef {{ in?: string, nth?: number, role?: string, label?: string }} Target  `in` is a `data-intersite` name. */
/**
 * One step: exactly one verb (`open`, `reload`, `click`, `fill`, `see`), plus `at` (ms after the page loaded, for
 * `--timing recorded`) and, on a click, `expect` ("POST /api/ads 201") and `ids` (pointer -> recorded ID it created).
 * @typedef {{ open?: string, reload?: true, click?: string | Target, fill?: Record<string, unknown>, see?: string,
 *   at?: number, expect?: string, ids?: Record<string, string> }} FlowStep
 */
/** @typedef {{ as?: string, env?: Env, steps: FlowStep[] }} Flow */
/** @typedef {{ index: number, verb: string, result: "passed" | "failed" | "skipped", reason?: string }} FlowResult */

const VERBS = /** @type {const} */ (["open", "reload", "click", "fill", "see"]);
/** The keys each verb may carry besides itself. */
const EXTRA = { open: [], reload: [], click: ["at", "expect", "ids"], fill: ["at"], see: [] };
const EXPECT = /^(GET|HEAD|POST|PUT|PATCH|DELETE) (\/\S*) (\d{3})$/;
const TARGET_KEYS = ["in", "nth", "role", "label"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A recorded session as a flow: its steps (the tracker's `steps: true`) in order. A click carries what its write was
 * answered, and a fill takes its values from the first later write whose body has that field.
 * @param {Case[]} cases @returns {Flow}
 */
export function toFlow(cases) {
  const ordered = [...cases].sort((a, b) => a.seq - b.seq);
  const steps = ordered.filter((item) => item.request.method === UI_METHOD && item.step?.kind).sort((a, b) => Number(a.step?.n) - Number(b.step?.n));
  if (!steps.length) throw new Error("this session has no recorded steps: the app needs createTracker({ steps: true }) and its UI events sent to capture's recordUi");
  const writes = ordered.filter((item) => item.step && WRITES.includes(item.request.method));
  const as = ordered.find((item) => item.actor.kind !== "anonymous")?.actor.kind;
  const env = steps.find((item) => item.step?.env)?.step?.env;
  /** @type {FlowStep[]} */
  const flow = [];
  for (const { step, request } of steps) {
    const recorded = /** @type {import("../shared/case.mjs").UiStep} */ (step);
    if (recorded.kind === "nav") flow.push(recorded.how === "reload" ? { reload: true } : { open: request.path });
    else if (recorded.kind === "fill") addFill(flow, recorded, writes);
    else flow.push(clickOf(recorded, writes));
  }
  return { ...(as && { as }), ...(env && { env }), steps: flow };
}

/**
 * Adds a recorded fill to the flow with the value the first later write sent for its field, joining the fill before
 * it. A field whose value was never sent has nothing to type and is left out.
 * @param {FlowStep[]} flow @param {import("../shared/case.mjs").UiStep} step @param {Case[]} writes
 */
function addFill(flow, step, writes) {
  const field = /** @type {string} */ (step.field);
  const body = writes.find((item) => Number(item.step?.n) >= step.n && isObject(item.request.body) && field in item.request.body)?.request.body;
  if (!isObject(body)) return;
  const last = flow.at(-1);
  if (last?.fill) last.fill[field] = body[field];
  else flow.push({ fill: { [field]: body[field] }, ...(step.ms && { at: step.ms }) });
}

/** A recorded click as a flow step, expecting the write it caused. @param {import("../shared/case.mjs").UiStep} step @param {Case[]} writes @returns {FlowStep} */
function clickOf(step, writes) {
  /** @type {Target} */
  const target = { ...(step.name && { in: step.name }), ...(step.nth !== undefined && { nth: step.nth }), ...(step.role && { role: step.role }), ...(step.label && { label: step.label }) };
  const write = writes.find((item) => item.step?.n === step.n);
  const ids = write && Object.keys(write.response.ids).length ? { ids: write.response.ids } : {};
  return {
    click: Object.keys(target).length === 1 && target.in ? target.in : target,
    ...(step.ms && { at: step.ms }),
    ...(write && { expect: `${write.request.method} ${write.request.route} ${write.response.status}`, ...ids }),
  };
}

/** Why a click target is malformed, or undefined. @param {unknown} click */
function targetProblem(click) {
  if (typeof click === "string") return ACTION_NAME.test(click) ? undefined : "click must name a data-intersite value";
  if (!isObject(click)) return "click must be a name or { in, nth, role, label }";
  const extra = Object.keys(click).find((key) => !TARGET_KEYS.includes(key));
  if (extra) return `click.${extra} is not one of ${TARGET_KEYS.join(", ")}`;
  if (click.in === undefined && click.role === undefined) return "click needs in (a data-intersite name) or role";
  if (click.in !== undefined && !ACTION_NAME.test(String(click.in))) return "click.in must name a data-intersite value";
  if (click.nth !== undefined && (!Number.isSafeInteger(click.nth) || Number(click.nth) < 0)) return "click.nth must be a whole number";
  if (click.nth !== undefined && click.in === undefined) return "click.nth counts the items of click.in, so it needs in";
  if (["role", "label"].some((key) => click[key] !== undefined && typeof click[key] !== "string")) return "click.role and click.label must be strings";
  return undefined;
}

/** Why one step is malformed, or undefined. @param {unknown} step */
function stepProblem(step) {
  if (!isObject(step)) return "must be an object";
  const verbs = VERBS.filter((verb) => verb in step);
  if (verbs.length !== 1) return `needs exactly one of ${VERBS.join(", ")}`;
  const [verb] = verbs;
  const extra = Object.keys(step).find((key) => key !== verb && !(/** @type {readonly string[]} */ (EXTRA[verb])).includes(key));
  if (extra) return `${extra} does not go on a ${verb} step`;
  if (step.at !== undefined && (!Number.isSafeInteger(step.at) || Number(step.at) < 0)) return "at must be whole milliseconds";
  return verb === "click" ? clickProblem(step) : valueProblem(verb, step[verb]);
}

/** Why the value of an open, reload, see or fill step is malformed, or undefined. @param {string} verb @param {unknown} value */
function valueProblem(verb, value) {
  if (verb === "open") return typeof value === "string" && value.startsWith("/") ? undefined : "open must be a path starting with /";
  if (verb === "reload") return value === true ? undefined : "reload must be true";
  if (verb === "see") return typeof value === "string" && value.trim() ? undefined : "see must be the text to find";
  return isObject(value) && Object.keys(value).length ? undefined : "fill must map field names to values";
}

/** Why a click step's target, expect or ids is malformed, or undefined. @param {Record<string, unknown>} step */
function clickProblem(step) {
  const target = targetProblem(step.click);
  if (target) return target;
  if (step.expect !== undefined && !EXPECT.test(String(step.expect))) return 'expect must read "METHOD /route status", such as "POST /api/ads 201"';
  if (step.ids !== undefined && !(isObject(step.ids) && Object.values(step.ids).every((id) => typeof id === "string"))) return "ids must map JSON pointers to IDs";
  return undefined;
}

/** Why a parsed flow file is malformed (the first problem, naming its step), or undefined. @param {unknown} flow */
export function flowProblem(flow) {
  if (!isObject(flow)) return "a flow is an object with steps";
  const extra = Object.keys(flow).find((key) => !["as", "env", "steps"].includes(key));
  if (extra) return `${extra} is not one of as, env, steps`;
  if (flow.as !== undefined && typeof flow.as !== "string") return "as must be an actor kind, such as member";
  const env = flow.env === undefined ? undefined : envProblem(flow.env);
  if (env) return env;
  if (!Array.isArray(flow.steps) || !flow.steps.length) return "steps must be a non-empty list";
  for (const [index, step] of flow.steps.entries()) {
    const problem = stepProblem(step);
    if (problem) return `step ${index + 1}: ${problem}`;
  }
  return undefined;
}

/**
 * @typedef {object} RunOptions
 * @property {string} uiTarget  The web app's origin.
 * @property {string} target    The API's origin; sign-in cookies and headers go to both.
 * @property {import("./run.mjs").Adapter} adapter
 * @property {RegExp} pattern   What an ID looks like, to resolve the IDs pages name.
 * @property {boolean} headed
 * @property {string} [browser]
 * @property {string} [browserUrl]
 * @property {"recorded" | "none"} network  "recorded" plays each flow on its `env`: latency, bandwidth, CPU, viewport.
 * @property {"fast" | "recorded"} timing   "recorded" acts at each step's `at`, as soon as a page commits; "fast" as soon as the element is there.
 * @property {number} concurrency  Flows at once, each in its own browser context.
 */

/**
 * Plays each flow in one shared browser, `concurrency` at a time, in intersite-core (core/src/flow.rs), which drives
 * Chrome over the DevTools protocol. Before each flow it asks for the adapter's reset, sign-in and IDs, answered here
 * because the adapter is the project's JavaScript. A flow stops at its first failed or skipped step.
 * @param {{ file: string, flow: Flow }[]} flows @param {RunOptions} options
 * @returns {Promise<{ file: string, steps: FlowResult[] }[]>}
 */
export async function runFlows(flows, options) {
  const { uiTarget, target, headed, browser = "chrome", browserUrl = "", network, timing, concurrency } = options;
  const engine = await startEngine({ uiTarget, target, headed, browser, browserUrl, network, timing, concurrency }, (index) => prepare(flows[index].flow, options));
  try {
    return await Promise.all(flows.map(async ({ file, flow }) => ({ file, steps: await engine.run(flow) })));
  } finally {
    await engine.close();
  }
}

/**
 * What a flow needs from the adapter before it starts: a reset, its actor signed in (a `cookie` header becomes
 * cookies), and every ID its pages name that the flow does not create itself, resolved; one with no answer is
 * reported with why, and the step that opens it is skipped.
 * @param {Flow} flow @param {RunOptions} options
 */
async function prepare(flow, { target, adapter, pattern }) {
  await adapter.reset?.({ target });
  const kind = flow.as && flow.as !== "anonymous" ? flow.as : undefined;
  const { cookies, headers } = splitCookie(kind ? await adapter.signIn(kind, { target, other: false }) : {});
  const created = new Set(flow.steps.flatMap((step) => Object.values(step.ids ?? {})));
  const named = new Set(flow.steps.flatMap((step) => step.open?.split("/") ?? []).filter((segment) => pattern.test(segment) && !created.has(segment)));
  /** @type {Map<string, string>} */
  const ids = new Map();
  /** @type {Record<string, string>} */
  const unresolved = {};
  for (const id of named) {
    const reason = await resolveIds([id], ids, { target, adapter });
    if (reason) unresolved[id] = reason;
  }
  return { cookies, headers, ids: Object.fromEntries(ids), unresolved };
}
