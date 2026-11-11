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
    ["I live at 12 Baker Street", /^text-[0-9a-f]{8}$/],
    ["Alice", /^text-[0-9a-f]{8}$/],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl", /^text-[0-9a-f]{8}$/],
    ["sk_4eC39HqLyjWDarjtT1zdp7dc", /^text-[0-9a-f]{8}$/],
    // oxlint-disable-next-line intersite/no-hardcoded-secret -- a made-up token the scrubber must replace; the fixture is the point
    ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", /^text-[0-9a-f]{8}$/],
    ["deadbeefcafebabe0123456789abcdef", /^text-[0-9a-f]{8}$/],
    ["deadbeefcafebabe", /^text-[0-9a-f]{8}$/],
    ["jdoe1987", /^text-[0-9a-f]{8}$/],
    ["a".repeat(33), /^text-[0-9a-f]{8}$/],
  ];
  for (const [input, form] of replaced) {
    const out = await scrubber.scrub(input, "note");
    assert.notEqual(out, input, `${input} kept`);
    assert.match(String(out), form, `${input} -> ${out}`);
  }
});

test("keeps IDs, numbers and booleans under any key, ISO dates under date keys and code-like enums under structural keys", async () => {
  for (const value of ["prog_8fK2abQ9", "3f2b8c1e-1111-4222-8333-444455556666", 42, -3.5, true, false, null, "12"]) {
    assert.equal(await scrubber.scrub(value, "who"), value, String(value));
  }
  for (const value of ["2026-11-10", "2026-11-10T08:15:00.000Z", "2026-11-10T08:15:00+02:00"]) {
    for (const key of ["createdAt", "dueDate", "starts_on", "expires", "updated"]) assert.equal(await scrubber.scrub(value, key), value, `${key}: ${value}`);
  }
  /** @type {[string, string][]} */
  const codes = [["status", "active"], ["sort", "newest"], ["currency", "usd"], ["locale", "en-us"], ["planCode", "plan.pro_2"], ["user_role", "editor"], ["statuses", "active"], ["categories", "books"], ["phases", "beta"]];
  for (const [key, value] of codes) assert.equal(await scrubber.scrub(value, key), value, `${key}: ${value}`);
  assert.deepEqual(await scrubber.scrub({ kinds: ["a", "b"] }), { kinds: ["a", "b"] }, "array items inherit the array's key");
});

test("a random-looking code under a structural key is replaced; an enum with digits is kept", async () => {
  for (const [key, value] of [["code", "fb25c0"], ["code", "ab12cd3"], ["accessCode", "x9k2m7"]]) assert.notEqual(await scrubber.scrub(value, key), value, `${key}: ${value}`);
  for (const [key, value] of [["format", "h264"], ["format", "mp4"], ["version", "v2"]]) assert.equal(await scrubber.scrub(value, key), value, `${key}: ${value}`);
});

test("a media type, a comma-separated list of codes and a group-by under structural keys are kept", async () => {
  for (const [key, value] of [["contentType", "image/png"], ["content_type", "application/vnd.api+json"], ["group", "creator,platform"], ["statuses", "active,paused"]]) {
    assert.equal(await scrubber.scrub(value, key), value, `${key}: ${value}`);
  }
  for (const [key, value] of [["group", "creator,Maria"], ["contentType", "image/png; name=alice.png"], ["note", "image/png"], ["status", "a,b,fb25c0"]]) {
    assert.notEqual(await scrubber.scrub(value, key), value, `${key}: ${value}`);
  }
});

test("a short word or a date under a key not known to hold one is replaced", async () => {
  /** @type {[string, string, RegExp][]} */
  const cases = [
    ["who", "maria", /^text-[0-9a-f]{8}$/],
    ["ref", "jdoe", /^text-[0-9a-f]{8}$/],
    ["", "maria", /^text-[0-9a-f]{8}$/],
    ["sortBy", "newest", /^text-[0-9a-f]{8}$/],
    ["born", "1990-04-02", /^\d{4}-\d{2}-\d{2}$/],
    ["status", "2026-11-10", /^\d{4}-\d{2}-\d{2}$/],
    ["checkpoint", "2026-11-10T08:15:00.000Z", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/],
  ];
  for (const [key, value, form] of cases) {
    const out = await scrubber.scrub(value, key);
    assert.notEqual(out, value, `${key}: ${value} kept`);
    assert.match(String(out), form, `${key}: ${value} -> ${out}`);
  }
  assert.notDeepEqual(await scrubber.scrub({ people: ["maria"] }), { people: ["maria"] });
});

test("keepKeys keeps a project's own codes and dates; redactKeys and the sensitive list still win", async () => {
  const custom = createScrubber({ salt: "salt-one", idPattern: DEFAULT_ID_PATTERN, keepKeys: ["sortBy", "born", "nickname"], redactKeys: ["sort_by"] });
  const plain = createScrubber({ salt: "salt-one", idPattern: DEFAULT_ID_PATTERN, keepKeys: ["sortBy", "born", "bucket"] });
  assert.equal(await plain.scrub("newest", "sort_by"), "newest");
  assert.equal(await plain.scrub("newest", "listSortBy"), "newest");
  assert.equal(await plain.scrub("1990-04-02", "born"), "1990-04-02");
  assert.equal(await plain.scrub("hot", "bucket"), "hot");
  assert.notEqual(await plain.scrub("Call Alice", "bucket"), "Call Alice", "keepKeys keeps codes, not free text");
  assert.notEqual(await plain.scrub("newest", "sorted"), "newest");
  assert.notEqual(await custom.scrub("newest", "sortBy"), "newest", "redactKeys beats keepKeys");
  assert.notEqual(await custom.scrub("ann", "nickname"), "ann", "the sensitive list beats keepKeys");
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

  // Words are matched whole, so these ordinary keys are not sensitive: a number under them is kept.
  for (const key of ["description", "shipping", "zipped_size", "status", "currency"]) assert.equal(await scrubber.scrub(42, key), 42, key);
  assert.equal(await scrubber.scrub("active", "status"), "active");
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
  for (const value of ["alice@example.com", "Free text here", "+1 415 555 0132", "https://a.b/c", "maria", "1990-04-02"]) {
    const first = await scrubber.scrub(value, "x");
    assert.equal(await scrubber.scrub(value, "y"), first);
    assert.notEqual(await other.scrub(value, "x"), first);
  }
  const pin = await scrubber.scrub(99, "pin");
  assert.notEqual(pin, 99);
  assert.equal(await scrubber.scrub(99, "pin"), pin);
});
