// @ts-check
import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, isBodyCall, isRequestName, isRequestPart, unwrap } from "../shared.mjs";

/** Fields naming whose data this is. */
const OWNER = /^(userId|user_id|ownerId|owner_id|authorId|author_id|createdBy|created_by)$/;

/** Reads of the signed-in user: Better Auth, Auth.js, Supabase, Clerk, Lucia, Passport, SvelteKit, hand-rolled helpers. */
const SESSION = /\bgetSession\(|\bgetServerSession\(|\bauth\(\)|\bgetUser\(|\bcurrentUser\(|\brequire(User|Auth|Session)\(|\b(req|request)\.(user|session|auth)\b|\blocals\.(user|session)\b|\bsession\.user\b/;

/** `req.body`, `req.query`, `request.query`, `await request.json()`, `await c.req.json()`. @param {any} node */
function isClientInput(node) {
  node = unwrap(node);
  return isRequestPart(node, isRequestName, /^(body|query)$/) || isBodyCall(node, /^json$/);
}

export const id = "no-client-user-id";
export const pack = "auth";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      client: "This handler has the signed-in user's session but takes `{{field}}` from the request, so any user can act as or read for another by sending a different id. Use the id from the session (session.user.id). If an admin acts on someone else, check that permission first and name the field targetUserId.",
    },
  },
  createOnce(context) {
    /** @param {any} node @param {string} field */
    function check(node, field) {
      const fn = enclosingFunction(node);
      if (fn && SESSION.test(context.sourceCode.getText(fn))) context.report({ node, messageId: "client", data: { field } });
    }
    return {
      // `req.body.userId`, `(await request.json()).userId`
      MemberExpression(node) {
        const property = /** @type {any} */ (node.property);
        if (!node.computed && OWNER.test(property.name) && isClientInput(node.object)) check(node, property.name);
      },
      // `const { userId } = req.body`
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !isClientInput(node.init)) return;
        for (const p of /** @type {any[]} */ (node.id.properties)) if (p.type === "Property" && OWNER.test(p.key?.name ?? "")) check(p, p.key.name);
      },
    };
  },
});

export const bad = [
  "app.post('/posts', requireAuth, async (req, res) => {\n  const me = req.user;\n  await db.insert(posts).values({ title: req.body.title, authorId: req.body.userId });\n  res.json({ ok: true, me: me.id });\n});",
  "export async function POST(request: Request) {\n  const session = await auth.api.getSession({ headers: request.headers });\n  if (!session) return new Response(null, { status: 401 });\n  const { userId, plan } = await request.json();\n  await setPlan(userId, plan);\n  return Response.json({ ok: true });\n}",
  "fastify.get('/orders', async (request) => {\n  if (!request.user) throw new Error('unauthorized');\n  return prisma.order.findMany({ where: { userId: request.query.userId } });\n});",
];

export const good = [
  "export async function POST(request: Request) {\n  const session = await auth.api.getSession({ headers: request.headers });\n  if (!session) return new Response(null, { status: 401 });\n  const { plan } = await request.json();\n  await setPlan(session.user.id, plan);\n  return Response.json({ ok: true });\n}",
  "app.post('/internal/events', verifySignature, async (req, res) => {\n  await track(req.body.userId, req.body.event);\n  res.end();\n});",
  "app.post('/admin/users/:id/ban', requireAdmin, async (req, res) => {\n  await ban(req.params.id);\n  res.end();\n});",
  "app.post('/invites', requireAuth, async (req, res) => {\n  await invite({ inviterId: req.user.id, targetUserId: req.body.targetUserId });\n  res.end();\n});",
];
