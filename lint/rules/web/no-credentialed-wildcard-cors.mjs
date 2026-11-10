// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, enclosingFunction, mentions, resolveVariable, unwrap } from "../shared.mjs";

/** What a file must spell for this rule to have anything to report (see `mentions`). */
const NEEDS = /credentials/i;

/** @param {any} property */
const key = (property) => String(property.key?.name ?? property.key?.value ?? "").toLowerCase();

/** `req.headers.origin`, `request.headers.get('origin')`, `req.get('origin')`, `c.req.header('origin')`. */
const ORIGIN_READ = /headers\s*(\.\s*origin\b|\[\s*['"]origin['"]\s*\]|\.get\(\s*['"]origin['"])|\b(get|header)\(\s*['"]origin['"]\s*\)/i;
const CREDENTIALS = /access-control-allow-credentials['"]\s*,\s*['"]?true/i;

/** The request's own Origin header, read here or through a `const`, maybe behind `?? ''`. @param {any} node @param {any} sourceCode */
function echoesOrigin(node, sourceCode) {
  node = unwrap(node);
  while (node?.type === "LogicalExpression") node = unwrap(node.left);
  if (!node) return false;
  if (ORIGIN_READ.test(sourceCode.getText(node)) && node.type !== "ConditionalExpression" && node.type !== "CallExpression") return true;
  if (node.type === "CallExpression" && /^(get|header)$/.test(calleeName(node))) return ORIGIN_READ.test(sourceCode.getText(node));
  const init = constInit(node, sourceCode);
  return init !== undefined && echoesOrigin(init, sourceCode) && !checked(node, sourceCode);
}

/** A `const origin = ...` the code also tests: passed to a call (`isAllowed(origin)`, `ALLOWED.includes(origin)`) or compared. @param {any} node @param {any} sourceCode */
function checked(node, sourceCode) {
  return (resolveVariable(node, sourceCode)?.references ?? []).some((/** @type {any} */ r) => {
    const parent = r.identifier.parent;
    return (parent.type === "CallExpression" && parent.arguments.includes(r.identifier) && !/^(set|setHeader|header|append)$/.test(calleeName(parent))) || (parent.type === "BinaryExpression" && /^[!=]==?$/.test(parent.operator));
  });
}

/**
 * A cors `origin` that lets every site in: `true`, `'*'`, `/.*\/`, or a function that approves whatever it is given,
 * as in `(origin, cb) => cb(null, true)` or `(origin) => origin`.
 * @param {any} origin
 */
function allowsAll(origin) {
  if (origin?.value === true || origin?.value === "*" || origin?.regex?.pattern === ".*") return true;
  if (!origin?.type?.endsWith("FunctionExpression") || origin.params[0]?.type !== "Identifier") return false;
  const param = origin.params[0].name;
  const body = origin.body.type === "BlockStatement" && origin.body.body.length === 1 ? origin.body.body[0].argument ?? origin.body.body[0].expression : origin.body;
  const approves = (/** @type {any} */ n) => n?.value === true || (n?.type === "Identifier" && n.name === param);
  if (approves(body)) return true;
  return body?.type === "CallExpression" && body.callee.name === origin.params[1]?.name && approves(body.arguments[1]);
}

export const id = "no-credentialed-wildcard-cors";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      open: "This lets every website make requests with your users' cookies and read the answers (origin * or true, a function that approves every origin, or the caller's own Origin echoed back). List the allowed origins explicitly, as in cors({ origin: ['https://app.example.com'], credentials: true }), echo the Origin only after checking it against that list, or drop credentials for a public API.",
    },
  },
  createOnce(context) {
    return {
      before: () => mentions(context, NEEDS),
      ObjectExpression(node) {
        /** @type {Map<string, any>} */
        const props = new Map();
        for (const p of /** @type {any[]} */ (node.properties)) if (p.type === "Property") props.set(key(p), p.value);
        // cors({ origin: true, credentials: true }) and Fastify's @fastify/cors
        if (props.get("credentials")?.value === true && allowsAll(props.get("origin"))) return context.report({ node, messageId: "open" });
        // Hand-written headers that echo whatever Origin the request sent.
        const allow = props.get("access-control-allow-origin");
        if (/^true$/.test(String(props.get("access-control-allow-credentials")?.value)) && allow && echoesOrigin(allow, context.sourceCode)) context.report({ node, messageId: "open" });
      },
      // res.setHeader('Access-Control-Allow-Origin', req.headers.origin) beside Allow-Credentials: true
      CallExpression(node) {
        const [name, value] = /** @type {any[]} */ (node.arguments);
        if (!/^(setHeader|header|set|append)$/.test(calleeName(node)) || String(name?.value).toLowerCase() !== "access-control-allow-origin") return;
        const scope = enclosingFunction(node) ?? context.sourceCode.ast;
        if (echoesOrigin(value, context.sourceCode) && CREDENTIALS.test(context.sourceCode.getText(scope))) context.report({ node, messageId: "open" });
      },
    };
  },
});

export const bad = [
  "app.use(cors({ origin: true, credentials: true }));",
  "app.use(cors({ origin: '*', credentials: true }));",
  "await app.register(fastifyCors, { credentials: true, origin: true });",
  "return new Response(body, { headers: { 'Access-Control-Allow-Origin': request.headers.get('origin'), 'Access-Control-Allow-Credentials': 'true' } });",
  "app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));",
  "app.use('*', cors({ origin: (origin) => origin, credentials: true }));",
  "app.use((req, res, next) => {\n  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);\n  res.setHeader('Access-Control-Allow-Credentials', 'true');\n  next();\n});",
  "const origin = req.headers.origin ?? '';\nconst headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': true };",
];

export const good = [
  "app.use(cors({ origin: ['https://app.example.com'], credentials: true }));",
  "app.use(cors({ origin: '*' }));",
  "app.use(cors({ origin: allowedOrigin, credentials: true }));",
  "return new Response(body, { headers: { 'Access-Control-Allow-Origin': 'https://app.example.com', 'Access-Control-Allow-Credentials': 'true' } });",
  "app.use(cors({ origin: (origin, cb) => cb(null, ALLOWED.includes(origin)), credentials: true }));",
  "const headers = { 'Access-Control-Allow-Origin': pickOrigin(req.headers.origin), 'Access-Control-Allow-Credentials': 'true' };",
  "export function withCors(response: Response, request: Request) {\n  const origin = request.headers.get('origin');\n  if (!origin || !isAllowedOrigin(origin)) return response;\n  response.headers.set('access-control-allow-origin', origin);\n  response.headers.set('access-control-allow-credentials', 'true');\n  return response;\n}",
  "const origin = ALLOWED.includes(req.headers.origin) ? req.headers.origin : ALLOWED[0];\nres.setHeader('Access-Control-Allow-Origin', origin);\nres.setHeader('Access-Control-Allow-Credentials', 'true');",
];
