// @ts-check
// The metric ratchet: counters a server reports per request, compared between two local replay runs of the same sessions.

/** @typedef {Record<string, Record<string, number>>} Metrics caseId -> counter name -> count */

/**
 * The counters in a `Server-Timing` header: each entry whose `desc` is a number, alone or followed by a unit word
 * (`queries;desc=7`, `db;desc="7 trips"`). Entries with only `dur` are left out, since durations vary and counts do not.
 * @param {string | null} header @returns {Record<string, number>}
 */
export function countersOf(header) {
  /** @type {Record<string, number>} */
  const counters = {};
  // ponytail: splits on every comma, so a quoted non-numeric desc holding a comma is misread (and dropped); parse quotes if a server sends those.
  for (const entry of (header ?? "").split(",")) {
    const [name, ...params] = entry.split(";").map((part) => part.trim());
    const desc = params.find((param) => /^desc\s*=/i.test(param))?.replace(/^desc\s*=\s*/i, "").replace(/^"(.*)"$/, "$1");
    const count = /^(\d+(?:\.\d+)?)(?: [a-z][a-z -]*)?$/i.exec(desc ?? "")?.[1];
    if (name && count) counters[name] = Number(count);
  }
  return counters;
}

/**
 * Each case with a counter that is higher now than in the base run. A case or counter missing on either side is ignored.
 * @param {Metrics} base @param {Metrics} now @returns {{ caseId: string, reason: string }[]}
 */
export function compareMetrics(base, now) {
  return Object.entries(now).flatMap(([caseId, counters]) => {
    const higher = Object.entries(counters)
      .filter(([name, count]) => base[caseId]?.[name] !== undefined && count > base[caseId][name])
      .map(([name, count]) => `${name} ${base[caseId][name]} → ${count}`);
    return higher.length ? [{ caseId, reason: higher.join(", ") }] : [];
  });
}
