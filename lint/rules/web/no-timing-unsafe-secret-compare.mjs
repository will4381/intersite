// @ts-check
import { relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

/** `process.env.API_KEY`, `env.CRON_SECRET`, `c.env.WEBHOOK_TOKEN`. @param {any} node */
const isEnvSecret = (node) =>
  node.type === "MemberExpression" && !node.computed && /(SECRET|TOKEN|API_KEY|PASSWORD)$/.test(node.property.name) &&
  ((node.object.type === "Identifier" && node.object.name === "env") || (node.object.type === "MemberExpression" && node.object.property.name === "env"));

/** The secret itself, or a template around it such as `Bearer ${process.env.CRON_SECRET}`. @param {any} node */
const holdsSecret = (node) => isEnvSecret(node) || (node.type === "TemplateLiteral" && node.expressions.some(isEnvSecret));

/** A check that the variable is set, not a guess at its value: `=== undefined`, `!== ''`. @param {any} node */
const isPresenceCheck = (node) => node.type === "Literal" || (node.type === "Identifier" && node.name === "undefined");

export const id = "no-timing-unsafe-secret-compare";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      timing: "Comparing a secret with === or !== returns as soon as a character differs, so response timing leaks how much of a guess was right. Compare digests with crypto.timingSafeEqual (equal-length Buffers), or HMAC both sides first.",
    },
  },
  createOnce(context) {
    return {
      // A test double of the check (a fake worker that wants the header) guards nothing real.
      before() {
        return !/(^|\/)(__tests__|tests?|e2e|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$|[./-]fixtures?\.[cm]?[jt]sx?$/.test(relative(context.cwd, context.filename));
      },
      BinaryExpression(node) {
        if (!/^[!=]==?$/.test(node.operator)) return;
        const [a, b] = [/** @type {any} */ (node.left), /** @type {any} */ (node.right)];
        if ((holdsSecret(a) && !isPresenceCheck(b)) || (holdsSecret(b) && !isPresenceCheck(a))) context.report({ node, messageId: "timing" });
      },
    };
  },
});

export const bad = [
  "if (req.headers['x-api-key'] !== process.env.API_KEY) return res.status(401).end();",
  "if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return new Response('unauthorized', { status: 401 });",
  "if (token === env.WEBHOOK_SECRET) await handle(body);",
  "const ok = c.req.header('x-admin-password') == c.env.ADMIN_PASSWORD;",
];

export const good = [
  "if (!timingSafeEqual(Buffer.from(given), Buffer.from(process.env.API_KEY))) return res.status(401).end();",
  "if (process.env.API_KEY === undefined) throw new Error('API_KEY is not set');",
  "if (env.CRON_SECRET === '') throw new Error('CRON_SECRET is empty');",
  "if (process.env.NODE_ENV === 'production') enableCache();",
];
