// @ts-check
import { defineRule } from "@oxlint/plugins";

/** Calls that move money out, where a retry without a key pays twice. */
const MONEY_OUT = /^(transfers|payouts|refunds)$/;
/** Calls that charge or bill, which a retried webhook or job repeats. */
const CHARGE = /^(paymentIntents|charges|invoices|invoiceItems|subscriptions|transfers|payouts|refunds)$/;

export const id = "require-stripe-idempotency-key";
export const pack = "payments";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      key: "This Stripe {{resource}}.create has no idempotencyKey, so when the request times out and is retried (or the webhook or job is redelivered) Stripe {{effect}} twice. Pass a key derived from your own record, stable across retries: stripe.{{resource}}.create(params, { idempotencyKey: `refund-${order.id}` }).",
    },
  },
  createOnce(context) {
    let webhook = false;
    return {
      before() {
        // A webhook handler is redelivered until it answers 2xx, so every charge it creates is retried.
        webhook = /constructEvent(Async)?\(/.test(context.sourceCode.text);
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type !== "MemberExpression" || callee.property.name !== "create" || callee.object.type !== "MemberExpression") return;
        const resource = callee.object.property.name ?? "";
        if (!(MONEY_OUT.test(resource) || (webhook && CHARGE.test(resource)))) return;
        if (!/stripe/i.test(context.sourceCode.getText(callee.object.object))) return;
        const options = /** @type {any} */ (node.arguments[1]);
        if (options && (options.type !== "ObjectExpression" || options.properties.some((/** @type {any} */ p) => p.type === "SpreadElement" || p.key?.name === "idempotencyKey"))) return;
        context.report({ node, messageId: "key", data: { resource, effect: MONEY_OUT.test(resource) ? "sends the money" : "charges" } });
      },
    };
  },
});

export const bad = [
  "await stripe.refunds.create({ payment_intent: order.paymentIntentId, amount: order.totalCents });",
  "await getStripe().transfers.create({ amount: payout.cents, currency: 'usd', destination: account.stripeId }, { stripeAccount });",
  "const event = stripe.webhooks.constructEvent(body, sig, secret);\nif (event.type === 'invoice.paid') {\n  await stripe.invoiceItems.create({ customer: event.data.object.customer, amount: 500, currency: 'usd' });\n}",
];

export const good = [
  "await stripe.refunds.create({ payment_intent: order.paymentIntentId, amount: order.totalCents }, { idempotencyKey: `refund-${order.id}` });",
  "await stripe.paymentIntents.create({ amount: cart.totalCents, currency: 'usd' });",
  "await stripe.transfers.create(params, requestOptions);",
  "await db.refunds.create({ data: refund });",
  "await stripe.customers.create({ email });",
];
