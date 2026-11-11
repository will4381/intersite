// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { lintContract, printable } from "../../replay/contract.mjs";
import { DEFAULT_ID_PATTERN, shapeOf } from "../../shared/shape.mjs";
import { SHOP_RESOURCES, recordFrom, replayCli, shopOffenderSpecs, shopResourceSpecs, startCollector, startShop } from "./helpers.mjs";

const adapterFile = fileURLToPath(new URL("./shop-adapter.mjs", import.meta.url));

/** @type {Awaited<ReturnType<typeof startShop>>[]} */
const shops = [];
/** @type {Awaited<ReturnType<typeof startCollector>>[]} */
const collectors = [];
const dirs = { odd: "", clean: "" };

/** A project folder whose collector holds the cases. @param {string} target @param {import("../../shared/case.mjs").Case[]} cases @param {object} [replay] */
async function project(target, cases, replay = {}) {
  const collector = await startCollector(cases);
  collectors.push(collector);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-contract-")));
  writeFileSync(join(dir, "intersite.json"), JSON.stringify({ project: "demo", collector: { url: collector.url }, replay: { target, adapter: relative(dir, adapterFile), ...replay } }));
  return dir;
}

before(async () => {
  const [odd, clean] = await Promise.all([startShop(), startShop({ clean: true })]);
  shops.push(odd, clean);
  dirs.odd = await project(odd.url, await recordFrom(odd.url, [...shopResourceSpecs(), ...shopOffenderSpecs()]));
  dirs.clean = await project(clean.url, await recordFrom(clean.url, shopResourceSpecs()));
});
after(() => Promise.all([...shops, ...collectors].map((server) => server.close())));

/** The FAIL contract lines of a run. @param {string} stdout */
const findings = (stdout) => stdout.split("\n").filter((line) => line.startsWith("FAIL contract "));
/** The command after `rerun: ` on a line, as arguments. @param {string} line */
const rerunArgs = (line) => line.split(" | rerun: intersite replay ")[1].split(" | ")[0].split(" ");

// One finding per implemented check, each naming the route, the pointer, what the rest of the API does and a case.
const EXPECTED = [
  ["GET /v1/legacy-reports/:id", "/data/created_at, /data/display_name are not camelCase; 239 of 247 response fields in this API are camelCase: rename them createdAt, displayName (case s-odd-51)"],
  ["GET /v1/gift-cards/:id", "/data/balance is a string here; 3 of 4 cases of this route have a number: answer one type every time (case s-odd-55)"],
  ["GET /v1/products/:id", "/data/discount is a number here; 1 of 2 cases of this route have a string: answer one type every time (case s-odd-68)"],
  ["POST /v1/line-items", "request /order_id is snake_case; 35 of 36 request fields in this API are camelCase: rename it orderId (case s-odd-80)"],
  ["POST /v1/gift-cards", "request /unitPrice arrives as a string here; 3 of 4 cases of this route have a number: clients disagree; accept one type every time (case s-odd-82)"],
  ["GET /v1/coupons/:id", "/data/id is a number; 44 of 45 routes answer id as a string: answer a string (case s-odd-56)"],
  ["GET /v1/coupons/:id", "/data/expiresAt is a number; 88 of 89 date fields in this API are strings: answer an ISO 8601 string (case s-odd-56)"],
  ["GET /v1/regions/:id", "answers without the top-level data that 49 of 52 routes wrap their answer in: answer { data: … } (case s-odd-57)"],
  ["GET /v1/warehouses", "answers without the top-level data that 49 of 52 routes wrap their answer in: answer { data: … } (case s-odd-60)"],
  ["POST /v1/checkout", "answers without the top-level data that 49 of 52 routes wrap their answer in: answer { data: … } (case s-odd-64)"],
  ["GET /v1/legacy-reports", "returns the whole list with no paging; 15 of 16 list routes page theirs: add the API's paging keys (case s-odd-52)"],
  ["GET /v1/warehouses", "/results holds the rows; 15 of 16 list routes call it data: rename it data (case s-odd-60)"],
  ["GET /v1/regions", "next is the next-page cursor; 14 of 15 list routes call it nextCursor: rename it nextCursor (case s-odd-58)"],
  ["GET /v1/warehouses/:id", "the 404 answer is { message }; 20 of 22 error answers in this API are { error: object }: answer in that form (case s-odd-61)"],
  ["GET /v1/exports/:id", "the 404 answer is HTML; 20 of 22 error answers in this API are { error: object }: answer in that form (case s-odd-62)"],
  ["POST /v1/checkout", "answers 200 with an error in the body: answer a 4xx or 5xx status for a failure (case s-odd-64)"],
  ["GET /v1/stats", "answers JSON labelled content-type: text/plain: send content-type: application/json (case s-odd-66)"],
  ["POST /v1/price-lists", "a create answers 200; 10 of 11 creates in this API answer 201: answer 201 (case s-shop-4)"],
  ["DELETE /v1/line-items/:id", "answers 200 with an empty body; 52 of 53 routes answer with a body: answer 204, or the JSON the caller expects (case s-odd-65)"],
  ["GET /v1/products/:id", "/data/discount is the string \"NaN\": a value was serialised by mistake; answer null or the real value (case s-odd-67)"],
  ["GET /v1/products/:id", "/data/weight carries binary float noise: round it before answering, and send money as integer minor units (case s-odd-67)"],
  ["GET /v1/products/:id", "/data/shippedDate is a date in a locale form: answer an ISO 8601 string (2026-01-31T09:30:00Z) (case s-odd-67)"],
  ["GET /v1/products/:id", "/data/active is the string \"true\": answer a JSON boolean (case s-odd-67)"],
  ["GET /v1/products/:id", "/data/note is null in some answers and missing in others: answer one form when it is empty (case s-odd-67)"],
  ["GET /v1/products/:id", "/data/tags is null in some answers and a list in others: answer one form when it is empty ([]) (case s-odd-67)"],
  ["POST /v1/imports", "the 400 answer carries a stack trace: log it on the server and answer a plain message (case s-odd-63)"],
  ["GET /v1/customers/:id", "answers /data/__v, Mongoose's version key: drop it from the response (select or toJSON) (case s-odd-69)"],
  ["GET /v1/customers/:id", "answers /data/passwordHash, a password, hash or reset secret: never send it; drop it from the response (case s-odd-69)"],
  ["GET /v1/me", "the answer echoes the request's credentials: never send Authorization or cookie values back (case s-odd-70)"],
  ["GET /v1/orders", "/data/*/merchant is the same object in all 5 rows: send it once beside the list, or only its id (case s-odd-71)"],
  ["POST /v1/orders/:id/refunds", "request /orderId names another record than the path's :id: take the ID from the path and drop it from the body (case s-odd-72)"],
  ["GET /v1/search", "a GET arrives with a body, which proxies and caches drop: move it to the query string (case s-odd-78)"],
  ["POST /v1/line-items", "request /orderId, /order_id arrive across cases: clients disagree on the name; accept one (case s-odd-80)"],
  ["GET /internal/flags", "the path has no version prefix; 43 of 44 routes start /v*: move it under /v1 (case s-odd-76)"],
  ["GET /v1/userSettings", "the path segment userSettings is camelCase; 13 of 14 multi-word path segments are kebab-case: rename it user-settings (case s-odd-75)"],
  ["GET /v1/region/:id", "the collection /region is singular, and the API also has /regions; 19 of 20 collections are plural: use /regions (case s-odd-59)"],
  ["GET /v1/get-totals", "the path segment get-totals is a verb; 43 of 44 routes name resources and let the method say the action: use GET on the resource (case s-odd-77)"],
  ["GET /v1/orders/:orderId/notes", "the parameter after /v1/orders is :orderId; 2 other routes there call it :id: use :id (case s-odd-74)"],
];

test("against an inconsistent API, each check reports its finding once per route with the pointer, the API's convention and a case", async () => {
  const run = await replayCli(["--mode", "contract", "--seed", "1"], dirs.odd);
  assert.equal(run.code, 1, run.stderr);
  const lines = findings(run.stdout);
  for (const [route, message] of EXPECTED) {
    const line = lines.find((item) => item.startsWith(`FAIL contract ${route}: ${message} | rerun: intersite replay --id `));
    assert.ok(line, `${route}: ${message}\n${run.stdout}`);
    assert.match(line, /\| rerun: intersite replay --id s-\S+ --seed 1 --mode contract \| to accept: add \{ "route": "[A-Z]+ \S+", "check": "[a-z]+"(?:, "pointer": "\S+")?, "why": "…" \} to replay\.contractIgnore in intersite\.yml$/);
  }
  assert.equal(lines.length, EXPECTED.length, run.stdout);
  assert.equal(run.stdout.split("\n")[0], `replay: 2 sessions; steps: 0 passed, 0 failed, 0 skipped; seed 1; contract: 56 routes, ${EXPECTED.length} findings`);
  assert.ok(!lines.some((line) => /payment-intents|webhooks/.test(line)), "a provider's object passed through, a map keyed by status and a webhook payload are not the API's casing");
});

test("against a consistent API nothing is reported", async () => {
  const run = await replayCli(["--mode", "contract", "--seed", "1"], dirs.clean);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(run.stdout, `ok replay: 1 sessions; steps: 0 passed, 0 failed, 0 skipped; seed 1; contract: ${SHOP_RESOURCES.length * 3} routes, 0 findings\n`);
});

test("with too little evidence for a convention, nothing is reported", () => {
  /** @param {string} route @param {unknown} json */
  const item = (route, json) => ({ caseId: route, method: "GET", route, path: route, actor: "member", body: undefined, status: 200, shape: shapeOf(json) });
  const evidence = [
    item("/v1/orders", { data: [{ orderId: "a", createdAt: "x" }], nextCursor: null }),
    item("/v1/user_profiles/:id", { profile: { created_at: 1, display_name: "x" } }),
    item("/v2/getInvoices", [{ invoiceId: "b" }]),
    item("/v1/notes/:noteId", { note: { id: 1, createdAt: "x" } }),
  ];
  assert.deepEqual(lintContract(evidence, { idPattern: DEFAULT_ID_PATTERN }), []);
});

test("an entry in replay.contractIgnore silences exactly that one finding", async () => {
  const dir = await project(shops[0].url, await recordFrom(shops[0].url, [...shopResourceSpecs(), ...shopOffenderSpecs()]), {
    contractIgnore: [{ route: "GET /v1/products/:id", check: "values", pointer: "/data/weight", why: "weights come from a scale feed we round in the client" }],
  });
  const run = await replayCli(["--mode", "contract", "--seed", "1"], dir);
  assert.equal(run.code, 1, run.stderr);
  const lines = findings(run.stdout);
  assert.equal(lines.length, EXPECTED.length - 1);
  assert.ok(!lines.some((line) => line.includes("/data/weight carries")));
  assert.ok(lines.some((line) => line.includes("/data/shippedDate is a date")), "the route's other findings stay");
});

test("--json prints each finding as data", async () => {
  const run = await replayCli(["--mode", "contract", "--seed", "1", "--json"], dirs.odd);
  assert.equal(run.code, 1, run.stderr);
  const { contract } = JSON.parse(run.stdout);
  assert.equal(contract.length, EXPECTED.length);
  assert.deepEqual(contract.find((/** @type {{ pointer: string }} */ finding) => finding.pointer === "/data/passwordHash"), {
    check: "exposure", method: "GET", route: "/v1/customers/:id", pointer: "/data/passwordHash", caseId: "s-odd-69",
    message: "answers /data/passwordHash, a password, hash or reset secret: never send it; drop it from the response",
  });
});

test("the rerun command reproduces the finding, with only that route's findings", async () => {
  const run = await replayCli(["--mode", "contract", "--seed", "1"], dirs.odd);
  const line = findings(run.stdout).find((item) => item.includes("/data/expiresAt is a number"));
  assert.ok(line, run.stdout);
  const rerun = await replayCli(rerunArgs(line), dirs.odd);
  assert.equal(rerun.code, 1, rerun.stderr);
  const lines = findings(rerun.stdout);
  assert.ok(lines.includes(line), rerun.stdout);
  assert.ok(lines.every((item) => item.startsWith("FAIL contract GET /v1/coupons/:id: ")), rerun.stdout);
});

test("--mode contract with --id and no --seed is a setup error naming what to pass", async () => {
  const run = await replayCli(["--mode", "contract", "--id", "s-odd-56"], dirs.odd);
  assert.equal(run.code, 2);
  assert.equal(run.stderr, "intersite replay: --mode contract with --id needs --seed <n>: the API's conventions come from that run's sample; copy the rerun command from the finding\n");
});

test("with baseline in the same run, each request is sent once and both report", async () => {
  const before = shops[0].hits();
  const contractOnly = await replayCli(["--mode", "contract", "--seed", "1"], dirs.odd);
  // Each run also probes the target once to see that it answers.
  const sent = shops[0].hits() - before - 1;
  const both = await replayCli(["--mode", "baseline", "--mode", "contract", "--seed", "1"], dirs.odd);
  assert.equal(shops[0].hits() - before, 2 * (sent + 1), "baseline reuses the contract pass's answers");
  assert.equal(both.code, 1, both.stderr);
  assert.equal(both.stdout.split("\n")[0], `replay: 2 sessions; steps: ${sent} passed, 0 failed, 0 skipped; seed 1; contract: 56 routes, ${EXPECTED.length} findings`);
  assert.deepEqual(findings(both.stdout), findings(contractOnly.stdout));
});

test("--openapi lints a documented contract with no server and no traffic", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-openapi-")));
  /** @param {Record<string, object>} properties */
  const answer = (properties) => ({ content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties } } } } } });
  const paths = Object.fromEntries(SHOP_RESOURCES.map((resource) => [`/v1/${resource}/{id}`, {
    get: { responses: { 200: answer({ id: { type: "string" }, displayName: { type: "string" }, createdAt: { type: "string", format: "date-time" } }) } },
  }]));
  paths["/v1/legacy-reports/{id}"] = { get: { responses: { 200: answer({ id: { type: "string" }, created_at: { type: "string" } }), default: answer({}) } } };
  writeFileSync(join(dir, "api.json"), JSON.stringify({ openapi: "3.1.0", paths }));
  const run = await replayCli(["--mode", "contract", "--openapi", "api.json"], dir);
  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "replay: openapi api.json; contract: 11 routes, 1 findings",
    "FAIL contract GET /v1/legacy-reports/:id: /data/created_at is snake_case; 20 of 21 response fields in this API are camelCase: rename it createdAt (case GET:/v1/legacy-reports/{id}:200)"
      + ' | rerun: intersite replay --openapi api.json --mode contract | to accept: add { "route": "GET /v1/legacy-reports/:id", "check": "casing", "pointer": "/data/created_at", "why": "…" } to replay.contractIgnore in intersite.yml',
  ]);
  delete paths["/v1/legacy-reports/{id}"];
  writeFileSync(join(dir, "api.json"), JSON.stringify({ openapi: "3.1.0", paths }));
  assert.equal((await replayCli(["--openapi", "api.json"], dir)).stdout, "ok replay: openapi api.json; contract: 10 routes, 0 findings\n");
});

test("a 200 answered in the API's own problem+json error form is a status finding", () => {
  const problem = { type: "https://api.test/problems/invalid", title: "Request failed", status: 422, detail: "x", code: "invalid" };
  /** @param {string} route @param {number} status @param {unknown} json */
  const item = (route, status, json) => ({ caseId: `${route} ${status}`, method: "GET", route, path: route, actor: "member", body: undefined, status, shape: shapeOf(json),
    live: { status, json, text: JSON.stringify(json), contentType: status >= 400 ? "application/problem+json" : "application/json", sent: [] } });
  const evidence = [
    ...["/v1/a", "/v1/b", "/v1/c", "/v1/d", "/v1/e", "/v1/f"].flatMap((route) => [item(route, 200, { id: "x", name: "y" }), item(route, 404, problem)]),
    item("/v1/balance", 200, problem),
    // A record that happens to have a title and a type is not a problem document.
    item("/v1/account", 200, { id: "acct_8fK2abQ9", type: "brand", title: "Acme", status: "active" }),
  ];
  const findings = lintContract(evidence, { idPattern: DEFAULT_ID_PATTERN }).filter((finding) => finding.check === "status");
  assert.deepEqual(findings.map((finding) => `${finding.route}: ${finding.message}`), ["/v1/balance: answers 200 with a problem+json error in the body: answer a 4xx or 5xx status for a failure"]);
});

test("a create answered 202 (queued) is not reported against an API whose creates answer 201", () => {
  /** @param {string} route @param {number} status */
  const item = (route, status) => ({ caseId: route, method: "POST", route, path: route, actor: "member", body: { name: "x" }, status, shape: shapeOf({ id: "x", name: "y" }) });
  const evidence = [...["/v1/orders", "/v1/notes", "/v1/tags", "/v1/files", "/v1/users", "/v1/teams", "/v1/plans", "/v1/posts", "/v1/pages", "/v1/links"].map((route) => item(route, 201)), item("/v1/exports", 202), item("/v1/imports", 200)];
  const findings = lintContract(evidence, { idPattern: DEFAULT_ID_PATTERN }).filter((finding) => finding.check === "status");
  assert.deepEqual(findings.map((finding) => finding.route), ["/v1/imports"]);
});

test("a list whose rows type a field differently within one answer is a union by design; drift between answers is still reported", () => {
  /** @param {string} id @param {unknown} json */
  const item = (id, json) => ({ caseId: id, method: "GET", route: "/v1/fields", path: "/v1/fields", actor: "member", body: undefined, status: 200, shape: shapeOf(json) });
  const union = { data: [{ name: "a", default: true }, { name: "b", default: 3 }] };
  const evidence = [item("c1", union), item("c2", union), item("c3", { data: [{ name: "a", default: true, size: 1 }] }), item("c4", { data: [{ name: "a", default: true, size: "1" }] })];
  const findings = lintContract(evidence, { idPattern: DEFAULT_ID_PATTERN }).filter((finding) => finding.check === "types");
  assert.deepEqual(findings.map((finding) => finding.pointer), ["/data/*/size"]);
});

test("findings of one kind under one object print as one line; --json keeps each with its group; an ignore on the parent silences it", () => {
  const providers = ["tiktok", "meta", "google", "snap"];
  const fields = ["spend", "clicks", "impressions"];
  /** @param {string} caseId @param {(value: number) => unknown} form */
  const campaign = (caseId, form) => ({
    caseId, method: "GET", route: "/v1/campaigns/:id", path: "/v1/campaigns/cmp_8fK2abQ9", actor: "member", body: undefined, status: 200,
    shape: shapeOf({ id: "cmp_8fK2abQ9", name: "x", platformMetrics: Object.fromEntries(providers.map((provider) => [provider, Object.fromEntries(fields.map((field) => [field, form(1)]))])),
      pair: { a: form(1), b: form(1) } }),
  });
  /** @param {string} caseId @param {unknown} total */
  const order = (caseId, total) => ({ caseId, method: "GET", route: "/v1/orders/:id", path: "/v1/orders/ord_8fK2abQ9", actor: "member", body: undefined, status: 200, shape: shapeOf({ id: "ord_8fK2abQ9", total }) });
  const evidence = [campaign("c1", (value) => value), campaign("c2", (value) => value), campaign("c3", String), order("o1", 1), order("o2", "1")];
  const findings = lintContract(evidence, { idPattern: DEFAULT_ID_PATTERN });

  const grouped = findings.filter((finding) => finding.group === "/platformMetrics");
  assert.equal(grouped.length, providers.length * fields.length, "--json keeps every finding, each naming its group");
  assert.deepEqual(findings.filter((finding) => finding.group === undefined).map((finding) => finding.pointer).sort(), ["/pair/a", "/pair/b", "/total"], "two siblings, and another route, stay apart");

  const lines = printable(findings).map((finding) => `${finding.route} ${finding.pointer}: ${finding.message} (case ${finding.caseId})`);
  assert.deepEqual(lines.filter((line) => line.includes("platformMetrics")), [
    "/v1/campaigns/:id /platformMetrics: /platformMetrics: 12 fields under it are typed two ways across answers, for example /platformMetrics/google/clicks (string, number),"
      + " /platformMetrics/google/impressions (string, number), /platformMetrics/google/spend (string, number): answer one type every time (case c3)",
  ]);
  assert.ok(lines.includes("/v1/orders/:id /total: /total is a string here; 1 of 2 cases of this route have a number: answer one type every time (case o2)"), "a lone finding prints as before");
  assert.equal(lines.length, 4);

  const ignore = [{ route: "/v1/campaigns/:id", check: "types", pointer: "/platformMetrics", why: "provider metrics arrive as each provider sends them" }];
  assert.deepEqual(lintContract(evidence, { idPattern: DEFAULT_ID_PATTERN, ignore }).map((finding) => finding.pointer).sort(), ["/pair/a", "/pair/b", "/total"]);
});
