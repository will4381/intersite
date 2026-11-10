// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";

/** Express and Fastify methods that send the response. */
const SEND = /^(send|json|jsonp|end|sendStatus|sendFile|redirect|render|download)$/;

/** The response a statement sends on, by name: `res.json(x)`, `res.status(400).json(x)`, `reply.code(400).send(x)`. @param {any} statement @param {Set<string>} names */
function sendsOn(statement, names) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (call?.type !== "CallExpression" || call.callee.type !== "MemberExpression" || !SEND.test(call.callee.property.name ?? "")) return false;
  let base = call.callee.object;
  while (base.type === "CallExpression" && base.callee.type === "MemberExpression") base = base.callee.object;
  return base.type === "Identifier" && names.has(base.name);
}

/** Whether anything in `statements` sends on one of `names` again, outside nested functions. @param {any[]} statements @param {Set<string>} names */
function sendsLater(statements, names) {
  let found = false;
  for (const s of statements) {
    walk(s, (n) => {
      if (found || n.type.endsWith("FunctionExpression") || n.type === "FunctionDeclaration") return false;
      if (sendsOn(n, names)) found = true;
    });
  }
  return found;
}

export const id = "no-response-after-send";
export const pack = "server";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      twice: "This sends the response but does not return, so the handler carries on and sends again further down: Express throws \"Cannot set headers after they are sent\" and Fastify logs \"Reply was already sent\". Write `return {{text}}`.",
    },
  },
  createOnce(context) {
    return {
      // Handlers: `(req, res) => …`, `(request, reply) => …`.
      ":function"(/** @type {any} */ fn) {
        const names = new Set(fn.params.filter((/** @type {any} */ p) => p.type === "Identifier" && /^(res|response|reply)$/.test(p.name)).map((/** @type {any} */ p) => p.name));
        if (!names.size || fn.body.type !== "BlockStatement") return;
        walk(fn.body, (block) => {
          if (block !== fn.body && (block.type.endsWith("FunctionExpression") || block.type === "FunctionDeclaration")) return false;
          if (block.type !== "BlockStatement") return;
          block.body.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
            if (s.type !== "IfStatement" || s.alternate) return;
            const branch = s.consequent.type === "BlockStatement" ? s.consequent.body : [s.consequent];
            const last = branch.at(-1);
            if (sendsOn(last, names) && sendsLater(block.body.slice(i + 1), names)) context.report({ node: last, messageId: "twice", data: { text: context.sourceCode.getText(last.expression).split("\n")[0] } });
          });
        });
      },
    };
  },
});

export const bad = [
  "app.get('/users/:id', async (req, res) => {\n  const user = await findUser(req.params.id);\n  if (!user) {\n    res.status(404).json({ error: 'Not found' });\n  }\n  res.json(user);\n});",
  "router.post('/login', (req, res) => {\n  if (!req.body.email) res.status(400).send('Email required');\n  res.send(login(req.body));\n});",
  "fastify.get('/items/:id', async (request, reply) => {\n  const item = await load(request.params.id);\n  if (!item) {\n    reply.code(404).send({ error: 'missing' });\n  }\n  reply.send(item);\n});",
];

export const good = [
  "app.get('/users/:id', async (req, res) => {\n  const user = await findUser(req.params.id);\n  if (!user) {\n    return res.status(404).json({ error: 'Not found' });\n  }\n  res.json(user);\n});",
  "app.get('/health', (req, res) => {\n  if (draining) res.status(503);\n  res.send('ok');\n});",
  "app.get('/x', (req, res) => {\n  if (cached) res.json(cached);\n  else res.json(compute());\n});",
  "app.get('/stream', (req, res) => {\n  if (req.query.ping) {\n    res.end('pong');\n  }\n  queue.push(() => res.json({ late: true }));\n});",
];
