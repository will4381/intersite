// @ts-check
import { relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

// A secret's name; `TEST_SEED_PASSWORD` or `DEMO_TOKEN` says it is not a production secret.
const SECRET = /^(?!(TEST|E2E|DEV|LOCAL|DEMO)_).*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|SECRET_KEY|ACCESS_KEY|HMAC_KEY|JWT_KEY)$/;
// Test data, seeds, load tests and dev scripts may well default a password; nothing they sign is real.
const EXEMPT = /(^|\/)(__tests__|tests?|e2e|fixtures?|scripts|seeds?|load-tests?)\/|(^|[./-])(test|spec|seed|fixture)s?[./-][^/]*$|(jest|vitest)\.setup\.|setupTests\./;

/** A non-empty string written in the source. @param {any} node */
const isConstant = (node) =>
  (node?.type === "Literal" && typeof node.value === "string" && node.value !== "") ||
  (node?.type === "TemplateLiteral" && !node.expressions.length && node.quasis[0].value.cooked !== "");

/** `process.env`, `import.meta.env`, `env`, `c.env`. @param {any} node */
const isEnv = (node) => (node.type === "Identifier" && /^(env|ENV)$/.test(node.name)) || (node.type === "MemberExpression" && !node.computed && node.property.name === "env");

/** `process.env.JWT_SECRET`, also inside `process.env.A || process.env.B`. @param {any} node */
const isSecretEnv = (node) => node?.type === "LogicalExpression" ? node.operator !== "&&" && (isSecretEnv(node.left) || isSecretEnv(node.right))
  : node?.type === "MemberExpression" && !node.computed && SECRET.test(node.property.name) && isEnv(node.object);

export const id = "no-default-secret";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      fallback: "When this secret is missing from the environment the code quietly uses one written in the source, so a deploy that forgot it signs or authenticates with a value anyone with the repository knows. Fail at startup instead: if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set').",
    },
  },
  createOnce(context) {
    return {
      before() {
        return !EXEMPT.test(relative(context.cwd, context.filename));
      },
      // process.env.JWT_SECRET || 'dev-secret', env.API_KEY ?? 'changeme'
      LogicalExpression(node) {
        if (node.operator !== "&&" && isSecretEnv(node.left) && isConstant(node.right)) context.report({ node: node.right, messageId: "fallback" });
      },
      // const { JWT_SECRET = 'dev-secret' } = process.env
      AssignmentPattern(node) {
        const property = /** @type {any} */ (node.parent);
        const pattern = property?.parent;
        if (property?.type !== "Property" || !SECRET.test(property.key?.name ?? "") || !isConstant(node.right)) return;
        if (pattern?.type === "ObjectPattern" && pattern.parent.type === "VariableDeclarator" && pattern.parent.init && isEnv(pattern.parent.init)) context.report({ node: node.right, messageId: "fallback" });
      },
      // An environment schema: JWT_SECRET: z.string().default('dev-secret')
      Property(node) {
        const value = /** @type {any} */ (node.value);
        if (!SECRET.test(/** @type {any} */ (node.key).name ?? "") || value.type !== "CallExpression" || value.callee.type !== "MemberExpression") return;
        if (value.callee.property.name === "default" && isConstant(value.arguments[0])) context.report({ node: value.arguments[0], messageId: "fallback" });
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
];

export const good = [
  "const secret = process.env.JWT_SECRET; if (!secret) throw new Error('JWT_SECRET is not set');",
  "const key = process.env.STRIPE_SECRET_KEY ?? '';",
  "const url = process.env.API_URL || 'http://localhost:3000';",
  "const Env = z.object({ JWT_SECRET: z.string().min(32), PORT: z.coerce.number().default(3000) });",
  "const enabled = process.env.FEATURE_TOKEN && 'on';",
  "const pass = values.REDIS_PASSWORD ?? 'from-validated-config';",
  "const Env = z.object({ TEST_SEED_STAFF_PASSWORD: z.string().default('local-only') });",
];
