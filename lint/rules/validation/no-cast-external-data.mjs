// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, enclosingFunction, isEnvRead, isParamGet, isRequestInput, isRequestPart, isStorageRead, notShipped, receiverName, unwrap, validatedRoute } from "../shared.mjs";

// Types that claim nothing about the shape: the honest result of reading outside data.
const HONEST = /^(unknown|any|const|JsonValue|JSONValue|Json|JsonObject)$/;
const SCHEMA_LIB = /^(z|v|t|Type|Joi|yup|s)$/;

/** Sources the compiler types as any, so an annotation alone is an unchecked claim. */
const UNTYPED = new Set(["JSON.parse", "a JSON body", "the request", "a message"]);

/** What kind of outside data a node is, or "" when it is not: parsed text, a response body, a request, storage, env. @param {any} node */
function sourceKind(node) {
  node = unwrap(node);
  if (node?.type === "CallExpression") {
    const name = calleeName(node);
    // JSON.parse(JSON.stringify(x)) is a deep copy of data the program already typed.
    if (name === "parse" && node.callee.object?.name === "JSON") return calleeName(unwrap(node.arguments[0])) === "stringify" ? "" : "JSON.parse";
    // z.json() and v.json() build a schema; any other no-argument .json() reads a body.
    if (name === "json" && !node.arguments.length && node.callee.type === "MemberExpression" && !SCHEMA_LIB.test(node.callee.object.name ?? "")) return "a JSON body";
    if (isStorageRead(node)) return "storage";
    if (isParamGet(node)) return "a URL or form value";
  }
  // A route schema has checked the request already.
  if (isRequestInput(node) && !validatedRoute(node)) return "the request";
  if (node?.type === "MemberExpression" && !node.computed && node.property.name === "data" && /^(e|ev|evt|event|message|msg)$/.test(node.object.name ?? "")) return "a message";
  if (isEnvRead(node)) return "the environment";
  return "";
}

/** The source kind of a node or of the `const` it names. @param {any} node @param {any} sourceCode */
function kindOf(node, sourceCode) {
  const direct = sourceKind(node);
  if (direct) return direct;
  const alias = unwrap(node);
  const init = constInit(alias, sourceCode);
  return init && !checkedByHand(alias, sourceCode) ? sourceKind(init) : "";
}

/**
 * An alias declared `unknown`, or tested with typeof, `in` or Array.isArray: the cast after such a check narrows
 * what the code has looked at.
 * @param {any} alias @param {any} sourceCode
 */
function checkedByHand(alias, sourceCode) {
  const variable = sourceCode.getScope(alias).references.find((/** @type {any} */ r) => r.identifier === alias)?.resolved;
  if (!variable) return false;
  if (variable.defs[0]?.node.id.typeAnnotation) return true;
  return variable.references.some((/** @type {any} */ r) => {
    const p = r.identifier.parent;
    return (p.type === "UnaryExpression" && p.operator === "typeof") || (p.type === "BinaryExpression" && p.operator === "in" && p.right === r.identifier)
      || (p.type === "CallExpression" && p.callee.property?.name === "isArray");
  });
}

/** The type name an annotation or cast claims, unwrapping Promise<T>; "" for types that claim nothing. @param {any} type */
function claimed(type) {
  if (!type) return "";
  const args = type.typeArguments?.params ?? type.typeParameters?.params ?? [];
  if (type.type === "TSTypeReference" && type.typeName.name === "Promise") return claimed(args[0]);
  // Record<string, unknown> claims only that it is an object.
  if (type.type === "TSTypeReference" && type.typeName.name === "Record" && args[1]?.type === "TSUnknownKeyword") return "";
  // { id?: unknown } names the fields the code goes on to check.
  if (type.type === "TSTypeLiteral" && type.members.every((/** @type {any} */ m) => m.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword")) return "";
  const name = type.type === "TSTypeReference" ? type.typeName.name ?? type.typeName.right?.name : type.type.replace(/^TS|Keyword$/g, "").toLowerCase();
  return HONEST.test(name ?? "") ? "" : name ?? "type";
}

/** A function's declared return type when its returns would carry outside data through it. @param {any} fn */
const returnType = (fn) => fn?.returnType?.typeAnnotation;

export const id = "no-cast-external-data";
export const pack = "types";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      cast: "Data from {{source}} has no type until something checks it, and a cast is a claim, not a check: when the shape differs, the error surfaces far from here. Parse it with a schema (Schema.parse(value) in zod, v.parse in valibot) or a type guard that checks each field, and type the raw value as unknown.",
      env: "This casts an environment variable that may be missing. Read the environment once in a config module that validates it at startup (zod, envalid, t3-env) and import the typed value, or check it here and throw a clear error when it is absent.",
    },
  },
  createOnce(context) {
    /**
     * Reports outside data given a type by `type`. An annotation or return type only lies for sources typed any
     * (storage, URL values and env are typed string | null, which the compiler checks).
     * @param {any} node @param {any} value @param {any} type @param {boolean} [annotation]
     */
    function check(node, value, type, annotation = false) {
      if (!claimed(type)) return;
      // `req.body as string` reads a raw-body parser's output (a webhook signature check), not a parsed shape.
      if (/^TS(String|Unknown)Keyword$|Buffer/.test(type.type === "TSTypeReference" ? type.typeName.name : type.type) && isRequestPart(unwrap(value))) return;
      const source = kindOf(value, context.sourceCode);
      if (annotation && !UNTYPED.has(source)) return;
      if (source) context.report({ node, messageId: source === "the environment" ? "env" : "cast", data: { source } });
    }
    return {
      before: () => !notShipped(context),
      TSAsExpression(node) {
        check(node, node.expression, node.typeAnnotation);
      },
      TSTypeAssertion(node) {
        check(node, node.expression, node.typeAnnotation);
      },
      // `JSON.parse(raw) satisfies Config`: any satisfies every type, so nothing is checked.
      TSSatisfiesExpression(node) {
        check(node, node.expression, node.typeAnnotation, true);
      },
      // A cast written as a type argument: `res.json<User>()`, `axios.get<User[]>(url)`, `$fetch<User>(url)`.
      CallExpression(node) {
        const type = /** @type {any} */ (node).typeArguments?.params?.[0] ?? /** @type {any} */ (node).typeParameters?.params?.[0];
        if (!type || !claimed(type)) return;
        const name = calleeName(node);
        const http = (name === "json" && !node.arguments.length) || (/^(get|post|put|patch|delete|request)$/.test(name) && /^(axios|http|api|client|instance|ky)$/i.test(receiverName(node))) || /^(\$fetch|ofetch)$/.test(name);
        if (http) context.report({ node, messageId: "cast", data: { source: "a JSON body" } });
      },
      // const user: User = await res.json();
      VariableDeclarator(node) {
        const type = /** @type {any} */ (node.id).typeAnnotation?.typeAnnotation;
        if (type && node.init) check(node, node.init, type, true);
      },
      // async function getUser(): Promise<User> { return res.json(); }
      ReturnStatement(node) {
        if (!node.argument || node.argument.type === "TSAsExpression") return;
        check(node, node.argument, returnType(enclosingFunction(node)), true);
      },
    };
  },
});

export const bad = [
  "const user = JSON.parse(text) as User;",
  "async function load() { const user = (await res.json()) as User; return user; }",
  "export async function POST(request: Request) { const input = (await request.json()) as CreatePost; return save(input); }",
  "app.post('/posts', (req, res) => { const input = req.body as CreatePost; res.json(save(input)); });",
  "window.addEventListener('message', (event) => { const msg = event.data as Command; run(msg); });",
  "const prefs = JSON.parse(localStorage.getItem('prefs') ?? '{}') as Prefs;",
  "const tab = searchParams.get('tab') as Tab;",
  "const key = process.env.STRIPE_SECRET_KEY as string;",
  "async function load(): Promise<User> { const res = await fetch('/api/me'); return res.json(); }",
  "async function load() { const user: User = await (await fetch('/api/me')).json(); return user; }",
  "export async function POST(request: Request) { const body = await request.json(); const input = body as CreatePost; return save(input); }",
  "function getUser(): Promise<User> { return fetch('/api/me').then((r) => r.json() as Promise<User>); }",
  "const { data } = await axios.get<User[]>('/api/users');",
  "const user = await res.json<User>();",
  "const config = JSON.parse(raw) satisfies Config;",
];

export const good = [
  "const user = User.parse(JSON.parse(text));",
  "const value = JSON.parse(text) as unknown;",
  "async function load() { const user = UserSchema.parse(await res.json()); return user; }",
  "const copy = JSON.parse(JSON.stringify(draft)) as Draft;",
  "const routes = ['a', 'b'] as const;",
  "async function load(): Promise<unknown> { const res = await fetch('/api/me'); return res.json(); }",
  "const user = row as User;",
  "const config = { port: 3000 } satisfies Config;",
  "function total(items: Item[]): number { return items.reduce((sum, i) => sum + i.price, 0); }",
  "const page = Number(searchParams.get('page') ?? '1');",
  "const id = (JSON.parse(line) as { id?: unknown }).id;",
  "app.post('/hook', (req, res) => { const raw = req.body as string; verify(raw, req.headers['stripe-signature']); res.end(); });",
  "app.get('/events', { schema: { querystring: Query } }, async (request) => list(request.query.kinds as Kind[]));",
  "export async function POST(request: Request) { const body = await request.json(); const input = parseCreatePost(body) as CreatePost; return save(input); }",
  "const { data } = await axios.get<unknown>('/api/users');",
  "const user = UserSchema.parse(await res.json<unknown>());",
];
