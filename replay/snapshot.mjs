// @ts-check
// The snapshot diff: each baseline answer's status and JSON body, normalised so two runs of the same code on the same
// data are identical, then compared between two local runs (before and after a migration, backfill or refactor).

/** @typedef {{ status: number, body: unknown }} Answer */
/** @typedef {Record<string, Answer>} Snapshot caseId -> normalised answer */
/** @typedef {{ pointer: string, before?: unknown, after?: unknown, order?: unknown[][] }} Difference `order` is the ids of the rows on both sides, before and after */
/** @typedef {{ created: Set<string>, numbers: Map<string, number>, from: number }} Run */

const NEAR = 10 * 60_000;
const SHOWN = 3;
const VALUE = 40;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const REQUEST_ID_KEY = /^(?:request|trace|correlation)[_-]?id$/i;

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A global pattern matching any of `ids` as a whole token (not inside a longer ID), or undefined when there are none.
 * @param {Iterable<string>} ids
 */
export function idMatcher(ids) {
  const list = [...ids];
  return list.length ? new RegExp(`(?<![\\w-])(?:${list.map(escape).join("|")})(?![\\w-])`, "g") : undefined;
}

/**
 * A JSON body with the values that change from run to run on their own replaced, everything else kept exactly: an ID
 * this session created (`run.created`, also inside a longer string) becomes `<id:n>`, numbered across the session in
 * order of first appearance; a timestamp from ten minutes before the session started to ten minutes from now becomes
 * `<now>`; a string under a request-ID key (`requestId`, `trace_id`, `correlationId`) becomes `<request-id>`.
 * @param {unknown} body @param {Run} run @returns {unknown}
 */
export function normalise(body, run) {
  const created = idMatcher(run.created);
  const to = Date.now() + NEAR;
  /** @param {string} id */
  const placeholder = (id) => {
    if (!run.numbers.has(id)) run.numbers.set(id, run.numbers.size + 1);
    return `<id:${run.numbers.get(id)}>`;
  };
  /** @param {unknown} value @param {string} key @returns {unknown} */
  const walk = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    if (typeof value !== "string") return value;
    if (REQUEST_ID_KEY.test(key)) return "<request-id>";
    const time = TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
    if (time > run.from - NEAR && time < to) return "<now>";
    return created ? value.replace(created, placeholder) : value;
  };
  return walk(body, "");
}

/**
 * Each case whose status or body differs between the base snapshot and this run. A case missing on either side is
 * ignored. `ignore` holds JSON-pointer globs (`/items/*\/etag`, `*` is one segment) left out of the comparison.
 * @param {Snapshot} base @param {Snapshot} now @param {string[]} ignore
 * @returns {{ caseId: string, differences: Difference[] }[]}
 */
export function compareSnapshots(base, now, ignore) {
  const ignored = ignore.map((glob) => new RegExp(`^${glob.split("*").map(escape).join("[^/]*")}$`));
  return Object.entries(now).flatMap(([caseId, answer]) => {
    const before = base[caseId];
    if (!before) return [];
    /** @type {Difference[]} */
    const out = [];
    if (before.status !== answer.status) out.push({ pointer: "status", before: before.status, after: answer.status });
    diff(before.body, answer.body, "", { ignored, out });
    return out.length ? [{ caseId, differences: out }] : [];
  });
}

/** The first few differences as one line's worth of text, with a count of the rest. @param {Difference[]} differences */
export function describe(differences) {
  const shown = differences.slice(0, SHOWN).map(({ pointer, before, after, order }) =>
    (order ? `${pointer} reordered ${show(order[0])} → ${show(order[1])}` : `${pointer} ${show(before)} → ${show(after)}`));
  const rest = differences.length - SHOWN;
  return shown.join("; ") + (rest > 0 ? `; and ${rest} more` : "");
}

/** @param {unknown} value */
function show(value) {
  const text = value === undefined ? "(none)" : JSON.stringify(value);
  return text.length > VALUE ? `${text.slice(0, VALUE - 1)}…` : text;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Pushes where `after` departs from `before` to `context.out`. Arrays compare by position, except when every element
 * on both sides is an object with a distinct `id`: then by id, so a reorder is one difference, not every row.
 * @param {unknown} before @param {unknown} after @param {string} pointer
 * @param {{ ignored: RegExp[], out: Difference[] }} context
 */
function diff(before, after, pointer, context) {
  if (context.ignored.some((glob) => glob.test(pointer)) || JSON.stringify(before) === JSON.stringify(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyed = keys(before) && keys(after);
    if (!keyed) for (let index = 0; index < Math.max(before.length, after.length); index++) diff(before[index], after[index], `${pointer}/${index}`, context);
    else diffById(before, after, pointer, context);
    return;
  }
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diff(before[key], after[key], `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, context);
    }
    return;
  }
  context.out.push({ pointer: pointer || "/", before, after });
}

/** Each element's `id` as text, when every element is an object with a distinct one. @param {unknown[]} list */
function keys(list) {
  const ids = list.map((item) => (isObject(item) && item.id !== undefined && item.id !== null ? JSON.stringify(item.id) : undefined));
  return list.length && ids.every((id) => id !== undefined) && new Set(ids).size === ids.length ? /** @type {string[]} */ (ids) : undefined;
}

/**
 * Arrays of objects with ids: a changed order of the rows on both sides is one difference; then each row present on
 * both sides is compared by id, and a row on one side only is a difference at its index.
 * @param {unknown[]} before @param {unknown[]} after @param {string} pointer @param {{ ignored: RegExp[], out: Difference[] }} context
 */
function diffById(before, after, pointer, context) {
  const was = /** @type {string[]} */ (keys(before));
  // ponytail: includes/indexOf per row is O(n²); index by id if a snapshot holds lists of thousands of rows.
  const now = /** @type {string[]} */ (keys(after));
  const kept = was.filter((id) => now.includes(id));
  const moved = now.filter((id) => was.includes(id));
  if (kept.join() !== moved.join()) context.out.push({ pointer: pointer || "/", order: [kept, moved].map((ids) => ids.map((id) => JSON.parse(id))) });
  was.forEach((id, index) => { if (!now.includes(id)) diff(before[index], undefined, `${pointer}/${index}`, context); });
  now.forEach((id, index) => diff(was.includes(id) ? before[was.indexOf(id)] : undefined, after[index], `${pointer}/${index}`, context));
}
