// @ts-check
// Helpers the rules share: walking a tree, the enclosing function, which files are tests or never shipped, where outside
// data enters a program, and the `const` aliases that carry it.
import { matchesGlob, relative } from "node:path";

import { TEST_PATHS } from "../../shared/config.mjs";

/** Function nodes, as `type` values. */
export const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * Every node under `node`, depth first, the root included, with its parent (oxlint does not set `parent` on hand-walked
 * nodes). Returning false from `visit` skips that node's children.
 * @param {any} node @param {(n: any, parent: any) => boolean | void} visit @param {any} [parent]
 */
export function walk(node, visit, parent = node?.parent) {
  if (!node || typeof node.type !== "string" || visit(node, parent) === false) return;
  for (const key in node) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const v of value) walk(v, visit, node);
    else if (value && typeof value === "object" && typeof value.type === "string") walk(value, visit, node);
  }
}

/** The nearest enclosing function, or undefined. @param {any} node */
export function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (n.type.endsWith("FunctionExpression") || n.type === "FunctionDeclaration") return n;
  return undefined;
}

const WRAPPERS = new Set(["AwaitExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "ParenthesizedExpression", "ChainExpression"]);

/**
 * The expression under any of `wrappers`: by default `await`, a cast, `!`, `satisfies`, `?.` and parentheses.
 * @param {any} node @param {Set<string>} [wrappers]
 */
export function unwrap(node, wrappers = WRAPPERS) {
  while (wrappers.has(node?.type)) node = node.type === "AwaitExpression" ? node.argument : node.expression;
  return node;
}

// Which files a rule skips. Each pattern is tuned to its rules, so they stay separate.

/** The linted file's path from the project root. @param {any} context */
const filePath = (context) => relative(context.cwd, context.filename);

/** Whether the file matches one of the default test globs (TEST_PATHS). @param {any} context */
export function inTestPaths(context) {
  const file = filePath(context);
  return TEST_PATHS.some((glob) => matchesGlob(file, glob));
}

/** Test helpers, fixtures, stories, mocks and seed scripts: places where sample data and odd shapes are the point. */
const NOT_SHIPPED = /(?:^|\/)(?:[\w-]*-test(?:s|ing)?|test|tests|testing|__tests__|__mocks__|mocks?|__fixtures__|fixtures?|stories|storybook|seeds?|e2e|qa)\/|(?:^|[/.-])(?:stories|story|fixtures?|mocks?|seeds?)\.[cm]?[jt]sx?$/;

/** Whether the file being linted is a test, fixture, story, mock or seed. @param {any} context */
export const isTestFile = (context) => inTestPaths(context) || NOT_SHIPPED.test(filePath(context));

/**
 * Tests, fixtures, seeds and repository scripts (code that reads its own files and fails loudly on a bad shape), and
 * generated clients, which nobody edits by hand.
 * @param {any} context
 */
export const notShipped = (context) => isTestFile(context) || /(^|\/)(scripts?|generated)\/|\.gen\.[cm]?[jt]sx?$/.test(filePath(context));

/** Test, seed, fixture, script and migration files (matched on the absolute path), where wiping a table or querying in a loop is the point. @param {any} context */
export const isScriptFile = (context) => /(^|\/)(tests?|__tests__|e2e|seeds?|fixtures?|scripts|migrations?)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)seed[^/]*\.[cm]?[jt]s$/.test(context.filename);

/** Tests and fixtures by folder or file suffix only, for security rules: a test double guards nothing real. @param {any} context */
export const isTestOrFixture = (context) => /(^|\/)(__tests__|tests?|e2e|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$|[./-]fixtures?\.[cm]?[jt]sx?$/.test(filePath(context));

/** Any folder or file-name part saying test, spec, e2e, smoke or fixture (`smoke-checkout.ts`), for async rules. @param {any} context */
export const isTestNamed = (context) => /(^|[/._-])(tests?|testing|spec|e2e|smoke|fixtures?|__tests__)([/._-]|$)/.test(filePath(context));

// Where outside data enters: the request, URL and form values, storage and the environment.

/** The method name of `x.name(...)`, or the function name of `name(...)`. @param {any} call */
export const calleeName = (call) => call?.type !== "CallExpression" ? "" : call.callee.type === "MemberExpression" ? call.callee.property?.name ?? "" : call.callee.name ?? "";

/** The receiver of `x.name(...)` as a name: `x`, or `y` for `a.y.name(...)`. @param {any} call */
export function receiverName(call) {
  const o = call?.callee?.type === "MemberExpression" ? call.callee.object : undefined;
  return o?.type === "Identifier" ? o.name : o?.type === "MemberExpression" ? o.property?.name ?? "" : "";
}

/** A `req` or `request` identifier. @param {any} node */
export const isRequestName = (node) => node?.type === "Identifier" && /^(req|request)$/.test(node.name);

/** `req`, `request` or Koa's `ctx.request`: what holds the parsed body, query and params. @param {any} node */
export const isRequestHolder = (node) => isRequestName(node) || (node?.type === "MemberExpression" && node.property.name === "request");

/**
 * `req.body`, `request.query`, `ctx.request.params`: a parsed request part. `holder` and `parts` narrow it.
 * @param {any} node @param {(node: any) => boolean} [holder] @param {RegExp} [parts]
 */
export function isRequestPart(node, holder = isRequestHolder, parts = /^(body|query|params)$/) {
  return node?.type === "MemberExpression" && !node.computed && parts.test(node.property.name) && holder(node.object);
}

/**
 * `request.json`, `c.req.formData` as a callee: a method that reads the body of `req`, `request` or Hono's `c.req`.
 * @param {any} callee @param {RegExp} [methods]
 */
export function isBodyMethod(callee, methods = /^(json|formData)$/) {
  const o = callee?.type === "MemberExpression" && methods.test(callee.property?.name ?? "") ? callee.object : undefined;
  return isRequestName(o) || (o?.type === "MemberExpression" && o.property.name === "req");
}

/** `await request.json()`, `await c.req.json()`, `await req.formData()`. @param {any} node @param {RegExp} [methods] */
export const isBodyCall = (node, methods) => node?.type === "CallExpression" && !node.arguments.length && isBodyMethod(node.callee, methods);

/** `searchParams.get(k)`, `formData.get(k)`, `url.searchParams.get(k)`: one value from the URL or a form. @param {any} node */
export const isParamGet = (node) => calleeName(node) === "get" && node.arguments.length === 1 && /^(searchParams|query|formData|form|params|urlParams|queryParams)$/.test(receiverName(node));

/** `localStorage.getItem(k)`, `sessionStorage.getItem(k)`. @param {any} node */
export const isStorageRead = (node) => calleeName(node) === "getItem" && /^(localStorage|sessionStorage|storage)$/.test(receiverName(node));

/** `process.env.X`, `import.meta.env.X`. @param {any} node */
export function isEnvRead(node) {
  if (node?.type !== "MemberExpression") return false;
  const o = node.object;
  return o.type === "MemberExpression" && o.property.name === "env" && ((o.object.type === "Identifier" && o.object.name === "process") || o.object.type === "MetaProperty");
}

/**
 * Request input read here: the request parts, a field of them (`req.query.page`), a body call, or a URL or form value.
 * @param {any} node
 */
export function isRequestInput(node) {
  node = unwrap(node);
  if (isRequestPart(node) || isBodyCall(node) || isParamGet(node)) return true;
  return node?.type === "MemberExpression" && isRequestPart(unwrap(node.object));
}

/**
 * Inside a route whose options declare a schema (Fastify's `{ schema: { body, querystring } }`) or list validation
 * middleware before the handler (`validate(schema)`, `celebrate(...)`, `zValidator(...)`): the framework checks the
 * request before the handler runs.
 * @param {any} node
 */
export function validatedRoute(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type !== "CallExpression") continue;
    for (const arg of n.arguments) {
      if (arg.type === "ObjectExpression" && arg.properties.some((/** @type {any} */ p) => p.key?.name === "schema")) return true;
      if (arg.type === "CallExpression" && /valid|schema|celebrate|zod|joi/i.test(calleeName(arg))) return true;
    }
  }
  return false;
}

// Aliases: the variable a name refers to, and what a `const` was set to.

/** The variable an identifier names, looked up from its scope outwards; undefined when nothing declares it. @param {any} node @param {any} sourceCode */
export function resolveVariable(node, sourceCode) {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) return variable;
  }
  return undefined;
}

/**
 * The initializer of the `const` an identifier names (`const x = init`, or `const { x } = init`); undefined otherwise.
 * @param {any} node @param {any} sourceCode
 */
export function constInit(node, sourceCode) {
  if (node?.type !== "Identifier") return undefined;
  const def = resolveVariable(node, sourceCode)?.defs[0];
  const decl = def?.node;
  if (decl?.type !== "VariableDeclarator" || !/^(Identifier|ObjectPattern)$/.test(decl.id.type) || def.parent?.kind !== "const") return undefined;
  return decl.init ?? undefined;
}

/**
 * `test(node)`, or the node is a `const` alias whose initializer passes it (one level: `const body = await req.json()`).
 * @param {any} node @param {(n: any) => boolean} test @param {any} sourceCode
 */
export function fromSource(node, test, sourceCode) {
  node = unwrap(node);
  if (test(node)) return true;
  const init = constInit(node, sourceCode);
  return init !== undefined && test(unwrap(init));
}
