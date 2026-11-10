// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isEnvRead, notShipped } from "../shared.mjs";

// A project's validated env module, by its path (`./env`, `@/env.mjs`, `~/config/env`, `../env.server`).
const ENV_MODULE = /(^|[/@~])env(\.server|\.client)?(\.[cm]?[jt]s)?$/;
// Set by the runtime or bundler, not by the deploy: nothing to validate.
const RUNTIME = /^(NODE_ENV|DEV|PROD|MODE|SSR|BASE_URL|CI|VERCEL_ENV|npm_\w+)$/;

export const id = "no-env-bypass";
export const pack = "validation";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      bypass: "This file imports the project's validated env module but reads {{name}} straight from the environment, skipping the check at startup: a missing or malformed value surfaces here at runtime instead. Add {{name}} to the env schema and read it from the imported env.",
    },
  },
  createOnce(context) {
    let imported = false;
    return {
      before() {
        imported = false;
        return !notShipped(context);
      },
      ImportDeclaration(node) {
        if (ENV_MODULE.test(String(node.source.value))) imported = true;
      },
      MemberExpression(node) {
        if (!imported || !isEnvRead(node)) return;
        const name = /** @type {any} */ (node.property).name ?? /** @type {any} */ (node.property).value;
        if (name && !RUNTIME.test(name)) context.report({ node, messageId: "bypass", data: { name } });
      },
    };
  },
});

export const bad = [
  "import { env } from '@/env';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');",
  "import { env } from './env.mjs';\nconst db = postgres(env.DATABASE_URL);\nconst cache = new Redis(process.env.REDIS_URL);",
  "import { env } from '~/config/env';\nexport const api = import.meta.env.VITE_API_URL;",
];

export const good = [
  "import { env } from '@/env';\nexport const stripe = new Stripe(env.STRIPE_SECRET_KEY);",
  "import { env } from '@/env';\nif (process.env.NODE_ENV === 'production') enableTracing(env);",
  "export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');",
  "import { environment } from './environment';\nconst url = process.env.API_URL;",
];
