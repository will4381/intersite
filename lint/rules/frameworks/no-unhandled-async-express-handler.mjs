// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";
import { dependencyRange, importsModule } from "./syntax.mjs";

const ROUTE = /^(get|post|put|patch|delete|all|use|options|head)$/;

/**
 * Express 4 (or older): a range such as `^4.21.2`, `~4.18`, `4.x`, or no package.json naming express at all. Express 5
 * forwards rejected promises itself.
 * @param {string | undefined} range
 */
const isExpress4 = (range) => range === undefined || /^[\^~>=\s]*[0-4](\.|$|x)/.test(range);

/** An await that can reject, or a throw: not `await new Promise((resolve) => setTimeout(resolve, ms))`. @param {any} n */
const canFail = (n) => n.type === "ThrowStatement" || (n.type === "AwaitExpression" && !(n.argument.type === "NewExpression" && n.argument.callee.name === "Promise"));

/** Whether an `await` or `throw` in `fn` runs outside every try block that has a catch. @param {any} fn */
function awaitsUnguarded(fn) {
  let found = false;
  walk(fn.body, (n) => {
    if (found || (n !== fn.body && (n.type.endsWith("FunctionExpression") || n.type === "FunctionDeclaration"))) return false;
    if (n.type === "TryStatement" && n.handler) {
      // The try block is covered; an await or throw in its catch is not.
      walk(n.handler.body, (m) => {
        if (m.type.endsWith("FunctionExpression")) return false;
        found ||= canFail(m);
      });
      return false;
    }
    found ||= canFail(n);
  });
  return found;
}

export const id = "no-unhandled-async-express-handler";
export const pack = "server";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      unhandled: "Express 4 ignores the promise an async handler returns, so when this await rejects or this code throws, the error middleware never runs, the request hangs until it times out, and Node logs an unhandled rejection. Wrap the body in try/catch and call next(error), wrap the handler (asyncHandler(...)), or upgrade to Express 5, which forwards rejections itself.",
    },
  },
  createOnce(context) {
    return {
      before() {
        const file = context.filename;
        return importsModule(context.sourceCode.ast, /^express$/) && isExpress4(dependencyRange(file, "express")) && !dependencyRange(file, "express-async-errors");
      },
      // `app.get('/x', async (req, res) => …)`, `router.post('/x', auth, async (req, res, next) => …)`
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type !== "MemberExpression" || !ROUTE.test(callee.property.name ?? "")) return;
        if (callee.object.type === "CallExpression" && callee.object.callee.property?.name !== "route") return; // only `app.route('/x').get(...)`
        for (const arg of /** @type {any[]} */ (node.arguments)) {
          if (arg.type.endsWith("FunctionExpression") && arg.async && arg.params.length >= 2 && awaitsUnguarded(arg)) context.report({ node: arg, messageId: "unhandled" });
        }
      },
    };
  },
});

export const bad = [
  "import express from 'express';\nconst app = express();\napp.get('/users/:id', async (req, res) => {\n  res.json(await db.user(req.params.id));\n});",
  "import { Router } from 'express';\nexport const router = Router();\nrouter.post('/orders', requireAuth, async (req, res, next) => {\n  const order = await createOrder(req.body);\n  res.status(201).json(order);\n});",
  "import express from 'express';\nconst app = express();\napp.route('/items').get(async (req, res) => {\n  if (!req.query.q) throw new Error('q required');\n  res.json(await search(req.query.q));\n});",
];

export const good = [
  "import express from 'express';\nconst app = express();\napp.get('/users/:id', async (req, res, next) => {\n  try {\n    res.json(await db.user(req.params.id));\n  } catch (error) {\n    next(error);\n  }\n});",
  "import express from 'express';\nconst app = express();\napp.get('/users/:id', asyncHandler(async (req, res) => {\n  res.json(await db.user(req.params.id));\n}));",
  "import express from 'express';\nconst app = express();\napp.get('/health', async (req, res) => {\n  res.send('ok');\n});",
  "import express from 'express';\nconst app = express();\napp.get('/slow', async (req, res) => {\n  await new Promise((resolve) => setTimeout(resolve, 500));\n  res.send('ok');\n});",
  "import Fastify from 'fastify';\nconst app = Fastify();\napp.get('/users/:id', async (request, reply) => {\n  return db.user(request.params.id);\n});",
];
