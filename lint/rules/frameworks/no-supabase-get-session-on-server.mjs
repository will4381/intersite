// @ts-check
import { defineRule } from "@oxlint/plugins";

import { importsModule } from "./syntax.mjs";

/** Files that run on the server: routes, middleware, server actions, edge functions, SvelteKit/Remix server modules. */
const SERVER_FILE = /(^|\/)(middleware|proxy|route|hooks\.server)\.[cm]?[jt]s$|\+(page|layout)\.server\.[jt]s$|\+server\.[jt]s$|(^|\/)(api|server|supabase\/functions)\//;

export const id = "no-supabase-get-session-on-server";
export const pack = "supabase";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      session: "On the server, auth.getSession() only decodes the session cookie and does not verify it, so a forged or revoked token passes. Use auth.getClaims() (verifies the JWT signature) or auth.getUser() (asks the Auth server) to decide who the user is; getSession() is for reading the raw tokens.",
    },
  },
  createOnce(context) {
    return {
      before() {
        const ast = context.sourceCode.ast;
        return SERVER_FILE.test(context.filename) || ast.body.some((/** @type {any} */ s) => s.directive === "use server") ||
          importsModule(ast, /^(@supabase\/ssr|@supabase\/auth-helpers-[\w-]+|next\/headers|@tanstack\/react-start\/server)$/);
      },
      // `supabase.auth.getSession()`; Better Auth's `auth.api.getSession` and next-auth's `getSession()` verify on the server.
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type === "MemberExpression" && callee.property.name === "getSession" && callee.object.type === "MemberExpression" && callee.object.property.name === "auth") {
          context.report({ node, messageId: "session" });
        }
      },
    };
  },
});

export const bad = [
  "'use server';\nexport async function deletePost(id: string) {\n  const supabase = await createClient();\n  const { data: { session } } = await supabase.auth.getSession();\n  if (!session) throw new Error('Unauthorized');\n}",
  "import { createServerClient } from '@supabase/ssr';\nexport async function loader() {\n  const supabase = createServerClient(url, key, { cookies });\n  const { data } = await supabase.auth.getSession();\n  return data.session?.user;\n}",
  "import { cookies } from 'next/headers';\nexport async function GET() {\n  const { data: { session } } = await supabase.auth.getSession();\n  return Response.json({ user: session?.user });\n}",
];

export const good = [
  "'use server';\nexport async function deletePost(id: string) {\n  const supabase = await createClient();\n  const { data: { user } } = await supabase.auth.getUser();\n  if (!user) throw new Error('Unauthorized');\n}",
  "'use client';\nexport function useToken() {\n  return supabase.auth.getSession();\n}",
  "import { headers } from 'next/headers';\nexport async function GET() {\n  const session = await auth.api.getSession({ headers: await headers() });\n  return Response.json(session);\n}",
  "import { createServerClient } from '@supabase/ssr';\nexport async function loader() {\n  const { data } = await supabase.auth.getClaims();\n  return data?.claims.sub;\n}",
];
