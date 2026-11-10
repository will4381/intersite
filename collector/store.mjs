// @ts-check
// Every SQL statement the collector runs. Routes call these; nothing else touches D1.
import { caseProblem } from "../shared/case.mjs";

/** @typedef {import("../shared/case.mjs").Case} Case */
/** Just the D1 surface used here. @typedef {{ prepare(sql: string): any, batch(statements: any[]): Promise<any[]> }} D1 */

const DAY_MS = 86_400_000;
/** Candidate session lookups read at most this many case rows, whatever the filters. */
const CANDIDATE_ROWS = 5000;
/** D1 allows 100 bound parameters per statement. */
const PARAM_CHUNK = 90;
const CLEANUP_BATCH = 1000;
/** D1 free plan allows 50 queries per invocation; leave room for the two tail statements. */
const CLEANUP_MAX_BATCHES = 40;

/** @param {string} outcome */
const classOf = (outcome) => (outcome === "ok" ? "ok" : "other");

/**
 * Validates, dedupes and caps, then stores in one batch.
 * Reads: one primary-key lookup per case plus the two counter rows.
 * @param {D1} db
 * @param {unknown[]} items
 * @param {{ ok: number, other: number }} cap
 * @param {number} now epoch ms
 */
export async function ingest(db, items, cap, now) {
  /** @type {{ id: string, reason: string }[]} */
  const dropped = [];
  /** @type {Case[]} */
  const valid = [];
  for (const item of items) {
    const reason = caseProblem(item);
    const id = typeof (/** @type {any} */ (item)?.id) === "string" ? /** @type {any} */ (item).id : "";
    if (reason) dropped.push({ id, reason });
    else valid.push(/** @type {Case} */ (item));
  }

  /** @type {Map<string, Case[]>} */
  const byProject = new Map();
  for (const item of valid) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item]);

  const day = new Date(now).toISOString().slice(0, 10);
  const statements = [];
  let accepted = 0;
  for (const [project, cases] of byProject) {
    const existing = new Set();
    for (let i = 0; i < cases.length; i += PARAM_CHUNK) {
      const ids = cases.slice(i, i + PARAM_CHUNK).map((item) => item.id);
      const { results } = await db
        .prepare(`SELECT id FROM cases WHERE project = ? AND id IN (${ids.map(() => "?").join(",")})`)
        .bind(project, ...ids)
        .all();
      for (const row of results) existing.add(row.id);
    }
    const { results: counts } = await db.prepare("SELECT class, n FROM daily_counts WHERE project = ? AND day = ?").bind(project, day).all();
    /** @type {Record<string, number>} */
    const used = { ok: 0, other: 0 };
    for (const row of counts) used[row.class] = row.n;
    /** @type {Record<string, number>} */
    const added = { ok: 0, other: 0 };

    for (const item of cases) {
      if (existing.has(item.id)) continue; // duplicate: capture retried, ignore silently
      existing.add(item.id);
      const cls = classOf(item.outcome);
      if (used[cls] + added[cls] >= cap[/** @type {"ok" | "other"} */ (cls)]) {
        dropped.push({ id: item.id, reason: "cap" });
        continue;
      }
      added[cls]++;
      accepted++;
      const atMs = Date.parse(item.at);
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO cases (project, id, session, seq, at_ms, outcome, route, expires, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(project, item.id, item.session, item.seq, atMs, item.outcome, item.request.route, atMs + item.ttlDays * DAY_MS, JSON.stringify(item)),
      );
    }
    // ponytail: soft cap, two concurrent requests can both pass the check; move the check into the upsert's WHERE if overshoot matters.
    for (const cls of ["ok", "other"]) {
      if (!added[cls]) continue;
      statements.push(
        db
          .prepare("INSERT INTO daily_counts (project, day, class, n) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET n = n + excluded.n")
          .bind(project, day, cls, added[cls]),
      );
    }
  }
  if (statements.length) await db.batch(statements);
  return { accepted, dropped };
}

/**
 * Deterministic for a given seed: candidates are sorted, then shuffled with a seeded PRNG.
 * Reads: at most CANDIDATE_ROWS case rows for candidates, plus every case of the sampled sessions.
 * @param {D1} db
 * @param {{ project: string, outcomes: string[], route?: string, action?: string, since?: number, knownGood: boolean, sample: number, seed: number }} query
 */
export async function sessions(db, query) {
  // ponytail: outcome, route and since must all hold on the same case; per-filter session matching needs one candidate query per filter.
  const where = ["project = ?"];
  /** @type {unknown[]} */
  const params = [query.project];
  if (query.outcomes.length) {
    where.push(`outcome IN (${query.outcomes.map(() => "?").join(",")})`);
    params.push(...query.outcomes);
  }
  if (query.route !== undefined) {
    where.push("route = ?");
    params.push(query.route);
  }
  if (query.action !== undefined) {
    where.push("json_extract(body, '$.action.name') = ?");
    params.push(query.action);
  }
  if (query.since !== undefined) {
    where.push("at_ms >= ?");
    params.push(query.since);
  }
  if (query.knownGood) {
    where.push("session IN (SELECT session FROM results WHERE project = ? AND pass = 1)");
    params.push(query.project);
  }
  const { results } = await db
    .prepare(`SELECT DISTINCT session FROM (SELECT session FROM cases WHERE ${where.join(" AND ")} ORDER BY at_ms DESC LIMIT ${CANDIDATE_ROWS})`)
    .bind(...params)
    .all();
  const candidates = results.map((/** @type {any} */ row) => /** @type {string} */ (row.session)).sort();

  const random = mulberry32(query.seed);
  const count = Math.min(query.sample, candidates.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const picked = candidates.slice(0, count);

  /** @type {Map<string, Case[]>} */
  const cases = new Map(picked.map((session) => [session, []]));
  const statements = [];
  for (let i = 0; i < picked.length; i += PARAM_CHUNK) {
    const chunk = picked.slice(i, i + PARAM_CHUNK);
    statements.push(
      db
        .prepare(`SELECT session, body FROM cases WHERE project = ? AND session IN (${chunk.map(() => "?").join(",")}) ORDER BY session, seq, id`)
        .bind(query.project, ...chunk),
    );
  }
  for (const { results: rows } of statements.length ? await db.batch(statements) : []) {
    for (const row of rows) cases.get(row.session)?.push(JSON.parse(row.body));
  }
  return picked.map((session) => ({ session, cases: cases.get(session) ?? [] }));
}

/**
 * One row per action name and page: a count per outcome and the latest time, errors first.
 * Reads: one index row per case with an action in the project (cases_by_action holds no others), whatever `since` is.
 * @param {D1} db @param {string} project @param {number} since epoch ms
 */
export async function actions(db, project, since) {
  const { results } = await db
    .prepare(
      "SELECT json_extract(body, '$.action.name') AS name, json_extract(body, '$.action.page') AS page, outcome, COUNT(*) AS n, MAX(at_ms) AS last FROM cases INDEXED BY cases_by_action WHERE project = ? AND json_extract(body, '$.action.name') IS NOT NULL AND at_ms >= ? GROUP BY 1, 2, 3",
    )
    .bind(project, since)
    .all();
  /** @type {Map<string, { name: string, page: string, ok: number, warn: number, rejected: number, error: number, lastAt: number | string }>} */
  const rows = new Map();
  for (const { name, page, outcome, n, last } of results) {
    const key = JSON.stringify([name, page]);
    const row = rows.get(key) ?? { name, page, ok: 0, warn: 0, rejected: 0, error: 0, lastAt: 0 };
    row[/** @type {"ok" | "warn" | "rejected" | "error"} */ (outcome)] = n;
    row.lastAt = Math.max(/** @type {number} */ (row.lastAt), last);
    rows.set(key, row);
  }
  const order = (/** @type {any} */ a, /** @type {any} */ b) =>
    b.error - a.error || b.rejected - a.rejected || b.warn - a.warn || a.name.localeCompare(b.name) || a.page.localeCompare(b.page);
  return [...rows.values()].sort(order).map((row) => ({ ...row, lastAt: new Date(row.lastAt).toISOString() }));
}

/**
 * The case and the earlier cases of its session, in seq order. Undefined when the case is unknown.
 * @param {D1} db @param {string} project @param {string} id
 */
export async function caseWithHistory(db, project, id) {
  const found = await db.prepare("SELECT session, seq FROM cases WHERE project = ? AND id = ?").bind(project, id).first();
  if (!found) return undefined;
  const { results } = await db
    .prepare("SELECT body FROM cases WHERE project = ? AND session = ? AND (seq < ? OR id = ?) ORDER BY seq, id")
    .bind(project, found.session, found.seq, id)
    .all();
  return { session: /** @type {string} */ (found.session), cases: results.map((/** @type {any} */ row) => JSON.parse(row.body)) };
}

/** @param {D1} db @param {string} project @param {string} id @param {boolean} pinned @returns {Promise<boolean>} whether the case exists */
export async function pin(db, project, id, pinned) {
  const result = await db.prepare("UPDATE cases SET pinned = ? WHERE project = ? AND id = ?").bind(pinned ? 1 : 0, project, id).run();
  return result.meta.changes > 0;
}

/**
 * Overwrites each session's latest result.
 * @param {D1} db @param {string} project @param {string} release @param {{ session: string, pass: boolean }[]} results @param {number} now
 */
export async function recordResults(db, project, release, results, now) {
  if (!results.length) return 0;
  await db.batch(
    results.map((result) =>
      db
        .prepare(
          "INSERT INTO results (project, session, release, pass, at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET release = excluded.release, pass = excluded.pass, at_ms = excluded.at_ms",
        )
        .bind(project, result.session, release, result.pass ? 1 : 0, now),
    ),
  );
  return results.length;
}

/**
 * Deletes expired unpinned cases in batches, then counters older than two days and results of sessions with no cases left.
 * @param {D1} db @param {number} now
 */
export async function cleanup(db, now) {
  let deleted = 0;
  // ponytail: at most 40k cases per run; run the cron more often if a day's expiries outgrow it.
  for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
    const result = await db
      .prepare(`DELETE FROM cases WHERE rowid IN (SELECT rowid FROM cases WHERE pinned = 0 AND expires < ? LIMIT ${CLEANUP_BATCH})`)
      .bind(now)
      .run();
    deleted += result.meta.changes;
    if (result.meta.changes < CLEANUP_BATCH) break;
  }
  await db.batch([
    db.prepare("DELETE FROM daily_counts WHERE day < ?").bind(new Date(now - 2 * DAY_MS).toISOString().slice(0, 10)),
    db.prepare("DELETE FROM results WHERE NOT EXISTS (SELECT 1 FROM cases WHERE cases.project = results.project AND cases.session = results.session)"),
  ]);
  return deleted;
}

/** Small seeded PRNG; same seed, same sequence. @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
