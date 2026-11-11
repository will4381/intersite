// @ts-check

/**
 * Prefixed public IDs (`prog_8fK2abQ9`) and UUIDs. Projects override it with `capture.idPattern`. The part after the
 * prefix holds a digit or a capital, or is 16 characters or more: `not_started`, `in_review` and `session_required`
 * are snake_case words (enum values, error codes), not IDs.
 */
export const DEFAULT_ID_PATTERN =
  "^(?:[a-z][a-z0-9]{1,15}_(?:(?=[a-z]*[0-9A-Z])[A-Za-z0-9]{6,}|[a-z]{16,})|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$";

/**
 * A shape is a JSON value's keys and types with the values dropped:
 * "string" | "number" | "boolean" | "null", an object of shapes, or an array of the distinct element shapes.
 * @typedef {string | Shape[] | { [key: string]: Shape }} Shape
 */

/** @param {unknown} value @returns {Shape} */
export function shapeOf(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    /** @type {Map<string, Shape>} */
    const distinct = new Map();
    for (const item of value) {
      const shape = shapeOf(item);
      distinct.set(JSON.stringify(shape), shape);
    }
    return [...distinct.keys()].sort().map((key) => /** @type {Shape} */ (distinct.get(key)));
  }
  if (typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, shapeOf(record[key])]));
  }
  return typeof value;
}

/**
 * Where a replayed shape departs from the recorded one, or undefined when they agree.
 * "null" matches anything and an empty array matches any array, since both depend on the data, not the code; so does
 * a row shape the recording had not seen, while another row still matches.
 * @param {Shape} recorded @param {Shape} replayed @param {string} [path]
 * @returns {string | undefined}
 */
export function shapeDiff(recorded, replayed, path = "") {
  const at = path || "/";
  if (recorded === "null" || replayed === "null") return undefined;
  if (typeof recorded === "string" || typeof replayed === "string") {
    return recorded === replayed ? undefined : `${at}: recorded ${kind(recorded)}, got ${kind(replayed)}`;
  }
  if (Array.isArray(recorded) || Array.isArray(replayed)) {
    if (!Array.isArray(recorded) || !Array.isArray(replayed)) return `${at}: recorded ${kind(recorded)}, got ${kind(replayed)}`;
    if (recorded.length === 0 || replayed.length === 0) return undefined;
    // Rows of one list vary with the data (an account with a parent beside one without); the list keeps its shape while
    // at least one replayed row matches a recorded one. A change to every row (a field renamed or retyped) still fails.
    const diffs = replayed.map((element) => recorded.map((candidate) => shapeDiff(candidate, element, `${path}/*`)));
    return diffs.some((row) => row.includes(undefined)) ? undefined : diffs[0][0];
  }
  for (const key of Object.keys(recorded)) if (!(key in replayed)) return `${path}/${key}: missing`;
  for (const key of Object.keys(replayed)) if (!(key in recorded)) return `${path}/${key}: not in the recording`;
  for (const key of Object.keys(recorded)) {
    const diff = shapeDiff(recorded[key], replayed[key], `${path}/${key}`);
    if (diff) return diff;
  }
  return undefined;
}

/** @param {Shape} shape */
function kind(shape) {
  if (typeof shape === "string") return shape;
  return Array.isArray(shape) ? "array" : "object";
}

/**
 * Every ID-looking string in a JSON value, keyed by its JSON pointer.
 * @param {unknown} value @param {RegExp} pattern @param {string} [path] @param {Record<string, string>} [found]
 */
export function idsOf(value, pattern, path = "", found = {}) {
  if (typeof value === "string") {
    if (pattern.test(value)) found[path || "/"] = value;
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => idsOf(item, pattern, `${path}/${index}`, found));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) idsOf(item, pattern, `${path}/${key}`, found);
  }
  return found;
}
