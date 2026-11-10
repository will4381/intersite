// @ts-check
import { defineRule } from "@oxlint/plugins";

import { constInit, unwrap } from "../shared.mjs";
import { chainMethods, chainRoot, importsModule } from "./syntax.mjs";

/**
 * Supabase entry points whose result carries `{ data, error }`. Not `auth`: `const { data: { user } } = await
 * supabase.auth.getUser()` is the documented shape, and a null user already says it failed.
 */
const ENTRY = /^(from|rpc|storage|functions|schema)$/;
// Calls that change data: ignoring their whole result loses the only sign the write failed.
const WRITE = /^(insert|update|upsert|delete|rpc|upload|remove|move|copy|invoke)$/;
// Ways to make a Supabase client, for a client not named supabase (`const db = createClient(url, key)`).
const FACTORY = /\bcreate(Server|Browser|RouteHandler|ServerComponent|Admin)?Client\(/;

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
    /** A chain rooted at a Supabase client: `supabase.from(...)`, `(await createClient()).from(...)`, `db.from(...)` after `const db = createClient(...)`. @param {any} call */
    function onSupabase(call) {
      const root = chainRoot(call);
      if (/supabase/i.test(root?.name ?? root?.property?.name ?? "") || FACTORY.test(context.sourceCode.getText(root))) return true;
      const init = constInit(root, context.sourceCode);
      return init !== undefined && FACTORY.test(context.sourceCode.getText(init));
    }
    return {
      before() {
        return importsModule(context.sourceCode.ast, /^@supabase\//) || /supabase/i.test(context.sourceCode.text);
      },
      // `const { data } = await supabase.from('t').select()`
      VariableDeclarator(node) {
        const pattern = /** @type {any} */ (node.id);
        if (pattern.type !== "ObjectPattern" || !node.init) return;
        const keys = pattern.properties.map((/** @type {any} */ p) => (p.type === "RestElement" ? "..." : p.key?.name));
        if (!keys.includes("data") || keys.includes("error") || keys.includes("...")) return;
        const call = unwrap(node.init);
        if (call?.type !== "CallExpression") return;
        const methods = chainMethods(call);
        if (methods.includes("throwOnError") || !onSupabase(call)) return;
        if (methods.some((m) => ENTRY.test(m))) context.report({ node: pattern, messageId: "error" });
      },
      // `await supabase.from('events').insert(row);` with the result dropped entirely.
      ExpressionStatement(node) {
        const expression = /** @type {any} */ (node.expression);
        const call = expression.type === "AwaitExpression" ? unwrap(expression.argument) : undefined;
        if (call?.type !== "CallExpression" || !WRITE.test(call.callee.property?.name ?? "")) return;
        const methods = chainMethods(call);
        if (!methods.includes("throwOnError") && methods.some((m) => ENTRY.test(m)) && onSupabase(call)) context.report({ node, messageId: "error" });
      },
    };
  },
});

export const bad = [
  "const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();",
  "const { data: posts } = await supabase.from('posts').select().order('created_at');",
  "export async function upload(file: File) {\n  const { data } = await supabaseAdmin.storage.from('avatars').upload(file.name, file);\n  return data.path;\n}",
  "const { data: rows } = await supabase.rpc('search', { q });\nreturn rows.map(toResult);",
  "await supabase.from('events').insert({ type });",
  "import { createClient } from '@/utils/supabase/server';\nconst { data } = await (await createClient()).from('t').select();",
  "import { createClient } from '@supabase/supabase-js';\nconst db = createClient(url, key);\nexport const load = async () => { const { data } = await db.from('profiles').select(); return data; };",
];

export const good = [
  "const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();\nif (error) throw error;",
  "const { data } = await supabase.from('posts').select().throwOnError();",
  "const { data } = await api.get('/posts');",
  "const { data, ...rest } = await supabase.rpc('stats');\nreport(rest);",
  "const { data } = await axios.get(`/api/supabase-status`);",
  "const { data: { user } } = await supabase.auth.getUser();\nif (!user) redirect('/login');",
  "const { error } = await supabase.from('events').insert({ type });\nif (error) throw error;",
  "await supabase.from('events').insert({ type }).throwOnError();",
];
