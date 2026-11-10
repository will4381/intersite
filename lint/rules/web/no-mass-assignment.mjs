// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, enclosingFunction, isBodyCall, isRequestHolder, isRequestPart, mentions, resolveVariable, unwrap } from "../shared.mjs";

/** What a file must spell for this rule to have anything to report (see `mentions`). */
const NEEDS = /body|json|fromEntries/;

// ORM and query-builder writes: Prisma, Drizzle, Supabase, Mongoose, Sequelize, Knex, TypeORM.
const WRITE = /^(create|createMany|update|updateMany|upsert|insert|insertOne|insertMany|updateOne|replaceOne|findOneAndUpdate|findByIdAndUpdate|values|set|save)$/;

// Keys whose value is the record being written.
const PAYLOAD = /^(data|values|\$set|\$setOnInsert|create|update|doc|document|record|fields|attributes|changes)$/;

/** `await` and casts, but not `?.` chains: what this rule looks through. */
const WRAPPERS = new Set(["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "AwaitExpression"]);

/** `req.body`, `ctx.request.body`, `await request.json()`, `await c.req.json()`. @param {any} node */
function isBodyRead(node) {
  node = unwrap(node, WRAPPERS);
  // A server action's form, copied whole: Object.fromEntries(formData).
  if (calleeName(node) === "fromEntries" && /form/i.test(node.arguments[0]?.name ?? "")) return true;
  return isRequestPart(node, isRequestHolder, /^body$/) || isBodyCall(node, /^json$/);
}

/**
 * The request body itself, read here or through a `const body = await request.json()` binding.
 * @param {any} node @param {any} sourceCode
 */
function isRawBody(node, sourceCode) {
  node = unwrap(node, WRAPPERS);
  if (isBodyRead(node)) return true;
  if (node?.type !== "Identifier") return false;
  const def = resolveVariable(node, sourceCode)?.defs[0]?.node;
  if (def?.type !== "VariableDeclarator" || !isBodyRead(def.init)) return false;
  // `const body = req.body`, or the rest of it: `const { role, ...rest } = req.body` still carries every other field.
  return def.id.type === "Identifier" || (def.id.type === "ObjectPattern" && def.id.properties.some((/** @type {any} */ p) => p.type === "RestElement" && p.argument === resolveVariable(node, sourceCode).identifiers[0]));
}

/**
 * A route that validates the body before the handler runs: Fastify's `{ schema: { body } }`, or Express middleware such
 * as `validate(schema)` / `celebrate(...)` listed before the handler. Stricter than the shared validatedRoute: the schema
 * must cover `body`, since only the body is checked here.
 * @param {any} node
 */
function bodyValidatedRoute(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type !== "CallExpression") continue;
    for (const arg of n.arguments) {
      if (arg.type === "ObjectExpression" && arg.properties.some((/** @type {any} */ p) => p.key?.name === "schema" && p.value.type === "ObjectExpression" && p.value.properties.some((/** @type {any} */ q) => q.key?.name === "body"))) return true;
      if (arg.type === "CallExpression" && /valid|schema|celebrate|zod|joi|body/i.test(arg.callee.name ?? arg.callee.property?.name ?? "")) return true;
    }
  }
  return false;
}

export const id = "no-mass-assignment";
export const pack = "security";
// ponytail: a body copied into another variable first (`const input = { ...req.body }`), passed to a service helper, or written by a repository method not in WRITE is not reported.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      whole: "The whole request body goes into this write, so a client can set any field it likes (role, isAdmin, ownerId, price). Parse it with a schema that lists the accepted fields (zod's parse drops the rest) and write the parsed value, or pick the fields by name.",
    },
  },
  createOnce(context) {
    /**
     * An object literal's spreads, and its values under the keys ORMs read a write from (Prisma's `data`, Mongo's `$set`):
     * an SDK call such as `client.events.create({ body })` sends the body on rather than storing it.
     * @param {any} node
     */
    const members = (node) => node.type !== "ObjectExpression" ? [] : node.properties
      .filter((/** @type {any} */ p) => p.type === "SpreadElement" || PAYLOAD.test(p.key?.name ?? p.key?.value ?? ""))
      .map((/** @type {any} */ p) => p.type === "SpreadElement" ? p.argument : p.value);
    /**
     * Reports the body passed as `value`, as a property of it (`{ data: body }`), or spread into either.
     * @param {any} value @param {any} call
     */
    function check(value, call) {
      const found = [value, ...members(value), ...members(value).flatMap(members)];
      for (const f of found) if (isRawBody(f, context.sourceCode) && !bodyValidatedRoute(call)) context.report({ node: f, messageId: "whole" });
    }
    return {
      before: () => mentions(context, NEEDS),
      // Mongoose: `const user = new User(req.body); await user.save();`
      NewExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        const parent = /** @type {any} */ (node).parent;
        if (callee.type !== "Identifier" || !/^[A-Z]/.test(callee.name) || !node.arguments[0] || parent.type !== "VariableDeclarator" || parent.id.type !== "Identifier") return;
        const scope = enclosingFunction(node);
        if (scope && context.sourceCode.getText(scope).includes(`${parent.id.name}.save(`)) check(node.arguments[0], node);
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const method = callee.property.name;
        if (callee.object.type === "Identifier" && callee.object.name === "Object") {
          // `Object.assign(record, req.body)` writes into a record; `Object.assign({}, req.body)` only copies.
          const target = /** @type {any} */ (node.arguments[0]);
          if (method === "assign" && !(target?.type === "ObjectExpression" && !target.properties.length)) node.arguments.slice(1).forEach((arg) => check(arg, node));
          return;
        }
        if (!WRITE.test(method)) return;
        // `createHmac('sha256', secret).update(req.body)` is checking a webhook signature, not writing.
        const receiver = callee.object.type === "CallExpression" ? callee.object.callee : callee.object;
        if (/hash|hmac|sign|verif|cipher|digest/i.test(receiver.name ?? receiver.property?.name ?? "")) return;
        // `map.set(key, value)` and `params.set(name, value)` take two arguments; Drizzle's `.set(values)` takes one.
        if ((method === "set" || method === "values" || method === "save") && node.arguments.length !== 1) return;
        for (const arg of node.arguments) check(arg, node);
      },
    };
  },
});

export const bad = [
  "app.post('/users', async (req, res) => { res.json(await User.create(req.body)); });",
  "export async function POST(request: Request) { const body = await request.json(); await supabase.from('profiles').insert(body); }",
  "app.put('/users/:id', async (req, res) => { await prisma.user.update({ where: { id: req.params.id }, data: req.body }); });",
  "router.patch('/me', async (req, res) => { await db.update(users).set({ ...req.body, updatedAt: new Date() }).where(eq(users.id, req.user.id)); });",
  "app.put('/posts/:id', async (req, res) => { Object.assign(post, req.body); await post.save(); });",
  "app.post('/orders', async (req, res) => { await prisma.order.create({ data: { ...req.body, userId: req.user.id } }); });",
  "export const POST = async (req: Request) => { const data = (await req.json()) as Profile; await db.insert(profiles).values(data); };",
  "app.post('/users', async (req, res) => { const { role, ...data } = req.body; await prisma.user.create({ data }); res.end(); });",
  "app.post('/u', async (req, res) => { const user = new User(req.body); await user.save(); res.end(); });",
  "export async function updateProfile(formData: FormData) { 'use server'; await db.update(profiles).set(Object.fromEntries(formData)).where(eq(profiles.id, id)); }",
  "app.patch('/u/:id', async (req, res) => { await User.updateOne({ _id: req.params.id }, { $set: req.body }); res.end(); });",
];

export const good = [
  "export async function POST(request: Request) { const body = Profile.parse(await request.json()); await supabase.from('profiles').insert(body); }",
  "app.post('/users', async (req, res) => { const { name, email } = req.body; res.json(await User.create({ name, email })); });",
  "app.post('/users', validate(createUser), async (req, res) => { res.json(await User.create(req.body)); });",
  "app.post('/users', { schema: { body: CreateUser } }, async (request) => prisma.user.create({ data: request.body }));",
  "app.post('/cache', (req, res) => { cache.set(req.body.key, req.body.value); res.end(); });",
  "app.put('/users/:id', async (req, res) => { await prisma.user.update({ where: { id: req.params.id }, data: { name: req.body.name } }); });",
  "const totals = Object.values(req.body);",
  "app.post('/hook', (req, res) => { const sig = crypto.createHmac('sha256', secret).update(req.body).digest('hex'); res.end(sig); });",
  "export const POST = async ({ request }) => { const { data } = await lucra.events.create({ path: { id }, body: await request.json() }); return Response.json(data); };",
  "app.post('/log', async (req, res) => { await audit.create({ data: { payload: req.body, at: new Date() } }); res.end(); });",
  "app.post('/u', async (req, res) => { const err = new HttpError(req.body); res.status(400).json(err); });",
];
