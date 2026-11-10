// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, isRequestName, isRequestPart, resolveVariable } from "../shared.mjs";

/** @param {any} node */
function unwrap(node) {
  for (;;) {
    if (["TSAsExpression", "TSNonNullExpression", "AwaitExpression"].includes(node?.type)) node = node.argument ?? node.expression;
    // `searchParams.get('next') ?? '/'`: the fallback only applies when the parameter is missing.
    else if (node?.type === "LogicalExpression" && node.operator !== "&&") node = node.left;
    else if (node?.type === "CallExpression" && /^(decodeURIComponent|String)$/.test(node.callee.name)) node = node.arguments[0];
    // `new URL(next, request.url)`: an absolute `next` replaces the base.
    else if (node?.type === "NewExpression" && node.callee.name === "URL") node = node.arguments[0];
    else return node;
  }
}

/**
 * A value straight from the request URL or body: `req.query.next`, `req.body.returnTo`, `searchParams.get('next')`,
 * `url.searchParams.get('redirect')`, `c.req.query('next')`, a page's `searchParams.callbackUrl`.
 * @param {any} node
 */
function isParam(node) {
  if (node?.type === "MemberExpression") {
    const o = node.object;
    if (o.type === "Identifier" && o.name === "searchParams") return true;
    return isRequestPart(o, isRequestName);
  }
  if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false;
  const { object, property } = node.callee;
  if (property.name === "get") return (object.type === "Identifier" && object.name === "searchParams") || (object.type === "MemberExpression" && object.property.name === "searchParams");
  return property.name === "query" && object.type === "MemberExpression" && object.property.name === "req";
}

export const id = "no-open-redirect";
export const pack = "security";
// ponytail: a parameter that passes through a helper, a `let`, or a variable also used elsewhere counts as checked; client-side `location.href = next` is not checked.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      open: "This redirects to a URL taken from the request, so a link to your site can send people to a phishing page (?next=https://evil.example). Accept only a local path (starts with a single / and not //) or a value from an allowlist, and check it before redirecting.",
    },
  },
  createOnce(context) {
    /**
     * The parameter itself, or a `const next = <parameter>` binding used nowhere but in redirects: a binding that is
     * also tested (`next.startsWith('/')`, `allowed.includes(next)`) counts as checked.
     * @param {any} node
     */
    function fromRequest(node) {
      node = unwrap(node);
      if (isParam(node)) return true;
      if (node?.type !== "Identifier") return false;
      const variable = resolveVariable(node, context.sourceCode);
      const def = variable?.defs[0]?.node;
      if (def?.type !== "VariableDeclarator") return false;
      // `const next = req.query.next`, or `const { next } = req.query`
      const read = def.id.type === "Identifier" ? isParam(unwrap(def.init)) : def.id.type === "ObjectPattern" && isRequestPart(unwrap(def.init), isRequestName);
      if (!read) return false;
      return variable.references.every((/** @type {any} */ r) => r.init || isRedirectArgument(r.identifier));
    }
    /** @param {any} node */
    function isRedirectArgument(node) {
      for (let n = node.parent; n; n = n.parent) {
        if (n.type === "CallExpression") return isRedirect(n);
        if (n.type === "Property" && isLocationHeader(n)) return true;
        if (!["NewExpression", "LogicalExpression", "TSAsExpression", "TSNonNullExpression", "Property", "ObjectExpression"].includes(n.type)) return false;
      }
      return false;
    }
    /** `redirect(url)`, `res.redirect(url)`, Express `res.location(url)`. @param {any} node */
    function isRedirect(node) {
      const callee = node.callee;
      return (callee.type === "Identifier" && callee.name === "redirect") || (callee.type === "MemberExpression" && /^(redirect|location)$/.test(callee.property.name));
    }
    /** A `Location` header: `res.writeHead(302, { Location: url })`, `new Response(null, { headers: { Location: url } })`. @param {any} property */
    function isLocationHeader(property) {
      const key = property.key?.name ?? property.key?.value;
      if (key === "Location") return true;
      const object = property.parent;
      return key === "location" && (object.parent?.key?.name === "headers" || calleeName(object.parent) === "writeHead");
    }
    return {
      Property(node) {
        if (isLocationHeader(node) && fromRequest(node.value)) context.report({ node: node.value, messageId: "open" });
      },
      CallExpression(node) {
        if (!isRedirect(node)) return;
        for (const arg of /** @type {any[]} */ (node.arguments)) {
          // TanStack Router's `redirect({ href })` and similar option objects.
          const values = arg.type === "ObjectExpression" ? arg.properties.filter((/** @type {any} */ p) => /^(href|url|location)$/i.test(p.key?.name ?? "")).map((/** @type {any} */ p) => p.value) : [arg];
          for (const value of values) if (fromRequest(value)) context.report({ node: value, messageId: "open" });
        }
      },
    };
  },
});

export const bad = [
  "app.get('/login/done', (req, res) => { res.redirect(req.query.next); });",
  "export async function GET(request: Request) { const next = new URL(request.url).searchParams.get('next') ?? '/'; return NextResponse.redirect(new URL(next, request.url)); }",
  "export default async function Page({ searchParams }) { redirect(searchParams.callbackUrl); }",
  "app.get('/out', (c) => c.redirect(c.req.query('to')));",
  "export const GET = (req: NextRequest) => Response.redirect(req.nextUrl.searchParams.get('returnTo')!, 302);",
  "app.post('/login', async (req, res) => { const returnTo = req.body.returnTo || '/'; res.redirect(302, returnTo); });",
  "app.get('/cb', (req, res) => { const { next } = req.query; res.redirect(next as string); });",
  "app.get('/go', (req, res) => { res.writeHead(302, { Location: req.query.url }); res.end(); });",
  "export async function GET(req: Request) { const next = new URL(req.url).searchParams.get('next'); return new Response(null, { status: 302, headers: { Location: next } }); }",
  "app.get('/go', (req, res) => { res.location(String(req.query.url)).sendStatus(302); });",
];

export const good = [
  "export async function GET(request: Request) { const next = new URL(request.url).searchParams.get('next') ?? '/'; if (!next.startsWith('/') || next.startsWith('//')) return NextResponse.redirect(new URL('/', request.url)); return NextResponse.redirect(new URL(next, request.url)); }",
  "app.get('/login/done', (req, res) => { res.redirect(safePath(req.query.next)); });",
  "app.get('/docs', (req, res) => res.redirect('/docs/intro'));",
  "export async function GET(request: Request) { const code = new URL(request.url).searchParams.get('code'); await exchange(code); return NextResponse.redirect(new URL('/dashboard', request.url)); }",
  "app.post('/login', async (req, res) => { const returnTo = req.body.returnTo; res.redirect(ALLOWED.includes(returnTo) ? returnTo : '/'); });",
  "export default async function Page({ searchParams }) { redirect(`/search?q=${encodeURIComponent(searchParams.q)}`); }",
  "app.get('/places', async (req, res) => { res.json(await search({ location: req.query.location })); });",
];
