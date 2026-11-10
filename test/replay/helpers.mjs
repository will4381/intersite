// @ts-check
// Test doubles for replay: a toy two-tenant target, a fake collector implementing the contract's read routes,
// and cases recorded from a pretend production.
import { createServer } from "node:http";

import { DEFAULT_ID_PATTERN, idsOf, shapeOf } from "../../shared/shape.mjs";

export const READ_TOKEN = "read-secret";

/** @param {import("node:http").RequestListener} handler */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

/** @param {import("node:http").IncomingMessage} req */
async function readJson(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Notes and comments in memory, two tenants chosen by `x-tenant`. Turn on bugs by adding to `bugs`:
 * "status", "shape", "twice" (repeat archive gives 500), "leak" (reads ignore the tenant), "ledger" (stats broken),
 * "n+1" (each request runs more queries, as reported in its Server-Timing header).
 */
export async function startTarget() {
  /** @type {Set<string>} */
  const bugs = new Set();
  /** @type {{ method: string, path: string, body: any, headers: import("node:http").IncomingHttpHeaders }[]} */
  const log = [];
  /** @type {Map<string, { id: string, tenant: string, text: string, archived: boolean }>} */
  let notes = new Map();
  let counter = 0;
  const reset = () => {
    notes = new Map([["note_seed01", { id: "note_seed01", tenant: "a", text: "seed", archived: false }]]);
    counter = 0;
  };
  reset();

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readJson(req);
    const method = req.method ?? "GET";
    if (url.pathname === "/__reset") return reset(), reply(res, 200, {});
    if (url.pathname === "/stats") return reply(res, 200, { ok: !bugs.has("ledger") });
    log.push({ method, path: url.pathname, body, headers: req.headers });
    res.setHeader("server-timing", `queries;desc=${bugs.has("n+1") ? 9 : 2}, db;dur=3.1`);

    const tenant = req.headers["x-tenant"];
    if (typeof tenant !== "string") return reply(res, 401, { error: "sign in" });
    if (method === "POST" && url.pathname === "/notes") {
      if (typeof body?.text !== "string") return reply(res, 400, { error: "text is required" });
      const note = { id: `note_${String(++counter).padStart(6, "0")}`, tenant, text: body.text, archived: false };
      notes.set(note.id, note);
      return reply(res, 201, { note: { id: note.id, text: note.text } });
    }
    const match = /^\/notes\/([^/]+)(?:\/(comments|archive))?$/.exec(url.pathname);
    const note = match && notes.get(match[1]);
    if (!match || !note || (note.tenant !== tenant && !bugs.has("leak"))) return reply(res, 404, { error: "not found" });
    if (method === "GET" && !match[2]) {
      if (bugs.has("status")) return reply(res, 410, { error: "gone" });
      return reply(res, 200, { note: bugs.has("shape") ? { id: note.id, body: note.text } : { id: note.id, text: note.text } });
    }
    if (method === "POST" && match[2] === "comments") {
      if (body?.noteId !== note.id) return reply(res, 400, { error: "noteId does not match the path" });
      return reply(res, 201, { comment: { id: `cmt_${String(++counter).padStart(6, "0")}`, noteId: note.id } });
    }
    if (method === "POST" && match[2] === "archive") {
      if (note.archived && bugs.has("twice")) return reply(res, 500, { error: "already archived" });
      note.archived = true;
      return reply(res, 200, { note: { id: note.id, archived: true } });
    }
    return reply(res, 404, { error: "no route" });
  });
  return { ...server, bugs, log };
}

/**
 * The collector's read routes over an in-memory list of cases. `requests` records each call; `results` each POST body.
 * @param {import("../../shared/case.mjs").Case[]} cases
 */
export async function startCollector(cases) {
  /** @type {string[]} */
  const requests = [];
  /** @type {any[]} */
  const results = [];
  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return reply(res, 200, { ok: true });
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.headers.authorization !== `Bearer ${READ_TOKEN}`) return reply(res, 401, { error: "bad token" });
    const project = url.searchParams.get("project");
    const mine = cases.filter((item) => item.project === project);
    /** @param {string} session */
    const ofSession = (session) => mine.filter((item) => item.session === session).sort((a, b) => a.seq - b.seq);

    if (req.method === "GET" && url.pathname === "/v1/sessions") {
      if (!project) return reply(res, 400, { error: "project is required" });
      const outcomes = url.searchParams.getAll("outcome");
      const route = url.searchParams.get("route");
      const names = [...new Set(mine.map((item) => item.session))].sort().filter((session) => {
        const own = ofSession(session);
        return (!outcomes.length || own.some((item) => outcomes.includes(item.outcome))) && (!route || own.some((item) => item.request.route === route));
      });
      const sample = Number(url.searchParams.get("sample") ?? 20);
      return reply(res, 200, { sessions: names.slice(0, sample).map((session) => ({ session, cases: ofSession(session) })) });
    }
    const caseMatch = /^\/v1\/cases\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && caseMatch) {
      const found = mine.find((item) => item.id === decodeURIComponent(caseMatch[1]));
      if (!found) return reply(res, 404, { error: "no such case" });
      return reply(res, 200, { session: found.session, cases: ofSession(found.session).filter((item) => item.seq <= found.seq) });
    }
    if (req.method === "POST" && url.pathname === "/v1/results") {
      const body = await readJson(req);
      results.push(body);
      return reply(res, 200, { recorded: body.results.length });
    }
    return reply(res, 404, { error: "no route" });
  });
  return { ...server, requests, results };
}

/**
 * A case as capture would have recorded it from production's JSON answer.
 * @param {{ id: string, session: string, seq: number, method: string, route: string, path: string, body?: unknown, status: number, json: unknown, kind?: string }} spec
 * @returns {import("../../shared/case.mjs").Case}
 */
export function recorded({ id, session, seq, method, route, path, body, status, json, kind = "member" }) {
  return {
    v: 1, id, project: "demo", session, seq, at: new Date(seq).toISOString(), release: "prod1", outcome: status >= 500 ? "error" : "ok",
    actor: { kind }, request: { method, route, path, query: {}, body },
    response: { status, shape: shapeOf(json), ids: idsOf(json, new RegExp(DEFAULT_ID_PATTERN)) }, ttlDays: 14,
  };
}

/** Create a note, read it, comment on it, archive it. Production IDs differ from the ones the toy target makes. */
export function notesSession(session = "s-notes", start = 1000) {
  return [
    recorded({ id: `${session}-1`, session, seq: start + 1, method: "POST", route: "/notes", path: "/notes", body: { text: "hi" }, status: 201, json: { note: { id: "note_prodA1", text: "hi" } } }),
    recorded({ id: `${session}-2`, session, seq: start + 2, method: "GET", route: "/notes/:id", path: "/notes/note_prodA1", status: 200, json: { note: { id: "note_prodA1", text: "hi" } } }),
    recorded({ id: `${session}-3`, session, seq: start + 3, method: "POST", route: "/notes/:id/comments", path: "/notes/note_prodA1/comments", body: { noteId: "note_prodA1", text: "c" }, status: 201, json: { comment: { id: "cmt_prodB2", noteId: "note_prodA1" } } }),
    recorded({ id: `${session}-4`, session, seq: start + 4, method: "POST", route: "/notes/:id/archive", path: "/notes/note_prodA1/archive", status: 200, json: { note: { id: "note_prodA1", archived: true } } }),
  ];
}

/** Reads a note the session did not create. */
export function preexistingSession(noteId = "note_prod99", session = "s-old") {
  return [recorded({ id: `${session}-1`, session, seq: 5000, method: "GET", route: "/notes/:id", path: `/notes/${noteId}`, status: 200, json: { note: { id: noteId, text: "seed" } } })];
}
