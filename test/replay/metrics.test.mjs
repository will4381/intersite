// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareMetrics, countersOf } from "../../replay/metrics.mjs";

test("counters come from Server-Timing entries whose desc is a number, quoted or not; dur-only entries are ignored", () => {
  assert.deepEqual(countersOf('queries;desc=7, cache_misses;desc="2";dur=4.5, db;dur=12.3, cdn-cache;desc=HIT, total;desc="1.5"'), { queries: 7, cache_misses: 2, total: 1.5 });
  assert.deepEqual(countersOf("db;dur=12"), {});
  assert.deepEqual(countersOf(null), {});
});

test("a counter higher than in the base run is a finding; lower, equal or missing on either side is not", () => {
  const base = { a: { queries: 7, cache_misses: 2 }, b: { queries: 4 }, c: { queries: 3 }, gone: { queries: 1 } };
  const now = { a: { queries: 19, cache_misses: 5 }, b: { queries: 4, extra: 50 }, c: { queries: 1 }, fresh: { queries: 99 } };
  assert.deepEqual(compareMetrics(base, now), [{ caseId: "a", reason: "queries 7 → 19, cache_misses 2 → 5" }]);
  assert.deepEqual(compareMetrics(now, now), []);
});
