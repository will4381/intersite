// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_TREE } from "../../gates/lib.mjs";
import { valueDrift } from "../../gates/value-drift.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd @param {string} [base] */
const check = async (cwd, base = "base") => (await valueDrift({ cwd, base, testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [] })).findings.map((f) => f.message);

const policy = "export const PRICING = {\n  paymentFeeBps: 150,\n  paymentFeeFixedCents: 30,\n} as const;\n";
const pricingPage = 'export const Pricing = () => <p>The payment fee is 1.5% plus 30¢ per payment.</p>;\n';
const schema = 'export const fee = describe("The payment fee, in cents: 1.5% + $0.30 per payment.");\n';

test("copy that states a fee the constant no longer holds is reported, whichever side changed", async () => {
  const r = repo({ "src/pricing.ts": policy, "src/ui/pricing-page.tsx": pricingPage, "src/api/schema.ts": schema });
  r.write({ "src/pricing.ts": policy.replace("150", "125") });
  assert.deepEqual(await check(r.cwd), [
    'src/api/schema.ts:1 says 1.5% ("The payment fee, in cents: 1.5% + $0.30 per payment.") but PRICING.paymentFeeBps is 1.25% at src/pricing.ts:2: read the number from the constant, or fix whichever is wrong',
    'src/ui/pricing-page.tsx:1 says 1.5% ("The payment fee is 1.5% plus 30¢ per payment.") but PRICING.paymentFeeBps is 1.25% at src/pricing.ts:2: read the number from the constant, or fix whichever is wrong',
  ]);
  const s = repo({ "src/pricing.ts": policy, "src/ui/pricing-page.tsx": pricingPage });
  s.write({ "src/ui/pricing-page.tsx": pricingPage.replace("30¢", "25¢") });
  assert.deepEqual(await check(s.cwd), ['src/ui/pricing-page.tsx:1 says 25¢ ("The payment fee is 1.5% plus 25¢ per payment.") but PRICING.paymentFeeFixedCents is $0.30 at src/pricing.ts:3: read the number from the constant, or fix whichever is wrong']);
});

test("copy that agrees, input bounds, worked examples and unrelated percentages are not drift", async () => {
  const r = repo({ "src/pricing.ts": policy });
  r.write({
    "src/ui/pricing-page.tsx": pricingPage,
    "src/ui/fee-form.tsx": 'export const hint = "The payment fee must be between 0% and 100%.";\nexport const example = "For example, a payment fee of 3% on $50 is $1.50.";\n',
    "src/ui/discount.tsx": 'export const sale = "Save 20% on your first order.";\n',
  });
  assert.deepEqual(await check(r.cwd), []);
});

test("one money rate set to two values in two files is reported on the changed one", async () => {
  const r = repo({ "src/pricing.ts": policy });
  r.write({ "src/checkout/fees.ts": "export const PAYMENT_FEE_BPS = 175;\n" });
  assert.deepEqual(await check(r.cwd), ["src/checkout/fees.ts:1 sets PAYMENT_FEE_BPS to 1.75% but src/pricing.ts:2 sets PRICING.paymentFeeBps to 1.5%: keep one constant and import it"]);
});

test("in a monorepo, an app's copy is checked against a shared package, and the whole repository with --all", async () => {
  const r = repo({ "packages/shared/pricing.ts": policy, "apps/web/src/page.tsx": pricingPage }, {}, { at: "apps/web" });
  r.write({ "packages/shared/pricing.ts": policy.replace("150", "200") });
  r.commit("raise the fee");
  assert.deepEqual(await check(r.cwd, EMPTY_TREE), ['src/page.tsx:1 says 1.5% ("The payment fee is 1.5% plus 30¢ per payment.") but PRICING.paymentFeeBps is 2% at ../../packages/shared/pricing.ts:2: read the number from the constant, or fix whichever is wrong']);
});
