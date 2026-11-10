// @ts-check
import { defineRule } from "@oxlint/plugins";

const EVENT = /^(checkout\.session|customer\.subscription|invoice|payment_intent|charge)\.[a-z_.]+$/;

/** `request.json()`, `req.text()`, `req.body`. @param {any} node */
const readsBody = (node) =>
  node.type === "MemberExpression"
    ? node.object.type === "Identifier" && /^(req|request)$/.test(node.object.name) && node.property.name === "body"
    : node.callee.type === "MemberExpression" && /^(json|text)$/.test(node.callee.property.name) && /^(req|request)$/.test(node.callee.object.name ?? "");

export const id = "no-unverified-stripe-webhook";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      unverified: 'This handles Stripe webhook events read straight from the request without stripe.webhooks.constructEvent, so anyone who finds the URL can post a fake "paid" event. Read the raw body (await request.text()) and pass it with the stripe-signature header and your webhook secret to constructEvent before acting.',
    },
  },
  createOnce(context) {
    /** @type {any[]} */
    let events;
    let body = false;
    let verified = false;
    return {
      before() {
        events = [];
        body = verified = false;
      },
      MemberExpression(node) {
        body ||= readsBody(node);
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type === "MemberExpression" && /^constructEvent(Async)?$/.test(callee.property.name)) verified = true;
        body ||= readsBody(node);
      },
      // `event.type === 'invoice.paid'` or `case 'invoice.paid':`
      Literal(node) {
        const parent = /** @type {any} */ (node.parent);
        if (typeof node.value === "string" && EVENT.test(node.value) && (parent.type === "SwitchCase" || parent.type === "BinaryExpression")) events.push(node);
      },
      "Program:exit"() {
        if (body && !verified) for (const node of events) context.report({ node, messageId: "unverified" });
      },
    };
  },
});

export const bad = [
  "export async function POST(request: Request) {\n  const event = await request.json();\n  if (event.type === 'checkout.session.completed') await markPaid(event.data.object.id);\n  return new Response('ok');\n}",
  "app.post('/stripe', async (req, res) => {\n  switch (req.body.type) { case 'invoice.paid': await extend(req.body.data.object); break; }\n  res.sendStatus(200);\n});",
  "export async function POST(req) {\n  const { type, data } = JSON.parse(await req.text());\n  if (type === 'customer.subscription.deleted') await cancel(data.object.customer);\n  return Response.json({ ok: true });\n}",
];

export const good = [
  "export async function POST(request: Request) {\n  const event = stripe.webhooks.constructEvent(await request.text(), request.headers.get('stripe-signature'), secret);\n  if (event.type === 'checkout.session.completed') await markPaid(event.data.object.id);\n  return new Response('ok');\n}",
  "export async function handleEvent(event: Stripe.Event) {\n  if (event.type === 'invoice.paid') await extend(event.data.object);\n}",
  "const event = await stripe.webhooks.constructEventAsync(await req.text(), sig, secret);\nswitch (event.type) { case 'invoice.paid': await extend(event.data.object); }",
  "export async function POST(request: Request) {\n  const event = await request.json();\n  if (event.type === 'account.membership.invited') await notify(event);\n  return new Response('ok');\n}",
];
