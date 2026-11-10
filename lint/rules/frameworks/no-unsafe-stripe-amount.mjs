// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isBodyMethod, isRequestName, isRequestPart, resolveVariable, unwrap, walk } from "../shared.mjs";

/** Money fields of Stripe create and update params. */
const AMOUNT = /^(amount|unit_amount|amount_off|application_fee_amount)$/;

/** `req.body`, `request.body`, `await request.json()`, `await c.req.json()`; unlike isBodyCall, `json` may take arguments. @param {any} node */
function isBody(node) {
  node = unwrap(node);
  return isRequestPart(node, isRequestName, /^body$/) || (node?.type === "CallExpression" && isBodyMethod(node.callee, /^json$/));
}

/**
 * Whether `value` comes from the request body: `req.body.amount`, `body.price` after `const body = await request.json()`,
 * or `amount` after `const { amount } = req.body`.
 * @param {any} value @param {any} sourceCode
 */
function fromBody(value, sourceCode) {
  let root = unwrap(value);
  while (root?.type === "MemberExpression") {
    if (isBody(root)) return true;
    root = root.object;
  }
  if (root?.type !== "Identifier") return false;
  const def = resolveVariable(root, sourceCode)?.defs[0]?.node;
  return def?.type === "VariableDeclarator" && isBody(def.init);
}

/** `price * 100` or anything with `.toFixed(` or `parseFloat(` in it, not rounded afterwards. @param {any} value */
function isFloat(value) {
  const v = unwrap(value);
  if (v?.type === "BinaryExpression" && v.operator === "*" && (v.left.value === 100 || v.right.value === 100)) return true;
  let found = false;
  walk(v, (n) => {
    if (n.type === "CallExpression" && /^(toFixed|parseFloat)$/.test(n.callee.property?.name ?? n.callee.name ?? "")) found = true;
  });
  return found && !(v?.type === "CallExpression" && v.callee.object?.name === "Math");
}

export const id = "no-unsafe-stripe-amount";
export const pack = "payments";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      float: "Stripe amounts are integers in the smallest unit, and this one is built with floating point: 19.99 * 100 is 1998.9999999999998, which Stripe rejects or which rounds a cent off. Keep prices in integer cents throughout, or convert once with Math.round(price * 100).",
      client: "This amount comes from the request body, so the client chooses what it pays. Look the price up on the server (your products table, or a Stripe Price ID) from what the client is buying, and charge that.",
    },
  },
  createOnce(context) {
    return {
      Property(node) {
        const key = /** @type {any} */ (node.key);
        if (!AMOUNT.test(key.name ?? key.value ?? "")) return;
        // Inside the params of a Stripe call: `stripe.paymentIntents.create({ amount })`, `getStripe().refunds.create(...)`.
        let call = node.parent;
        while (call && call.type !== "CallExpression") call = call.parent;
        if (!call || !/stripe/i.test(context.sourceCode.getText(call.callee))) return;
        if (isFloat(node.value)) context.report({ node: node.value, messageId: "float" });
        else if (key.name !== "application_fee_amount" && fromBody(node.value, context.sourceCode)) context.report({ node: node.value, messageId: "client" });
      },
    };
  },
});

export const bad = [
  "const intent = await stripe.paymentIntents.create({ amount: price * 100, currency: 'usd' });",
  "await stripe.checkout.sessions.create({ line_items: [{ price_data: { currency: 'usd', unit_amount: Number(total.toFixed(2)) * 100, product_data: { name } }, quantity: 1 }], mode: 'payment' });",
  "app.post('/pay', async (req, res) => {\n  const intent = await stripe.paymentIntents.create({ amount: req.body.amount, currency: 'usd' });\n  res.json({ secret: intent.client_secret });\n});",
  "export async function POST(request: Request) {\n  const { amount } = await request.json();\n  const intent = await getStripe().paymentIntents.create({ amount, currency: 'usd' });\n  return Response.json({ secret: intent.client_secret });\n}",
];

export const good = [
  "const intent = await stripe.paymentIntents.create({ amount: Math.round(price * 100), currency: 'usd' });",
  "export async function POST(request: Request) {\n  const { productId } = await request.json();\n  const product = await getProduct(productId);\n  const intent = await stripe.paymentIntents.create({ amount: product.priceCents, currency: 'usd' });\n  return Response.json({ secret: intent.client_secret });\n}",
  "await stripe.checkout.sessions.create({ line_items: [{ price: priceId, quantity: req.body.quantity }], mode: 'payment' });",
  "const total = { amount: price * 100 };",
  "await stripe.refunds.create({ payment_intent: id, amount: order.totalCents });",
];
