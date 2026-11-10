// @ts-check
import { defineRule } from "@oxlint/plugins";

// Names that hold a credential: `token`, `accessToken`, `user.password`, `STRIPE_SECRET_KEY`, `headers.authorization`.
const SECRET = /^(token|secret|password|passwd|apiKey|api_key|jwt|cookie|authorization)$|[a-z](Token|Secret|Password|ApiKey|PrivateKey)$|^[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|SECRET_KEY|PRIVATE_KEY|SERVICE_ROLE_KEY)$/;
// Tokens that are not credentials: pagination cursors, CSRF tokens sent to the page anyway, LLM token counts.
const HARMLESS = /(page|next|cursor|continuation|csrf|max|input|output|total|prompt|completion)_?tokens?$/i;

/** @param {any} node */
function name(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return undefined;
  if (!node.computed) return node.property.name;
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

/** @param {any} node */
function isSecret(node) {
  if (node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === "process" && name(node) === "env") return true;
  const n = name(node);
  return n !== undefined && SECRET.test(n) && !HARMLESS.test(n);
}

/** @param {any} node the logged values worth checking: the argument, a template's parts, an object's values */
function parts(node) {
  if (node.type === "TemplateLiteral") return node.expressions;
  if (node.type === "ObjectExpression") return node.properties.filter((/** @type {any} */ p) => p.type === "Property").map((/** @type {any} */ p) => p.value);
  return [node];
}

/**
 * Inside a request handler: `(req, res) =>`, `({ request }) =>`, `(c) =>` on a route, or Next's `export function GET`.
 * Outside one, console output goes to whoever ran the program, as when a CLI shows a key it just created.
 * @param {any} node
 */
function inHandler(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (!(n.type.endsWith("FunctionExpression") || n.type === "FunctionDeclaration")) continue;
    const first = n.params[0];
    if (first?.type === "Identifier" && /^(req|request|ctx|c|event)$/.test(first.name)) return true;
    if (first?.type === "ObjectPattern" && first.properties.some((/** @type {any} */ p) => p.key?.name === "request")) return true;
    const name = n.id?.name ?? (n.parent.type === "VariableDeclarator" ? n.parent.id.name : undefined);
    if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(name ?? "")) return true;
  }
  return false;
}

export const id = "no-secret-in-log";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      logged: "This writes a secret or token to the logs, where everyone with log access (and every log vendor) can read and replay it. Log that it was present, its length or a short fingerprint, never the value.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type !== "MemberExpression") return;
        // A server logger (`logger.info`, Fastify's `request.log`) always ends up in log storage; the console only does
        // when a server writes to it.
        const logger = name(callee.object);
        if (!(/^(logger|log)$/.test(logger ?? "") || (logger === "console" && inHandler(node)))) return;
        for (const arg of node.arguments) for (const part of parts(arg)) if (isSecret(part)) context.report({ node: part, messageId: "logged" });
      },
    };
  },
});

export const bad = [
  "app.post('/login', (req, res) => { console.log('token', token); });",
  "export async function POST(request: Request) { const user = await request.json(); console.log(`Signing in with ${user.password}`); }",
  "app.use((req, res, next) => { console.error('auth failed', req.headers.authorization); next(); });",
  "export const GET = () => { console.log(process.env.STRIPE_SECRET_KEY); return new Response('ok'); };",
  "app.get('/debug', (c) => { console.log('env', process.env); return c.text('ok'); });",
  "logger.info({ userId, accessToken });",
  "request.log.debug({ cookie: req.headers['cookie'] });",
];

export const good = [
  "app.post('/login', (req, res) => { console.log('token present:', Boolean(token)); });",
  "app.get('/feed', (req, res) => { console.log('next page', nextPageToken); });",
  "export async function POST() { console.log(`used ${maxTokens} tokens of ${inputTokens}`); }",
  "app.post('/login', (req, res) => { console.log('token length', token.length); });",
  "console.log(`store this once, shown only now: INGEST_TOKEN=${fresh.INGEST_TOKEN}`);",
  "logger.info({ userId, tokenId: token.id });",
  "console.log('fingerprint', token.slice(0, 6));",
];
