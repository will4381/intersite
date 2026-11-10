// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { caseProblem } from "../../shared/case.mjs";
import { DEFAULT_ID_PATTERN, idsOf, shapeDiff, shapeOf } from "../../shared/shape.mjs";

test("shape keeps keys and types, drops values", () => {
  assert.deepEqual(shapeOf({ b: 1, a: "x", c: [{ id: "1" }, { id: "2" }], d: null }), {
    a: "string",
    b: "number",
    c: [{ id: "string" }],
    d: "null",
  });
});

test("shapeDiff ignores data-dependent nulls and empty arrays, reports real changes", () => {
  const recorded = shapeOf({ name: "a", tags: ["x"], owner: null, items: [{ id: "1", price: 5 }] });
  assert.equal(shapeDiff(recorded, shapeOf({ name: "b", tags: [], owner: { id: "u" }, items: [{ id: "2", price: 9 }] })), undefined);
  assert.equal(shapeDiff(recorded, shapeOf({ name: 1, tags: [], owner: null, items: [] })), "/name: recorded string, got number");
  assert.equal(shapeDiff(recorded, shapeOf({ tags: [], owner: null, items: [] })), "/name: missing");
  assert.equal(shapeDiff(recorded, shapeOf({ name: "a", tags: [], owner: null, items: [{ id: "1", price: "5" }] })), "/items/*/price: recorded number, got string");
});

test("idsOf finds prefixed IDs and UUIDs by pointer", () => {
  const pattern = new RegExp(DEFAULT_ID_PATTERN);
  assert.deepEqual(idsOf({ id: "prog_8fK2abQ9", name: "hello_world", rows: [{ ref: "3f2b8c1e-1111-4222-8333-444455556666" }] }, pattern), {
    "/id": "prog_8fK2abQ9",
    "/rows/0/ref": "3f2b8c1e-1111-4222-8333-444455556666",
  });
});

test("caseProblem accepts a full case and names what is wrong with a broken one", () => {
  const good = {
    v: 1, id: "req_1", project: "demo", session: "s1", seq: 1, at: "2026-11-10T00:00:00.000Z", release: "abc", outcome: "ok",
    actor: { kind: "creator" },
    request: { method: "GET", route: "/v1/things/:id", path: "/v1/things/thing_abc12345", query: {}, body: null },
    response: { status: 200, shape: { id: "string" }, ids: { "/id": "thing_abc12345" } },
    ttlDays: 14,
  };
  assert.equal(caseProblem(good), undefined);
  assert.equal(caseProblem({ ...good, outcome: "fine" }), "outcome is not one of ok, warn, rejected, error");
  assert.equal(caseProblem({ ...good, ttlDays: 9999 }), "ttlDays must be 1 to 365");
});
