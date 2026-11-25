// @ts-check

export const OUTCOMES = /** @type {const} */ (["ok", "warn", "rejected", "error"]);
export const MAX_CASE_BYTES = 65_536;
export const MAX_TTL_DAYS = 365;

/**
 * One captured request and what it returned. Scrubbed before it leaves the project's server.
 * @typedef {object} Case
 * @property {1} v
 * @property {string} id            The request ID (the "Ref" a user can quote).
 * @property {string} project
 * @property {string} session       Hash of the caller and the UTC day; never a raw user ID.
 * @property {number} seq           Epoch milliseconds; orders the cases of one session.
 * @property {string} at            ISO timestamp.
 * @property {string} release       Git SHA (or version) that served it.
 * @property {(typeof OUTCOMES)[number]} outcome
 * @property {{ kind: string }} actor   A role name such as "creator" or "anonymous"; never a credential.
 * @property {{ method: string, route: string, path: string, query: Record<string, string>, body: unknown }} request
 * @property {{ status: number, shape: import("./shape.mjs").Shape, ids: Record<string, string>, errorCode?: string }} response
 * @property {number} ttlDays       How long the collector keeps it.
 * @property {{ name: string, page: string }} [action]   The named user action that caused it, and the page it happened on.
 * @property {UiStep} [step]  On a request: `{ n }`, the tab's step that caused it. On a UI case: the step itself.
 */

/**
 * One thing a user did in a tab, numbered in order (`n`). Never holds what was typed: a fill names the field only.
 * @typedef {object} UiStep
 * @property {number} n
 * @property {"nav" | "click" | "fill"} [kind]   Absent on a request's step.
 * @property {"load" | "reload" | "push" | "pop"} [how]  A nav: first load, reload, an in-app route change, back/forward.
 * @property {string} [name]   The nearest `data-intersite` name around the element.
 * @property {number} [nth]    The list item clicked, counted among the named element's items.
 * @property {string} [role]   An element without a name of its own: its role, such as `button` or `link`.
 * @property {string} [label]  Its text, every word but a sentence-case first word or a lowercase word reduced to `_`.
 * @property {string} [field]  A fill: the control's `name` or `id`.
 * @property {number} [ms]     Milliseconds since the page loaded or the route changed, to the nearest 100.
 * @property {Env} [env]       On a nav that loads a page: the user's connection and device, in buckets.
 */

/**
 * @typedef {{ rtt?: number, down?: number, cpu?: number, viewport?: [number, number], mobile?: boolean }} Env
 * `rtt` in ms, `down` in Mbit/s, `cpu` a slowdown factor against a fast laptop.
 */

/** The buckets an Env's values are rounded into, so they say how slow a user was without singling one out. */
export const RTT_MS = [25, 50, 100, 150, 300, 600, 1000, 2000];
export const DOWN_MBPS = [0.4, 1.5, 5, 10, 25, 50, 100];
export const CPU_SLOWDOWN = [1, 2, 4, 6];

/** Up to the next bucket (latency) or down to the one below (bandwidth): either way the slower side. @param {number} value @param {number[]} buckets @param {"up" | "down"} way */
export function bucket(value, buckets, way) {
  return way === "up" ? (buckets.find((edge) => edge >= value) ?? /** @type {number} */ (buckets.at(-1))) : (buckets.findLast((edge) => edge <= value) ?? buckets[0]);
}

const STEP_KEYS = { nav: ["n", "kind", "how", "ms", "env"], click: ["n", "kind", "name", "nth", "role", "label", "ms"], fill: ["n", "kind", "name", "field", "ms"] };
const ROLE = /^[a-z]{1,20}$/;
/** What `reduceLabel` gives: up to five words, each `_`, lowercase, or (the first) sentence case. */
const LABEL = /^(?:_|[A-Za-z][a-z]{0,19})(?: (?:_|[a-z]{1,20})){0,4}$/;
const FIELD = /^[A-Za-z_$][A-Za-z0-9_.$-]{0,63}$/;

/**
 * An element's text as a step may store it: a sentence-case first word and lowercase words are kept, anything else
 * (a capitalized name, digits, an email) becomes `_`. Undefined when nothing is left.
 * ponytail: a lowercase personal word ("message alice" written lowercase) is kept, as `reducePage` keeps `/u/maria`.
 * @param {string} text
 */
export function reduceLabel(text) {
  const words = text.trim().split(/\s+/).slice(0, 5).map((word, index) => (/^[a-z]{1,20}$/.test(word) || (index === 0 && /^[A-Z][a-z]{0,19}$/.test(word)) ? word : "_"));
  return words.some((word) => word !== "_") ? words.join(" ") : undefined;
}

/** @param {unknown} value @param {number} max */
const count = (value, max) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 && /** @type {number} */ (value) <= max;

/** The items of a named list a click can pick by position. The tracker counts them and a flow finds them the same way. */
export const LIST_ITEM = "li, tr, [role=listitem], [role=row], [role=option]";

/** Why an Env is malformed, or undefined. @param {any} env @returns {string | undefined} */
export function envProblem(env) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) return "env must be an object";
  const extra = Object.keys(env).find((key) => !["rtt", "down", "cpu", "viewport", "mobile"].includes(key));
  if (extra) return `env.${extra} is not a known field`;
  if (env.rtt !== undefined && !RTT_MS.includes(env.rtt)) return `env.rtt must be one of ${RTT_MS.join(", ")}`;
  if (env.down !== undefined && !DOWN_MBPS.includes(env.down)) return `env.down must be one of ${DOWN_MBPS.join(", ")}`;
  if (env.cpu !== undefined && !CPU_SLOWDOWN.includes(env.cpu)) return `env.cpu must be one of ${CPU_SLOWDOWN.join(", ")}`;
  if (env.viewport !== undefined && !(Array.isArray(env.viewport) && env.viewport.length === 2 && env.viewport.every((/** @type {unknown} */ side) => count(side, 10_000)))) return "env.viewport must be [width, height]";
  if (env.mobile !== undefined && typeof env.mobile !== "boolean") return "env.mobile must be a boolean";
  return undefined;
}

/**
 * Why a step is malformed, or undefined. A UI case's step needs a kind and only that kind's fields; a request's step
 * is `{ n }` alone. Unknown fields are refused, so nothing a client adds is stored.
 * @param {any} step @param {boolean} ui
 * @returns {string | undefined}
 */
export function stepProblem(step, ui) {
  if (step === null || typeof step !== "object" || !count(step.n, 1_000_000)) return "step.n must be an integer from 0 to 1000000";
  if (!ui) return Object.keys(step).length === 1 ? undefined : "a request's step holds n only";
  const keys = STEP_KEYS[/** @type {keyof typeof STEP_KEYS} */ (step.kind)];
  if (!keys) return "step.kind must be nav, click or fill";
  const extra = Object.keys(step).find((key) => !keys.includes(key));
  if (extra) return `step.${extra} does not belong on a ${step.kind} step`;
  return fieldsProblem(step) ?? (step.env === undefined ? undefined : envProblem(step.env));
}

/** Why a UI step's fields hold something they may not, or undefined. @param {any} step @returns {string | undefined} */
function fieldsProblem(step) {
  if (step.kind === "nav" && !["load", "reload", "push", "pop"].includes(step.how)) return "step.how must be load, reload, push or pop";
  if (step.name !== undefined && !ACTION_NAME.test(step.name)) return "step.name must be an action name";
  if (step.nth !== undefined && !count(step.nth, 9999)) return "step.nth must be an integer from 0 to 9999";
  if (step.role !== undefined && !ROLE.test(step.role)) return "step.role must be a lowercase word";
  if (step.label !== undefined && !LABEL.test(step.label)) return "step.label must be reduced by reduceLabel";
  if (step.kind === "click" && step.name === undefined && step.role === undefined) return "a click step needs a name or a role";
  if (step.kind === "fill" && !FIELD.test(step.field ?? "")) return "a fill step needs the field's name";
  if (step.ms !== undefined && !count(step.ms, 86_400_000)) return "step.ms must be an integer from 0 to 86400000";
  return undefined;
}

/** A case with this method is a UI-only event (a client error or warning with no API call); its status is 0. */
export const UI_METHOD = "UI";

/** Action names are written by developers (`data-intersite="program.save"`), never derived from page text. */
export const ACTION_NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/** An error's class name, such as TypeError. The only part of a client error that is stored. */
export const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const PAGE_WORD = /^[a-z]{1,20}$/;

/**
 * A browser path with every segment that is not an ID or a short lowercase word replaced by `_`, so a page can be
 * stored without the names, emails or search text a URL may carry.
 * @param {string} path @param {(segment: string) => boolean} isId
 */
export function reducePage(path, isId) {
  return path.split("/").map((segment) => (segment === "" || PAGE_WORD.test(segment) || isId(segment) ? segment : "_")).join("/");
}

const idText = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Why a value is not a storable case, or undefined when it is. The collector runs this on everything it is sent.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function caseProblem(value) {
  if (value === null || typeof value !== "object") return "not an object";
  const item = /** @type {Record<string, any>} */ (value);
  if (item.v !== 1) return "v must be 1";
  for (const key of ["id", "project", "session"]) if (!idText.test(item[key] ?? "")) return `${key} is missing or malformed`;
  if (!Number.isSafeInteger(item.seq)) return "seq must be an integer";
  if (typeof item.at !== "string" || Number.isNaN(Date.parse(item.at))) return "at must be an ISO timestamp";
  if (typeof item.release !== "string") return "release must be a string";
  if (!OUTCOMES.includes(item.outcome)) return "outcome is not one of ok, warn, rejected, error";
  if (typeof item.actor?.kind !== "string") return "actor.kind must be a string";
  const exchange = exchangeProblem(item);
  if (exchange) return exchange;
  if (!Number.isInteger(item.ttlDays) || item.ttlDays < 1 || item.ttlDays > MAX_TTL_DAYS) return `ttlDays must be 1 to ${MAX_TTL_DAYS}`;
  if (item.action !== undefined) {
    const action = actionProblem(item.action);
    if (action) return action;
  }
  if (item.step !== undefined) {
    const step = stepProblem(item.step, item.request.method === UI_METHOD);
    if (step) return step;
  }
  if (JSON.stringify(item).length > MAX_CASE_BYTES) return `larger than ${MAX_CASE_BYTES} bytes`;
  return undefined;
}

/** caseProblem's checks of the request and response. @param {Record<string, any>} item @returns {string | undefined} */
function exchangeProblem({ request, response }) {
  if (typeof request?.method !== "string" || typeof request.route !== "string" || typeof request.path !== "string") return "request needs method, route and path";
  if (request.query === null || typeof request.query !== "object") return "request.query must be an object";
  if (!Number.isInteger(response?.status)) return "response.status must be an integer";
  if (response.shape === undefined || response.ids === null || typeof response.ids !== "object") return "response needs shape and ids";
  return undefined;
}

/** caseProblem's checks of a named user action. @param {any} action @returns {string | undefined} */
function actionProblem(action) {
  if (!ACTION_NAME.test(action?.name ?? "")) return "action.name must be lowercase letters, digits, dots, dashes, colons or underscores";
  if (typeof action.page !== "string" || !action.page.startsWith("/") || action.page.length > 256) return "action.page must be a path of at most 256 characters";
  return undefined;
}
