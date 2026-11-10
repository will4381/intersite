// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, isTestOrFixture, mentions, notShipped, resolveVariable, unwrap } from "../shared.mjs";

const SECRET_NAME = /(SECRET|TOKEN|API_KEY|PASSWORD)$/;

/** `env.X`, `env['X']`, `Deno.env.get('X')`: the variable name read, if it names a secret. @param {any} node */
function envSecret(node) {
  const isEnv = (/** @type {any} */ o) => (o?.type === "Identifier" && o.name === "env") || (o?.type === "MemberExpression" && o.property.name === "env");
  let name;
  if (node.type === "MemberExpression" && isEnv(node.object)) name = node.computed ? node.property.value : node.property.name;
  else if (calleeName(node) === "get" && isEnv(node.callee.object)) name = node.arguments[0]?.value;
  return typeof name === "string" && SECRET_NAME.test(name);
}

// A value the code computed or configured to compare a guess against: `expectedSignature`, `computedHmac`, `config.apiKey`.
const EXPECTED = /^(expected|computed|calculated|valid|correct|real)\w*(Signature|Sig|Hmac|Digest|Hash|Token|Secret|Key)$/i;
const CONFIG = /^(config|cfg|settings|secrets|options)$/;
/** What every secret above names somewhere in the file, an alias's initializer included. */
const SECRET_WORD = /secret|token|api_?key|password|(?:expected|computed|calculated|valid|correct|real)\w*(?:Signature|Sig|Hmac|Digest|Hash|Token|Secret|Key)/i;

/**
 * A secret: an env secret, a `const` set to one (`const { CRON_SECRET } = process.env`), an expected signature, or a
 * configured key such as `config.apiKey`.
 * @param {any} node @param {any} sourceCode @param {number} [depth]
 */
function isSecret(node, sourceCode, depth = 0) {
  node = unwrap(node);
  if (!node || depth > 2) return false;
  if (envSecret(node)) return true;
  if (node.type === "Identifier" && EXPECTED.test(node.name)) return true;
  if (node.type === "MemberExpression" && !node.computed && /(secret|apiKey|api_key|password|token)$/i.test(node.property.name) && CONFIG.test(node.object.name ?? node.object.property?.name ?? "")) return true;
  if (node.type !== "Identifier") return false;
  const init = constInit(node, sourceCode);
  if (init === undefined) return false;
  // `const { WEBHOOK_SECRET } = process.env`
  const def = resolveVariable(node, sourceCode)?.defs[0]?.node;
  if (def?.id.type === "ObjectPattern") return SECRET_NAME.test(node.name) && unwrap(init).type === "MemberExpression" && unwrap(init).property.name === "env";
  return isSecret(init, sourceCode, depth + 1);
}

/** The secret itself, or a template around it such as `Bearer ${process.env.CRON_SECRET}`. @param {any} node @param {any} sourceCode */
const holdsSecret = (node, sourceCode) => isSecret(node, sourceCode) || (node.type === "TemplateLiteral" && node.expressions.some((/** @type {any} */ e) => isSecret(e, sourceCode)));

/** A check that the variable is set, not a guess at its value: `=== undefined`, `!== ''`. @param {any} node */
const isPresenceCheck = (node) => node.type === "Literal" || (node.type === "Identifier" && node.name === "undefined");

export const id = "no-timing-unsafe-secret-compare";
export const pack = "security";
// ponytail: a secret held in a variable with an ordinary name (`const key = await getKey()`) or compared through `.equals()`/`includes()` is not reported.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      timing: "Comparing a secret with === or !== returns as soon as a character differs, so response timing leaks how much of a guess was right. Hash both sides to equal-length digests and compare them with crypto.timingSafeEqual (Node), or crypto.subtle.timingSafeEqual on Workers.",
    },
  },
  createOnce(context) {
    return {
      // A test double of the check (a fake worker that wants the header), or a dev script, guards nothing real.
      before: () => !isTestOrFixture(context) && !notShipped(context) && mentions(context, SECRET_WORD),
      BinaryExpression(node) {
        if (!/^[!=]==?$/.test(node.operator)) return;
        const [a, b] = [/** @type {any} */ (node.left), /** @type {any} */ (node.right)];
        if ((holdsSecret(a, context.sourceCode) && !isPresenceCheck(b)) || (holdsSecret(b, context.sourceCode) && !isPresenceCheck(a))) context.report({ node, messageId: "timing" });
      },
    };
  },
});

export const bad = [
  "if (req.headers['x-api-key'] !== process.env.API_KEY) return res.status(401).end();",
  "if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return new Response('unauthorized', { status: 401 });",
  "if (token === env.WEBHOOK_SECRET) await handle(body);",
  "const ok = c.req.header('x-admin-password') == c.env.ADMIN_PASSWORD;",
  "if (req.headers['x-api-key'] !== config.apiKey) return res.status(401).end();",
  "const expected = process.env.CRON_SECRET;\nif (auth !== `Bearer ${expected}`) return new Response('no', { status: 401 });",
  "const { WEBHOOK_SECRET } = process.env;\nif (req.query.secret !== WEBHOOK_SECRET) return res.status(401).end();",
  "if (signature !== expectedSignature) throw new Error('bad signature');",
  "if (Deno.env.get('CRON_SECRET') !== auth) return new Response(null, { status: 401 });",
];

export const good = [
  "if (!timingSafeEqual(Buffer.from(given), Buffer.from(process.env.API_KEY))) return res.status(401).end();",
  "if (process.env.API_KEY === undefined) throw new Error('API_KEY is not set');",
  "if (env.CRON_SECRET === '') throw new Error('CRON_SECRET is empty');",
  "if (process.env.NODE_ENV === 'production') enableCache();",
  "const changed = prev.token !== next.token;",
  "if (expectedSignature.length !== signature.length) return false;",
  "if (signature !== undefined) verify(signature);",
];
