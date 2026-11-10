// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, isBodyCall, isParamGet, isRequestHolder, isRequestPart, notShipped, receiverName, unwrap, walk } from "../shared.mjs";

const ROUTE_METHOD = /^(get|post|put|patch|delete|del|all|use)$/;
const ROUTER = /^(app|router|server|fastify|api|routes|route|hono|r)$/i;
const EXPORTED_HANDLER = /^(POST|PUT|PATCH|DELETE|action)$/;
// A call that checks: a schema parse, a validator, an assertion, a guard (`isEmail(x)`).
const CHECK = /parse|valid|assert|check|guard|sanitiz|schema|^is[A-Z]|^ensure|^require[A-Z]/i;
const NOT_CHECK = /^(parseInt|parseFloat|JSON|parse(Body|Request|Form)?Data)$/;
// Where unchecked input does harm: database writes and queries, mail and HTTP calls, processes and files.
const SINK = /^(create|createMany|insert|insertOne|insertMany|update|updateOne|updateMany|upsert|save|values|query|execute|raw|find|findOne|findMany|findFirst|findUnique|findById|findByIdAndUpdate|where|delete|deleteOne|deleteMany|destroy|remove|send|sendMail|sendEmail|fetch|exec|execFile|spawn|writeFile|appendFile)$/;
const ANSWER_ROOT = /^(res|reply|response|ctx|c|Response|NextResponse)$/;

/** The identifier a call chain starts from: `res` for `res.status(400).json(x)`. @param {any} n */
function chainRoot(n) {
  while (n.type === "CallExpression" || n.type === "MemberExpression") n = n.type === "CallExpression" ? n.callee : n.object;
  return n.type === "Identifier" ? n.name : "";
}

/** Where request input is read: body, query, a JSON or form body, a URL or form value. Route params alone are left out. @param {any} n */
function isInputRead(n) {
  return isRequestPart(n, isRequestHolder, /^(body|query)$/) || isBodyCall(n) || (isParamGet(n) && receiverName(n) !== "params");
}

/** The names a declarator binds: `x`, or each name in `{ a, b: c, ...rest }`. @param {any} id */
function boundNames(id) {
  if (id.type === "Identifier") return [id.name];
  if (id.type !== "ObjectPattern") return [];
  return id.properties.map((/** @type {any} */ p) => (p.type === "RestElement" ? p.argument : p.value?.type === "AssignmentPattern" ? p.value.left : p.value)?.name).filter(Boolean);
}

/** True when `e` mentions input: a read, or a name bound from input. @param {any} e @param {Set<string>} names */
function mentions(e, names) {
  let found = false;
  walk(e, (n) => {
    if ((n.type === "Identifier" && names.has(n.name)) || isInputRead(n)) found = true;
  });
  return found;
}

/**
 * What a handler does with request input: the first read, whether it checks anything, and whether input reaches a call.
 * @param {any} fn
 */
function inspect(fn) {
  /** @type {any} */
  let read;
  let checked = false;
  let used = false;
  /** @type {Set<string>} */
  const names = new Set();
  walk(fn.body, (n) => {
    if (isInputRead(n)) read ??= n;
    if (n.type === "VariableDeclarator" && n.init && mentions(n.init, names)) for (const name of boundNames(n.id)) names.add(name);
    if (n.type === "UnaryExpression" && n.operator === "typeof") checked = true;
    if (n.type === "CallExpression" && CHECK.test(calleeName(n)) && !NOT_CHECK.test(calleeName(n)) && !NOT_CHECK.test(n.callee.object?.name ?? "")) checked = true;
    // A hand-written check: `if (!email || email.length > 254) return res.status(400)...`; `if (!email)` alone only checks presence.
    if (n.type === "IfStatement" && mentions(n.test, names) && !presenceOnly(n.test) && exits(n.consequent)) checked = true;
    if (n.type === "CallExpression" && isSink(n) && !ANSWER_ROOT.test(chainRoot(n)) && n.arguments.some((/** @type {any} */ a) => mentions(a, names))) used = true;
  });
  return { read, checked, used };
}

/** `!x`, `x == null`, `!a || !b`: a test that a value is there, not that it is valid. @param {any} test */
function presenceOnly(test) {
  test = unwrap(test);
  if (test.type === "LogicalExpression") return presenceOnly(test.left) && presenceOnly(test.right);
  if (test.type === "UnaryExpression" && test.operator === "!") return presenceOnly(test.argument);
  if (test.type === "BinaryExpression" && /^[!=]==?$/.test(test.operator)) return test.right.type === "Literal" && test.right.value === null || test.right.name === "undefined";
  return test.type === "Identifier" || test.type === "MemberExpression";
}

/** A sink call, or D1's `prepare(sql).bind(values)`. @param {any} n */
const isSink = (n) => SINK.test(calleeName(n)) || (calleeName(n) === "bind" && calleeName(n.callee.object) === "prepare");

/** A branch that returns or throws. @param {any} node */
function exits(node) {
  let found = false;
  walk(node, (n) => {
    if (n.type === "ReturnStatement" || n.type === "ThrowStatement") found = true;
  });
  return found;
}

/** The handler functions a route registration call passes inline, when no middleware or schema validates first. @param {any} call */
function routeHandlers(call) {
  const callee = call.callee;
  // Deno.serve(handler), and the std/http or wrapper serve(handler) of edge functions.
  const serve = calleeName(call) === "serve" && (callee.type === "Identifier" || callee.object.name === "Deno");
  if (!serve && callee.type !== "MemberExpression") return [];
  if (!serve && (!ROUTE_METHOD.test(callee.property.name ?? "") || !ROUTER.test(receiverName(call) || callee.object.callee?.object?.name || ""))) return [];
  const args = call.arguments;
  if (args.some((/** @type {any} */ a) => (a.type === "CallExpression" && CHECK.test(calleeName(a))) || (a.type === "ObjectExpression" && a.properties.some((/** @type {any} */ p) => p.key?.name === "schema")))) return [];
  // Middleware passed by name (`requireAuth, validateBody`) may validate; only a named validator is recognisable.
  if (args.some((/** @type {any} */ a) => a.type === "Identifier" && CHECK.test(a.name))) return [];
  return args.filter((/** @type {any} */ a) => a.type.endsWith("FunctionExpression"));
}

export const id = "require-request-validation";
export const pack = "validation";
// ponytail: handlers passed by name (`router.post('/x', createUser)`), class controllers and sinks not in SINK are not inspected; any typeof, guard-named call or non-presence if-test counts as a check.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      unchecked: "This handler passes request input on without checking it. The client controls every field: a string can arrive as an object, an array, or ten megabytes. Parse the input with a schema at the top of the handler (const input = Body.parse(await request.json()) in zod) or in route validation middleware, and use only the parsed value.",
    },
  },
  createOnce(context) {
    /** @param {any} fn */
    function check(fn) {
      if (fn.body?.type !== "BlockStatement") return;
      const { read, checked, used } = inspect(fn);
      if (read && used && !checked) context.report({ node: read, messageId: "unchecked" });
    }
    return {
      before: () => !notShipped(context),
      CallExpression(node) {
        routeHandlers(node).forEach(check);
      },
      // A Workers or Deno module: export default { async fetch(request, env) {...} }
      "ExportDefaultDeclaration > ObjectExpression > Property"(/** @type {any} */ node) {
        if (node.key?.name === "fetch" && node.value.type.endsWith("FunctionExpression")) check(node.value);
      },
      // export async function POST(request) {...}, export const POST = async (request) => {...}
      ExportNamedDeclaration(node) {
        const d = /** @type {any} */ (node.declaration);
        if (d?.type === "FunctionDeclaration" && EXPORTED_HANDLER.test(d.id?.name ?? "")) check(d);
        if (d?.type === "VariableDeclaration") for (const v of d.declarations) if (EXPORTED_HANDLER.test(v.id.name ?? "") && unwrap(v.init)?.type.endsWith("FunctionExpression")) check(unwrap(v.init));
      },
    };
  },
});

export const bad = [
  "app.post('/users', async (req, res) => { const { name, email } = req.body; const user = await db.user.create({ data: { name, email } }); res.json(user); });",
  "export async function POST(request: Request) { const body = await request.json(); await db.invite.create({ data: { email: body.email, teamId: body.teamId } }); return Response.json({ ok: true }); }",
  "router.get('/search', async (req, res) => { const rows = await db.post.findMany({ where: { title: { contains: req.query.q } } }); res.json(rows); });",
  "export const PATCH = async (req: Request) => { const { title } = await req.json(); await db.insert(posts).values({ title }); return new Response(null, { status: 201 }); };",
  "Deno.serve(async (req) => { const { email } = await req.json(); await supabase.from('leads').insert({ email }); return new Response('ok'); });",
  "app.post('/send', async (req, res) => { await mailer.send({ to: req.body.to, html: req.body.html }); res.sendStatus(202); });",
  "app.post('/send', async (req, res) => { const { to, html } = req.body; if (!to) return res.status(400).end(); await transporter.sendMail({ to, html }); res.end(); });",
  "export default { async fetch(request: Request, env: Env) { const { email } = await request.json(); await env.DB.prepare('insert into leads (email) values (?)').bind(email).run(); return new Response('ok'); } };",
];

export const good = [
  "export async function POST(request: Request) { const input = Invite.parse(await request.json()); await sendInvite(input.email, input.teamId); return Response.json({ ok: true }); }",
  "app.post('/users', validate(createUser), async (req, res) => { res.json(await db.user.create({ data: req.body })); });",
  "app.post('/users', { schema: { body: CreateUser } }, async (request) => db.user.create({ data: request.body }));",
  "app.post('/domains', async (req, res) => { const { domain } = req.body; if (!domain || !isDomain(domain)) return res.status(400).json({ error: 'bad domain' }); res.json(await db.domain.create({ data: { domain } })); });",
  "app.post('/notes', async (req, res) => { const result = noteSchema.safeParse(req.body); if (!result.success) return res.status(400).json(result.error.flatten()); res.json(await save(result.data)); });",
  "app.get('/users/:id', async (req, res) => { res.json(await db.user.findUnique({ where: { id: req.params.id } })); });",
  "export const getUser = async (req, res) => { res.json(await userService.update(req.params.id, req.body)); };",
  "app.post('/echo', (req, res) => { req.logger.info('got', { payload: req.body }); res.json({ received: req.body }); });",
  "app.get('/flaky', (req, res) => { const rate = parseInt(req.query.rate || '50'); results.set(Date.now(), rate); res.json({ rate }); });",
  "app.post('/count', async (req, res) => { const { count } = req.body; if (typeof count !== 'number' || count < 1 || count > 10) return res.status(400).end(); res.json(await scale(count)); });",
];
