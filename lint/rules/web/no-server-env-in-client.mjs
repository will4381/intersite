// @ts-check
import { defineRule } from "@oxlint/plugins";

const PUBLIC = /^(NEXT_PUBLIC_\w+|NODE_ENV)$/;

/** @param {any} node */
const isProcessEnv = (node) => node?.type === "MemberExpression" && !node.computed && node.object.name === "process" && node.property.name === "env";

export const id = "no-server-env-in-client";
export const pack = "next";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      server: 'This "use client" file reads a server-only environment variable. Next.js inlines only NEXT_PUBLIC_ variables into the browser bundle, so this is undefined in the browser and set during server rendering, and the two renders disagree. Read it in a server component, route or server action and pass down only what the client needs; rename it NEXT_PUBLIC_ only if it is safe to publish.',
    },
  },
  createOnce(context) {
    return {
      before() {
        return context.sourceCode.ast.body.some((/** @type {any} */ s) => s.directive === "use client");
      },
      MemberExpression(node) {
        const property = /** @type {any} */ (node.property);
        const name = node.computed ? property.value : property.name;
        if (isProcessEnv(node.object) && typeof name === "string" && !PUBLIC.test(name)) context.report({ node, messageId: "server" });
      },
      // const { OPENAI_API_KEY } = process.env
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !isProcessEnv(node.init)) return;
        for (const p of /** @type {any[]} */ (node.id.properties)) if (p.type === "Property" && !PUBLIC.test(p.key.name ?? "")) context.report({ node: p, messageId: "server" });
      },
    };
  },
});

export const bad = [
  "'use client';\nexport const api = process.env.API_URL;",
  "\"use client\";\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY);",
  "'use client';\nconst { OPENAI_API_KEY } = process.env;",
  "'use client';\nexport const key = process.env['STRIPE_SECRET_KEY'];",
];

export const good = [
  "'use client';\nexport const api = process.env.NEXT_PUBLIC_API_URL;",
  "'use client';\nif (process.env.NODE_ENV === 'development') console.debug('dev');",
  "'use server';\nexport async function save() { return process.env.API_URL; }",
  "export const api = process.env.API_URL;",
  "// 'use client' is needed by the caller, not here\nexport const api = process.env.API_URL;",
];
