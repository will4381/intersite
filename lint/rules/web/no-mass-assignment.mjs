// @ts-check
import { defineRule } from "@oxlint/plugins";

// ORM and query-builder writes: Prisma, Drizzle, Supabase, Mongoose, Sequelize, Knex, TypeORM.
const WRITE = /^(create|createMany|update|updateMany|upsert|insert|insertOne|insertMany|updateOne|replaceOne|findOneAndUpdate|findByIdAndUpdate|values|set|save)$/;

// Keys whose value is the record being written.
const PAYLOAD = /^(data|values|\$set|\$setOnInsert|create|update|doc|document|record|fields|attributes|changes)$/;

/** @param {any} node */
function unwrap(node) {
  while (["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "AwaitExpression"].includes(node?.type)) node = node.type === "AwaitExpression" ? node.argument : node.expression;
  return node;
}

/** `req.body`, `ctx.request.body`, `await request.json()`, `await c.req.json()`. @param {any} node */
function isBodyRead(node) {
  node = unwrap(node);
  if (node?.type === "MemberExpression" && !node.computed && node.property.name === "body") {
    const o = node.object;
    return (o.type === "Identifier" && /^(req|request)$/.test(o.name)) || (o.type === "MemberExpression" && o.property.name === "request");
  }
  if (node?.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.name === "json" && !node.arguments.length) {
    const o = node.callee.object;
    return (o.type === "Identifier" && /^(req|request)$/.test(o.name)) || (o.type === "MemberExpression" && o.property.name === "req");
  }
  return false;
}

/**
 * The request body itself, read here or through a `const body = await request.json()` binding.
 * @param {any} node @param {any} sourceCode
 */
function isRawBody(node, sourceCode) {
  node = unwrap(node);
  if (isBodyRead(node)) return true;
  if (node?.type !== "Identifier") return false;
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (!variable) continue;
    const def = variable.defs[0]?.node;
    return def?.type === "VariableDeclarator" && def.id.type === "Identifier" && isBodyRead(def.init);
  }
  return false;
}

/**
 * A route that validates the body before the handler runs: Fastify's `{ schema: { body } }`, or Express middleware such
 * as `validate(schema)` / `celebrate(...)` listed before the handler.
 * @param {any} node
 */
function validatedRoute(node) {
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
      for (const f of found) if (isRawBody(f, context.sourceCode) && !validatedRoute(call)) context.report({ node: f, messageId: "whole" });
    }
    return {
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
];
