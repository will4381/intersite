// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, filePath, unwrap } from "../shared.mjs";

// A secret's name; `TEST_SEED_PASSWORD` or `DEMO_TOKEN` says it is not a production secret.
const SECRET = /^(?!(TEST|E2E|DEV|LOCAL|DEMO)_).*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|SECRET_KEY|ACCESS_KEY|HMAC_KEY|JWT_KEY)$/;
// Test data, seeds, load tests and dev scripts may well default a password; nothing they sign is real.
const EXEMPT = /(^|\/)(__tests__|tests?|e2e|fixtures?|scripts|seeds?|load-tests?)\/|(^|[./-])(test|spec|seed|fixture)s?[./-][^/]*$|(jest|vitest)\.setup\.|setupTests\./;
// Option keys whose value signs or authenticates: express-session, Auth.js, Better Auth, OAuth clients.
const SECRET_OPTION = /^(secret|jwtSecret|sessionSecret|cookieSecret|signingSecret|clientSecret|encryptionKey)$/;

/** A non-empty string written in the source. @param {any} node */
const isConstant = (node) =>
  (node?.type === "Literal" && typeof node.value === "string" && node.value !== "") ||
  (node?.type === "TemplateLiteral" && !node.expressions.length && node.quasis[0].value.cooked !== "");

/** A non-empty string written in the source, here or in the `const` it names, or `new TextEncoder().encode(it)`. @param {any} node @param {any} sourceCode @param {number} [depth] */
function isWrittenSecret(node, sourceCode, depth = 0) {
  node = unwrap(node);
  if (calleeName(node) === "encode" && node.arguments.length === 1) node = unwrap(node.arguments[0]);
  if (isConstant(node)) return true;
  const init = node?.type === "Identifier" && depth < 2 ? constInit(node, sourceCode) : undefined;
  return init !== undefined && isWrittenSecret(init, sourceCode, depth + 1);
}

/** `process.env`, `import.meta.env`, `env`, `c.env`. @param {any} node */
const isEnv = (node) => (node.type === "Identifier" && /^(env|ENV)$/.test(node.name)) || (node.type === "MemberExpression" && !node.computed && node.property.name === "env");

/** The variable name of `env.X`, `env['X']` or `Deno.env.get('X')`. @param {any} node */
function envName(node) {
  if (node?.type === "MemberExpression" && isEnv(node.object)) return node.computed ? node.property.value : node.property.name;
  if (calleeName(node) === "get" && node.callee.object && isEnv(node.callee.object)) return node.arguments[0]?.value;
  return undefined;
}

/** `process.env.JWT_SECRET`, also inside `process.env.A || process.env.B`, behind `as string` or `!`. @param {any} node */
function isSecretEnv(node) {
  node = unwrap(node);
  if (node?.type === "LogicalExpression") return node.operator !== "&&" && (isSecretEnv(node.left) || isSecretEnv(node.right));
  const name = envName(node);
  return typeof name === "string" && SECRET.test(name);
}

export const id = "no-default-secret";
export const pack = "security";
// ponytail: secrets under names that do not end in SECRET/TOKEN/PASSWORD/KEY, fallbacks behind a call (`.trim() || 'x'`), and literal secrets passed to libraries other than jsonwebtoken, jose, createHmac, cookie-parser and session-style options are not reported.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      fallback: "When this secret is missing from the environment the code quietly uses one written in the source, so a deploy that forgot it signs or authenticates with a value anyone with the repository knows. Fail at startup instead: if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set').",
      written: "This signs or checks with a secret written in the source, so anyone with the repository can forge tokens, sessions or signatures. Read it from the environment (process.env.JWT_SECRET, checked at startup) and rotate the one that shipped.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    const written = (node) => node && isWrittenSecret(node, context.sourceCode) && context.report({ node, messageId: "written" });
    return {
      before() {
        return !EXEMPT.test(filePath(context));
      },
      // process.env.JWT_SECRET || 'dev-secret', env.API_KEY ?? 'changeme'
      LogicalExpression(node) {
        if (node.operator !== "&&" && isSecretEnv(node.left) && isConstant(unwrap(node.right))) context.report({ node: node.right, messageId: "fallback" });
      },
      // process.env.JWT_SECRET ? process.env.JWT_SECRET : 'dev-secret'
      ConditionalExpression(node) {
        if (isSecretEnv(node.test) && isConstant(unwrap(node.alternate))) context.report({ node: node.alternate, messageId: "fallback" });
      },
      // const { JWT_SECRET = 'dev-secret' } = process.env
      AssignmentPattern(node) {
        const property = /** @type {any} */ (node.parent);
        const pattern = property?.parent;
        if (property?.type !== "Property" || !SECRET.test(property.key?.name ?? "") || !isConstant(node.right)) return;
        if (pattern?.type === "ObjectPattern" && pattern.parent.type === "VariableDeclarator" && pattern.parent.init && isEnv(pattern.parent.init)) context.report({ node: node.right, messageId: "fallback" });
      },
      Property(node) {
        const value = /** @type {any} */ (node.value);
        const key = /** @type {any} */ (node.key).name ?? "";
        // An environment schema: JWT_SECRET: z.string().default('secret'), .catch('secret')
        if (SECRET.test(key)) {
          for (let call = value; call?.type === "CallExpression" && call.callee.type === "MemberExpression"; call = call.callee.object) {
            if (/^(default|catch)$/.test(call.callee.property.name) && isConstant(call.arguments[0])) return context.report({ node: call.arguments[0], messageId: "fallback" });
          }
        }
        // session({ secret: 'keyboard cat' }), NextAuth({ secret: '...' }), { clientSecret: '...' } passed to a call
        const object = /** @type {any} */ (node.parent);
        if (SECRET_OPTION.test(key) && (object.parent?.type === "CallExpression" || object.parent?.type === "NewExpression")) written(value);
      },
      // jwt.sign(claims, 'secret'), jwt.verify(token, 'secret'), createHmac('sha256', 'secret'), new SignJWT(c).sign(encode('secret'))
      CallExpression(node) {
        const name = calleeName(node);
        const args = /** @type {any[]} */ (node.arguments);
        if (/^(sign|verify)$/.test(name) && /^(jwt|jsonwebtoken|jws)$/i.test(node.callee.object?.name ?? "")) written(args[1]);
        else if (name === "createHmac" || name === "jwtVerify") written(args[1]);
        else if (name === "sign" && args.length === 1 && /SignJWT|setProtectedHeader/.test(context.sourceCode.getText(node.callee))) written(args[0]);
        else if (name === "cookieParser") written(args[0]);
      },
    };
  },
});

export const bad = [
  "const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';",
  "export const config = { apiKey: process.env.ADMIN_API_KEY ?? 'dev-admin-key' };",
  "const { SESSION_SECRET = 'keyboard cat' } = process.env;",
  "const Env = z.object({ JWT_SECRET: z.string().default('secret') });",
  "const token = c.env.WEBHOOK_TOKEN || `local-token`;",
  "const key = process.env.GLOBAL_API_KEY || process.env.LEGACY_API_KEY || 'default-key';",
  "const secret = process.env['JWT_SECRET'] || 'dev-secret';",
  "const secret = process.env.JWT_SECRET ? process.env.JWT_SECRET : 'dev-secret';",
  "const secret = Deno.env.get('JWT_SECRET') ?? 'dev-secret';",
  "const secret = (process.env.JWT_SECRET as string) || 'dev-secret';",
  "const Env = z.object({ API_KEY: z.string().min(1).default('dev-key').describe('key') });",
  "const token = jwt.sign({ sub: user.id }, 'super-secret-key', { expiresIn: '1h' });",
  "const JWT_KEY = 'super-secret-key';\nexport const verifyToken = (token: string) => jwt.verify(token, JWT_KEY);",
  "app.use(session({ secret: 'keyboard cat', resave: false, saveUninitialized: false }));",
  "const sig = crypto.createHmac('sha256', 'my-webhook-secret').update(body).digest('hex');",
  "const jwt = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('my-jwt-secret'));",
];

export const good = [
  "const secret = process.env.JWT_SECRET; if (!secret) throw new Error('JWT_SECRET is not set');",
  "const key = process.env.STRIPE_SECRET_KEY ?? '';",
  "const url = process.env.API_URL || 'http://localhost:3000';",
  "const Env = z.object({ JWT_SECRET: z.string().min(32), PORT: z.coerce.number().default(3000) });",
  "const enabled = process.env.FEATURE_TOKEN && 'on';",
  "const pass = values.REDIS_PASSWORD ?? 'from-validated-config';",
  "const Env = z.object({ TEST_SEED_STAFF_PASSWORD: z.string().default('local-only') });",
  "const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET!, { expiresIn: '1h' });",
  "const sig = jwt.sign(payload, privateKey, { algorithm: 'RS256' });",
  "app.use(session({ secret: config.sessionSecret }));",
  "const hash = crypto.createHmac('sha256', key).update(body).digest('hex');",
  "const id = crypto.createHash('sha256').update('salt').digest('hex');",
  "const form = { secret: 'shown once' };",
];
