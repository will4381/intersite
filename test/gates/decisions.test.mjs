// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { gates } from "../../cli/gate.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await gates.decisions({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [], protected: [] })).findings.map((f) => f.message);

test("a third file reading the same environment variable or flag is reported; the env module and NODE_ENV are not", async () => {
  const r = repo({
    "src/env.ts": "export const stripeKey = process.env.STRIPE_KEY;\n",
    "src/pay.ts": "export const key = process.env.STRIPE_KEY;\nexport const on = isEnabled('new-checkout');\n",
    "src/refund.ts": "export const key = process.env.STRIPE_KEY;\nexport const on = isEnabled('new-checkout');\nexport const prod = process.env.NODE_ENV === 'production';\n",
  });
  r.write({ "src/webhook.ts": "export const key = process.env.STRIPE_KEY;\nexport const on = isEnabled('new-checkout');\nexport const prod = process.env.NODE_ENV === 'production';\n" });
  assert.deepEqual(await check(r.cwd), [
    "src/webhook.ts:1 the environment variable STRIPE_KEY is read in 3 files (also src/pay.ts:1, src/refund.ts:1): each read can parse it or default it differently: read and validate it once in an env module, and import the value",
    "src/webhook.ts:2 the feature flag \"new-checkout\" is checked in 3 files (also src/pay.ts:2, src/refund.ts:2): turning it off or removing it means finding every copy: decide it once, where the feature starts, and pass the result down",
  ]);
});

test("a dispatch over the same variants repeated in a third file is reported; one variant checked per caller is not", async () => {
  const dispatch = "export function f(e) { if (e.kind === 'refund') return 1; if (e.kind === 'charge') return 2; return e.result.kind === 'duplicate' ? 0 : 3; }\n";
  const r = repo({ "src/a.ts": dispatch, "src/b.ts": dispatch });
  r.write({ "src/c.ts": dispatch });
  assert.deepEqual(await check(r.cwd), [
    "src/c.ts:1 `.kind` is branched on for \"charge\", \"refund\" in the same 3 files (also src/a.ts:1, src/b.ts:1): a new variant has to be added in each of them: keep the per-variant behaviour in one module, a switch over the union with a never default, or a table keyed by the variant",
  ]);
});
