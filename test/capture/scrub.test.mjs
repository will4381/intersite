// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { createScrubber } from "../../capture/scrub.mjs";
import { DEFAULT_ID_PATTERN } from "../../shared/shape.mjs";

const scrubber = createScrubber({ salt: "salt-one", idPattern: DEFAULT_ID_PATTERN, redactKeys: ["favouriteColour"] });

test("replaces personal data, credentials and free text, keeping the form", async () => {
  /** @type {[unknown, RegExp][]} */
  const replaced = [
    ["alice@example.com", /^u[0-9a-f]{8}@example\.test$/],
    ["https://alice.blog/about?x=1", /^https:\/\/example\.test\/[0-9a-f]{8}$/],
    ["+1 (415) 555-0132", /^\+1555\d{7}$/],
    ["415-555-0132", /^\+1555\d{7}$/],
    ["4155550132", /^\d{10}$/],
    ["I live at 12 Baker Street", /^text_[0-9a-f]{8}$/],
    ["Alice", /^text_[0-9a-f]{8}$/],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl", /^text_[0-9a-f]{8}$/],
    ["sk_4eC39HqLyjWDarjtT1zdp7dc", /^text_[0-9a-f]{8}$/],
    ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", /^text_[0-9a-f]{8}$/],
    ["deadbeefcafebabe0123456789abcdef", /^text_[0-9a-f]{8}$/],
    ["deadbeefcafebabe", /^text_[0-9a-f]{8}$/],
    ["jdoe1987", /^text_[0-9a-f]{8}$/],
    ["a".repeat(33), /^text_[0-9a-f]{8}$/],
  ];
  for (const [input, form] of replaced) {
    const out = await scrubber.scrub(input, "note");
    assert.notEqual(out, input, `${input} kept`);
    assert.match(String(out), form, `${input} -> ${out}`);
  }
});

test("keeps IDs, numbers, booleans, ISO dates and code-like enums", async () => {
  const kept = [
    "prog_8fK2abQ9",
    "3f2b8c1e-1111-4222-8333-444455556666",
    42,
    -3.5,
    true,
    false,
    null,
    "2026-11-10",
    "2026-11-10T08:15:00.000Z",
    "2026-11-10T08:15:00+02:00",
    "active",
    "usd",
    "en-us",
    "plan.pro_2",
    "12",
  ];
  for (const value of kept) assert.equal(await scrubber.scrub(value, "status"), value, String(value));
});

test("sensitive keys are always replaced, whatever the value looks like", async () => {
  /** @type {[string, unknown][]} */
  const cases = [
    ["password", "active"],
    ["Password", "hunter2"],
    ["api_key", "usd"],
    ["apiKey", "prog_8fK2abQ9"],
    ["X-Auth-Token", "abc"],
    ["authorization", "Bearer abc"],
    ["cookie", "sid=1"],
    ["card", "visa"],
    ["cvv", 123],
    ["ssn", "078-05-1120"],
    ["email", "x"],
    ["phoneNumber", 4155550132],
    ["first_name", "ann"],
    ["name", "ann"],
    ["username", "ann"],
    ["handle", "ann"],
    ["shipping_address", "x"],
    ["street", "x"],
    ["city", "paris"],
    ["zip", "75001"],
    ["postalCode", "x"],
    ["dateOfBirth", "1990-04-02"],
    ["dob", "1990-04-02"],
    ["ip", "10.0.0.1"],
    ["favourite_colour", "blue"],
  ];
  for (const [key, value] of cases) assert.notEqual(await scrubber.scrub(value, key), value, `${key}: ${value} kept`);

  const dob = await scrubber.scrub("1990-04-02", "dob");
  assert.match(String(dob), /^\d{4}-\d{2}-\d{2}$/);
  const cvv = await scrubber.scrub(123, "cvv");
  assert.equal(typeof cvv, "number");
  assert.ok(Number(cvv) < 1000);

  // Words are matched whole, so these ordinary keys are not sensitive.
  for (const key of ["description", "shipping", "zipped_size", "status", "currency"]) assert.equal(await scrubber.scrub("active", key), "active", key);
});

test("sensitivity is inherited by nested values, but an ID under an id key survives", async () => {
  const out = await scrubber.scrub({ address: { id: "addr_9fK2abQ9", line1: "x", country: "fr" }, card_id: "card_8fK2abQ9", status: "active" });
  assert.deepEqual(Object.keys(/** @type {any} */ (out).address), ["id", "line1", "country"]);
  assert.equal(/** @type {any} */ (out).address.id, "addr_9fK2abQ9");
  assert.notEqual(/** @type {any} */ (out).address.country, "fr");
  assert.equal(/** @type {any} */ (out).card_id, "card_8fK2abQ9");
  assert.equal(/** @type {any} */ (out).status, "active");
});

test("object keys that are not identifiers are replaced", async () => {
  const out = /** @type {Record<string, unknown>} */ (await scrubber.scrub({ "alice@example.com": true, prog_8fK2abQ9: 1, ok: 1 }));
  assert.deepEqual(Object.keys(out).sort(), ["ok", "prog_8fK2abQ9", Object.keys(out).find((key) => key.endsWith("@example.test"))].sort());
});

test("equal inputs give equal fakes; another salt gives different fakes", async () => {
  const other = createScrubber({ salt: "salt-two", idPattern: DEFAULT_ID_PATTERN });
  for (const value of ["alice@example.com", "Free text here", "+1 415 555 0132", "https://a.b/c"]) {
    const first = await scrubber.scrub(value, "x");
    assert.equal(await scrubber.scrub(value, "y"), first);
    assert.notEqual(await other.scrub(value, "x"), first);
  }
  const pin = await scrubber.scrub(99, "pin");
  assert.notEqual(pin, 99);
  assert.equal(await scrubber.scrub(99, "pin"), pin);
});
