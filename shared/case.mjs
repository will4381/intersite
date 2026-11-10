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
 */

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
  const { request, response } = item;
  if (typeof request?.method !== "string" || typeof request.route !== "string" || typeof request.path !== "string") return "request needs method, route and path";
  if (request.query === null || typeof request.query !== "object") return "request.query must be an object";
  if (!Number.isInteger(response?.status)) return "response.status must be an integer";
  if (response.shape === undefined || response.ids === null || typeof response.ids !== "object") return "response needs shape and ids";
  if (!Number.isInteger(item.ttlDays) || item.ttlDays < 1 || item.ttlDays > MAX_TTL_DAYS) return `ttlDays must be 1 to ${MAX_TTL_DAYS}`;
  if (item.action !== undefined) {
    if (!ACTION_NAME.test(item.action?.name ?? "")) return "action.name must be lowercase letters, digits, dots, dashes, colons or underscores";
    if (typeof item.action.page !== "string" || !item.action.page.startsWith("/") || item.action.page.length > 256) return "action.page must be a path of at most 256 characters";
  }
  if (JSON.stringify(item).length > MAX_CASE_BYTES) return `larger than ${MAX_CASE_BYTES} bytes`;
  return undefined;
}
