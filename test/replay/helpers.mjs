// @ts-check
// Test doubles for replay: a toy two-tenant target, a fake collector implementing the contract's read routes,
// and cases recorded from a pretend production.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

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
 * "n+1" (each request runs more queries, as reported in its Server-Timing header), "list-leak" (`GET /notes` lists every
 * tenant's notes while reads by ID stay scoped). Other switches: "fresh" (random IDs and a `createdAt` on each note, a
 * `requestId` on each list, as a real server answers), "migration" (note text comes back upper-cased), "reorder" (lists
 * come back newest first). `GET /plans` is a catalogue shared by both tenants.
 */
export async function startTarget() {
  /** @type {Set<string>} */
  const bugs = new Set();
  /** @type {{ method: string, path: string, body: any, headers: import("node:http").IncomingHttpHeaders }[]} */
  const log = [];
  /** @type {Map<string, { id: string, tenant: string, text: string, archived: boolean, createdAt: string }>} */
  let notes = new Map();
  let counter = 0;
  const reset = () => {
    notes = new Map([["note_seed01", { id: "note_seed01", tenant: "a", text: "seed", archived: false, createdAt: new Date().toISOString() }]]);
    counter = 0;
  };
  /** @param {string} prefix */
  // A fresh ID always holds a digit: eight random hex letters with none (1 in 2,600) would not look like an ID at all.
  const nextId = (prefix) => `${prefix}_${bugs.has("fresh") ? `${randomBytes(4).toString("hex")}0` : String(++counter).padStart(6, "0")}`;
  /** @param {{ id: string, text: string, createdAt: string }} note */
  const view = (note) => ({
    id: note.id, text: bugs.has("migration") ? note.text.toUpperCase() : note.text, ...(bugs.has("fresh") && { createdAt: note.createdAt }),
    // An invite-style expiry: now plus a fixed offset, set when answered.
    ...(bugs.has("expiry") && { expiresAt: new Date(Date.now() + (bugs.has("longer-expiry") ? 14 : 7) * 86_400_000).toISOString() }),
  });
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
      const note = { id: nextId("note"), tenant, text: body.text, archived: false, createdAt: new Date().toISOString() };
      notes.set(note.id, note);
      return reply(res, 201, { note: view(note) });
    }
    if (method === "GET" && url.pathname === "/notes") {
      const rows = [...notes.values()].filter((note) => note.tenant === tenant || bugs.has("list-leak")).map(view);
      return reply(res, 200, { notes: bugs.has("reorder") ? rows.reverse() : rows, ...(bugs.has("fresh") && { requestId: nextId("req") }) });
    }
    if (method === "GET" && url.pathname === "/plans") return reply(res, 200, { plans: [{ id: "plan_basic01", name: "Basic" }, { id: "plan_team001", name: "Team" }] });
    const match = /^\/notes\/([^/]+)(?:\/(comments|archive))?$/.exec(url.pathname);
    const note = match && notes.get(match[1]);
    if (!match || !note || (note.tenant !== tenant && !bugs.has("leak"))) return reply(res, 404, { error: "not found" });
    if (method === "GET" && !match[2]) {
      if (bugs.has("status")) return reply(res, 410, { error: "gone" });
      return reply(res, 200, { note: bugs.has("shape") ? { id: note.id, body: note.text } : view(note) });
    }
    if (method === "POST" && match[2] === "comments") {
      if (body?.noteId !== note.id) return reply(res, 400, { error: "noteId does not match the path" });
      return reply(res, 201, { comment: { id: nextId("cmt"), noteId: note.id } });
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

/** Creates two notes, reads the first, lists the notes (with the seeded one), and reads the shared plan catalogue. */
export function listSession(session = "s-list", start = 3000) {
  const createdAt = "2026-01-01T00:00:00.000Z";
  /** @param {number} n */
  const note = (n) => ({ id: `note_prodL${n}`, text: `t${n}`, createdAt });
  return [
    recorded({ session, id: `${session}-1`, seq: start + 1, method: "POST", route: "/notes", path: "/notes", body: { text: "t1" }, status: 201, json: { note: note(1) } }),
    recorded({ session, id: `${session}-2`, seq: start + 2, method: "POST", route: "/notes", path: "/notes", body: { text: "t2" }, status: 201, json: { note: note(2) } }),
    recorded({ session, id: `${session}-3`, seq: start + 3, method: "GET", route: "/notes/:id", path: "/notes/note_prodL1", status: 200, json: { note: note(1) } }),
    recorded({ session, id: `${session}-4`, seq: start + 4, method: "GET", route: "/notes", path: "/notes", status: 200,
      json: { notes: [{ id: "note_prodS1", text: "seed", createdAt }, note(1), note(2)], requestId: "req_prod0001" } }),
    recorded({ session, id: `${session}-5`, seq: start + 5, method: "GET", route: "/plans", path: "/plans", status: 200,
      json: { plans: [{ id: "plan_basic01", name: "Basic" }, { id: "plan_team001", name: "Team" }] } }),
  ];
}

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));

/**
 * Runs the real `intersite replay` CLI in `cwd`. @param {string[]} args @param {string} cwd @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function replayCli(args, cwd, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [bin, "replay", ...args], { cwd, env: { ...process.env, INTERSITE_READ_TOKEN: READ_TOKEN, ...env } }, (error, stdout, stderr) =>
      done({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

/** The shop's ten clean resources: kebab-case, plural, under /v1, answering `{ data }` with camelCase keys. */
export const SHOP_RESOURCES = ["price-lists", "tax-rates", "gift-cards", "line-items", "shipping-zones", "loyalty-points", "credit-notes", "sales-orders", "purchase-orders", "stock-levels"];
const AT = "2026-01-01T00:00:00.000Z";

/** @param {string} id */
const shopRow = (id) => ({ id, displayName: "Row", createdAt: AT, updatedAt: AT, unitPrice: 1250, itemCount: 3 });

/**
 * A stateless shop API. With `clean`, every route keeps the shop's conventions: `{ data }` envelopes, camelCase keys,
 * lists `{ data, nextCursor, total }`, errors `{ error: { code, message } }`, creates 201. Without it, the routes below
 * the resources each break one thing (see the comments), as endpoints written one at a time by different agents do.
 * An ID containing "missing" is not found. `hits()` counts the requests it answered.
 * @param {{ clean?: boolean }} [options]
 */
export async function startShop({ clean = false } = {}) {
  let counter = 0;
  let hits = 0;
  /** @param {string} prefix */
  const newId = (prefix) => `${prefix.replace(/[^a-z]/g, "").slice(0, 8)}_${String(++counter).padStart(6, "0")}`;
  /** @type {Record<string, (id: string, req: import("node:http").IncomingMessage) => [number, unknown, string?]>} */
  const special = {
    "GET /v1/legacy-reports/:id": (id) => [200, { data: { id, display_name: "Report", created_at: AT } }], // snake_case keys
    "GET /v1/legacy-reports": () => [200, { data: [shopRow("legacy_000001"), shopRow("legacy_000002")] }], // no paging
    "GET /v1/payment-intents/:id": (id) => [200, { data: { ...shopRow(id), // a provider's object passed through, and a map keyed by status: no finding
      stripeCharge: { amount_captured: 100, balance_transaction: "txn_1", payment_method: "pm_1" }, statusCounts: { in_progress: 1, not_started: 2, done_ok: 3 } } }],
    "GET /v1/gift-cards/:id": (id) => [200, { data: { ...shopRow(id), balance: !clean && id.endsWith("2") ? "25" : 25 } }], // balance typed two ways
    "GET /v1/coupons/:id": () => [200, { data: { id: 7, displayName: "Coupon", createdAt: AT, expiresAt: 1767225600 } }], // numeric id, epoch date
    "GET /v1/regions/:id": (id) => [200, shopRow(id)], // no envelope
    "GET /v1/regions": () => [200, { data: [shopRow("region_000001")], next: "c_2", total: 1 }], // next, not nextCursor
    "GET /v1/region/:id": (id) => [200, { data: shopRow(id) }], // singular beside /v1/regions
    "GET /v1/warehouses": () => [200, { results: [shopRow("wareh_000001")], nextCursor: "c_2", total: 1 }], // results, not data
    "GET /v1/warehouses/:id": () => [404, { message: "not found" }], // another error form
    "GET /v1/exports/:id": () => [404, "<html><body>Not Found</body></html>", "text/html"], // an HTML error
    "POST /v1/imports": () => [400, { error: { code: "invalid", message: "bad row\n    at parseRow (/app/src/imports.ts:12:5)" } }], // a stack trace
    "POST /v1/checkout": () => [200, { success: false, error: "card declined" }], // a failure answered 200
    "DELETE /v1/line-items/:id": () => [200, "", ""], // an empty 200
    "GET /v1/stats": () => [200, JSON.stringify({ data: { orderCount: 3 } }), "text/plain"], // JSON labelled text/plain
    "GET /v1/products/:id": (id) => [200, { data: id.endsWith("1") // values in disguise, and null beside missing
      ? { id, displayName: "P", createdAt: AT, discount: "NaN", active: "true", weight: 0.30000000000000004, shippedDate: "11/10/2026", note: null, tags: null }
      : { id, displayName: "P", createdAt: AT, discount: 5, active: "false", weight: 1, shippedDate: "11/10/2026", tags: [] } }],
    "GET /v1/customers/:id": (id) => [200, { data: { ...shopRow(id), passwordHash: "x", __v: 0 } }], // things that must not leave the server
    "GET /v1/me": (_id, req) => [200, { data: { id: "user_000001", displayName: "Me", authHeader: req.headers.authorization } }], // echoes the credential
    "GET /v1/orders": () => [200, { data: Array.from({ length: 5 }, (_, n) => ({ ...shopRow(`ord_00000${n + 1}`), // the same merchant in every row
      merchant: { id: "merch_000001", displayName: "Big Merchant Incorporated", createdAt: AT, supportEmail: "help@example.com", address: "1 Long Street" } })), nextCursor: "c_2", total: 5 }],
    "POST /v1/orders/:id/refunds": (id) => [201, { data: { ...shopRow(newId("refund")), orderId: id } }],
    "GET /v1/orders/:id/refunds": () => [200, { data: [shopRow("refund_000009")], nextCursor: "c_2", total: 1 }],
    "GET /v1/orders/:orderId/notes": () => [200, { data: [shopRow("note_000009")], nextCursor: "c_2", total: 1 }], // :orderId beside :id
    "GET /v1/userSettings": () => [200, { data: { themeName: "dark" } }], // camelCase path segment
    "GET /internal/flags": () => [200, { data: { betaCheckout: true } }], // no version prefix
    "GET /v1/get-totals": () => [200, { data: { orderTotal: 5 } }], // a verb in the path
    "GET /v1/search": () => [200, { data: { hitCount: 0 } }],
    "POST /v1/webhooks/stripe": () => [200, { data: { receivedAt: AT } }],
  };
  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readJson(req);
    const method = req.method ?? "GET";
    hits++;
    const segments = url.pathname.split("/");
    const route = segments.map((part) => (/_\d{6}$|_[a-z]+\d$|missing/.test(part) ? ":id" : part)).join("/");
    const handler = special[`${method} ${route}`] ?? special[`${method} ${route.replace(/\/orders\/:id\/notes$/, "/orders/:orderId/notes")}`];
    const resource = SHOP_RESOURCES.includes(segments[2]) || segments[2] === "orders" ? segments[2] : "";
    /** @type {[number, unknown, string?]} */
    let answer = [404, { error: { code: "no_route", message: "no route" } }];
    if (handler && !(resource && clean)) answer = handler(segments[3] ?? "", req);
    else if (resource && route.endsWith(":id") && method === "GET") answer = segments[3].includes("missing") ? [404, { error: { code: "not_found", message: "not found" } }] : [200, { data: shopRow(segments[3]) }];
    else if (resource && method === "GET") answer = [200, { data: [shopRow(`${resource.slice(0, 4)}_000001`), shopRow(`${resource.slice(0, 4)}_000002`)], nextCursor: "c_2", total: 2 }];
    else if (resource && method === "POST") answer = body?.displayName ? [!clean && resource === "price-lists" ? 200 : 201, { data: shopRow(newId(resource)) }] : [400, { error: { code: "invalid", message: "displayName is required" } }];
    const [status, payload, type = "application/json"] = answer;
    res.writeHead(status, type ? { "content-type": type } : {}).end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  return { ...server, hits: () => hits };
}

/**
 * Sends each request to a running server as production would have seen it and records the case, so recorded and
 * replayed answers agree. `body` on a GET is stored but not sent, as capture would see a GET body a client sent.
 * @param {string} url @param {{ session: string, method: string, route: string, path: string, body?: unknown }[]} specs
 */
export async function recordFrom(url, specs) {
  const cases = [];
  for (const [index, spec] of specs.entries()) {
    const send = spec.method !== "GET" && spec.body !== undefined;
    const response = await fetch(url + spec.path, {
      method: spec.method, headers: { authorization: SHOP_TOKEN, ...(send && { "content-type": "application/json" }) }, body: send ? JSON.stringify(spec.body) : undefined,
    });
    const text = await response.text();
    const json = text && /^[[{]/.test(text) ? JSON.parse(text) : undefined;
    cases.push(recorded({ ...spec, id: `${spec.session}-${index + 1}`, seq: 10_000 + index, status: response.status, json }));
  }
  return cases;
}

export const SHOP_TOKEN = "Bearer shop-token-0123456789";

/** Every clean resource listed, read, read when missing, created and created without its name. @param {string} session */
export const shopResourceSpecs = (session = "s-shop") => SHOP_RESOURCES.flatMap((resource) => [
  { session, method: "GET", route: `/v1/${resource}`, path: `/v1/${resource}` },
  { session, method: "GET", route: `/v1/${resource}/:id`, path: `/v1/${resource}/${resource.slice(0, 4).replace("-", "")}_000001` },
  { session, method: "GET", route: `/v1/${resource}/:id`, path: `/v1/${resource}/${resource.slice(0, 4).replace("-", "")}_missing` },
  { session, method: "POST", route: `/v1/${resource}`, path: `/v1/${resource}`, body: { displayName: "New", unitPrice: 100, itemCount: 1 } },
  { session, method: "POST", route: `/v1/${resource}`, path: `/v1/${resource}`, body: { unitPrice: 100 } },
]);

/** The inconsistent routes of the shop, each once (or twice where a check compares cases). @param {string} session */
export const shopOffenderSpecs = (session = "s-odd") => [
  ["GET", "/v1/legacy-reports/:id", "/v1/legacy-reports/legacy_000001"], ["GET", "/v1/legacy-reports", "/v1/legacy-reports"],
  ["GET", "/v1/payment-intents/:id", "/v1/payment-intents/pi_000001"],
  ["GET", "/v1/gift-cards/:id", "/v1/gift-cards/gift_000001"], ["GET", "/v1/gift-cards/:id", "/v1/gift-cards/gift_000002"],
  ["GET", "/v1/coupons/:id", "/v1/coupons/coupon_000001"], ["GET", "/v1/regions/:id", "/v1/regions/region_000001"], ["GET", "/v1/regions", "/v1/regions"],
  ["GET", "/v1/region/:id", "/v1/region/region_000001"], ["GET", "/v1/warehouses", "/v1/warehouses"], ["GET", "/v1/warehouses/:id", "/v1/warehouses/wareh_missing"],
  ["GET", "/v1/exports/:id", "/v1/exports/export_000001"], ["POST", "/v1/imports", "/v1/imports", { rows: 1 }], ["POST", "/v1/checkout", "/v1/checkout", { cartId: "cart_000001" }],
  ["DELETE", "/v1/line-items/:id", "/v1/line-items/line_000001"], ["GET", "/v1/stats", "/v1/stats"],
  ["GET", "/v1/products/:id", "/v1/products/prod_000001"], ["GET", "/v1/products/:id", "/v1/products/prod_000002"],
  ["GET", "/v1/customers/:id", "/v1/customers/cust_000001"], ["GET", "/v1/me", "/v1/me"], ["GET", "/v1/orders", "/v1/orders"],
  ["POST", "/v1/orders/:id/refunds", "/v1/orders/ord_000001/refunds", { orderId: "ord_000099", reasonCode: "damaged" }],
  ["GET", "/v1/orders/:id/refunds", "/v1/orders/ord_000001/refunds"], ["GET", "/v1/orders/:orderId/notes", "/v1/orders/ord_000001/notes"],
  ["GET", "/v1/userSettings", "/v1/userSettings"], ["GET", "/internal/flags", "/internal/flags"], ["GET", "/v1/get-totals", "/v1/get-totals"],
  ["GET", "/v1/search", "/v1/search", { searchText: "x" }],
  ["POST", "/v1/line-items", "/v1/line-items", { displayName: "A", orderId: "ord_000001" }], ["POST", "/v1/line-items", "/v1/line-items", { displayName: "B", order_id: "ord_000001" }],
  ["POST", "/v1/gift-cards", "/v1/gift-cards", { displayName: "A", unitPrice: 50 }], ["POST", "/v1/gift-cards", "/v1/gift-cards", { displayName: "B", unitPrice: "50" }],
  ["POST", "/v1/webhooks/stripe", "/v1/webhooks/stripe", { event_type: "charge.succeeded", created_at: 1 }],
].map(([method, route, path, body]) => ({ session, method: String(method), route: String(route), path: String(path), body }));
