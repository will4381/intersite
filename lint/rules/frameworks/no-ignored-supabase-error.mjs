// @ts-check
import { defineRule } from "@oxlint/plugins";

import { unwrap } from "../shared.mjs";
import { chainMethods, chainRoot, importsModule } from "./syntax.mjs";

/**
 * Supabase entry points whose result carries `{ data, error }`. Not `auth`: `const { data: { user } } = await
 * supabase.auth.getUser()` is the documented shape, and a null user already says it failed.
 */
const ENTRY = /^(from|rpc|storage|functions|schema)$/;

export const id = "no-ignored-supabase-error";
export const pack = "supabase";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      error: "Supabase does not throw: a failed query (an RLS denial, a bad filter, no rows for .single()) resolves with `data: null` and the reason in `error`, and this code reads only `data`. Destructure `error` too and handle it (if (error) throw error), or end the query with .throwOnError().",
    },
  },
  createOnce(context) {
    return {
      before() {
        return importsModule(context.sourceCode.ast, /^@supabase\//) || /supabase/i.test(context.sourceCode.text);
      },
      // `const { data } = await supabase.from('t').select()`
      VariableDeclarator(node) {
        const pattern = /** @type {any} */ (node.id);
        if (pattern.type !== "ObjectPattern" || node.init?.type !== "AwaitExpression") return;
        const keys = pattern.properties.map((/** @type {any} */ p) => (p.type === "RestElement" ? "..." : p.key?.name));
        if (!keys.includes("data") || keys.includes("error") || keys.includes("...")) return;
        const call = unwrap(node.init);
        if (call?.type !== "CallExpression") return;
        const methods = chainMethods(call);
        const root = chainRoot(call);
        if (methods.includes("throwOnError") || !/supabase/i.test(root?.name ?? root?.property?.name ?? "")) return;
        if (methods.some((m) => ENTRY.test(m))) context.report({ node: pattern, messageId: "error" });
      },
    };
  },
});

export const bad = [
  "const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();",
  "const { data: posts } = await supabase.from('posts').select().order('created_at');",
  "export async function upload(file: File) {\n  const { data } = await supabaseAdmin.storage.from('avatars').upload(file.name, file);\n  return data.path;\n}",
  "const { data: rows } = await supabase.rpc('search', { q });\nreturn rows.map(toResult);",
];

export const good = [
  "const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();\nif (error) throw error;",
  "const { data } = await supabase.from('posts').select().throwOnError();",
  "const { data } = await api.get('/posts');",
  "const { data, ...rest } = await supabase.rpc('stats');\nreport(rest);",
  "const { data } = await axios.get(`/api/supabase-status`);",
  "const { data: { user } } = await supabase.auth.getUser();\nif (!user) redirect('/login');",
];
