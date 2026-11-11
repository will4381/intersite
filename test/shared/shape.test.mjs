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
  // A row shape the recording had not seen is new data while another row still matches; a change to every row is not.
  const accounts = shapeOf({ accounts: [{ id: "a", managedBy: null }] });
  assert.equal(shapeDiff(accounts, shapeOf({ accounts: [{ id: "a", managedBy: null }, { id: "b" }] })), undefined);
  assert.equal(shapeDiff(accounts, shapeOf({ accounts: [{ id: "b" }, { id: "c" }] })), "/accounts/*/managedBy: missing");
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

test("the default ID pattern takes prefixed IDs and UUIDs, not snake_case words such as enum values and error codes", () => {
  const id = new RegExp(DEFAULT_ID_PATTERN);
  for (const value of ["prog_8fK2abQ9", "acct_xb3JnYW5pemF0aW9u", "ocl_05XaC1fmqreM7mgNnd0BTar", "note_000001", "cus_NffrFeUfNV2Hib", "user_k3j9x2q8", "evt_abcdefghijklmnop", "0b6f5c2e-1d2a-4c3b-9e8f-7a6b5c4d3e2f"]) {
    assert.ok(id.test(value), value);
  }
  for (const value of ["not_started", "in_review", "session_required", "offline_access", "invalid_request", "payment_method"]) assert.ok(!id.test(value), value);
});
