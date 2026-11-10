// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";

// Changes to records that already exist. A public form may insert (a sign-up, a contact message); changing or deleting
// a row by an id the caller sent needs to know who the caller is.
const CHANGE = /^(update|updateMany|upsert|delete|deleteMany|destroy|remove|updateOne|deleteOne|findByIdAndUpdate|findOneAndUpdate|findByIdAndDelete|findOneAndDelete)$/;
// Database handles: `db`, `prisma`, `supabase`, `tx`, a Mongoose model (`User`), or a factory call (`db()`, `createClient()`).
const DATABASE = /^(db|database|prisma|supabase|sb|admin|tx|trx|transaction|knex|drizzle|sql|client|orm|em|repo|repository|collection|[A-Z]\w*)$/;
// Calls that establish who is calling: auth(), getSession, getUser, currentUser, requireAdmin, verifyToken, getClaims...
const IDENTITY = /auth|session|user|viewer|current|require|protect|guard|role|permission|admin|signed|login|claims|verif|owner|member|access|clerk/i;

/** @param {any} node */
function root(node) {
  while (node.type === "MemberExpression" || (node.type === "CallExpression" && node.callee.type === "MemberExpression") || node.type === "AwaitExpression")
    node = node.type === "MemberExpression" ? node.object : node.type === "CallExpression" ? node.callee.object : node.argument;
  return node;
}

/** @param {any} callee */
const calleeName = (callee) => callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && !callee.computed ? callee.property.name : "";

/** Every call inside `node`, callbacks included (`ids.map((id) => db.delete(...))`). @param {any} node */
function calls(node) {
  /** @type {any[]} */
  const out = [];
  walk(node, (n) => {
    if (n.type === "CallExpression") out.push(n);
  });
  return out;
}

/** @param {any} call */
function isChange(call) {
  if (call.callee.type !== "MemberExpression" || !CHANGE.test(call.callee.property.name)) return false;
  const base = root(call.callee.object);
  return base.type === "CallExpression" || (base.type === "Identifier" && DATABASE.test(base.name));
}

export const id = "no-unguarded-server-action";
export const pack = "next";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      unguarded: "This server action changes or deletes records without ever asking who is calling, and every server action is a public POST endpoint: anyone can call it with any id. Read the session first (const user = await requireUser()) and limit the write to rows that user owns; for a TanStack Start server function, add an auth middleware with .middleware([...]).",
    },
  },
  createOnce(context) {
    /** @param {any} fn @param {any} report @param {any[]} extra calls outside the function that also count, such as middleware */
    function check(fn, report, extra = []) {
      const all = calls(fn.body);
      if (!all.some(isChange)) return;
      if ([...all, ...extra].some((c) => IDENTITY.test(calleeName(c.callee)))) return;
      context.report({ node: report, messageId: "unguarded" });
    }
    /** @param {any} fn */
    const hasDirective = (fn) => fn.body?.type === "BlockStatement" && fn.body.body.some((/** @type {any} */ s) => s.directive === "use server");
    return {
      Program(node) {
        if (!node.body.some((/** @type {any} */ s) => s.directive === "use server")) return;
        for (const statement of /** @type {any[]} */ (node.body)) {
          const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : undefined;
          if (declaration?.type === "FunctionDeclaration") check(declaration, declaration.id ?? declaration);
          if (declaration?.type === "VariableDeclaration") {
            for (const d of declaration.declarations) if (d.init?.type?.endsWith("FunctionExpression")) check(d.init, d.id);
          }
        }
      },
      // An inline action: `async function save() { "use server"; ... }` inside a component.
      ":function"(node) {
        if (hasDirective(node) && !context.sourceCode.ast.body.some((/** @type {any} */ s) => s.directive === "use server")) check(node, /** @type {any} */ (node).id ?? node);
      },
      // TanStack Start: createServerFn(...).middleware([...]).handler(fn). next-safe-action: actionClient.use(mw).action(fn).
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        const fn = /** @type {any} */ (node.arguments[0]);
        if (callee.type !== "MemberExpression" || !fn?.type?.endsWith("FunctionExpression")) return;
        const chain = [];
        let root = callee.object;
        for (; root?.type === "CallExpression"; root = root.callee.type === "MemberExpression" ? root.callee.object : root.callee) chain.push(root);
        if (callee.property.name === "handler" && chain.some((c) => c.callee.type === "Identifier" && c.callee.name === "createServerFn")) {
          if (!chain.some((c) => calleeName(c.callee) === "middleware")) check(fn, callee.property);
        } else if (callee.property.name === "action" && context.sourceCode.ast.body.some((/** @type {any} */ s) => s.directive === "use server")) {
          // A client named for auth (`authActionClient`) or given middleware (`.use(...)`) knows the caller.
          if (!chain.some((c) => calleeName(c.callee) === "use") && !IDENTITY.test(root?.name ?? root?.property?.name ?? "")) check(fn, callee.property);
        }
      },
    };
  },
});

export const bad = [
  "'use server';\nexport async function deletePost(id: string) { await db.delete(posts).where(eq(posts.id, id)); }",
  "'use server';\nexport async function updateProfile(id: string, name: string) { await prisma.profile.update({ where: { id }, data: { name } }); revalidatePath('/profile'); }",
  "'use server';\nexport const removeItem = async (id: string) => { await (await createClient()).from('items').delete().eq('id', id); };",
  "export default function Page() { async function archive(formData: FormData) { 'use server'; await db.update(projects).set({ archived: true }).where(eq(projects.id, String(formData.get('id')))); } return null; }",
  "export const setPrice = createServerFn({ method: 'POST' }).validator(Price).handler(async ({ data }) => { await db().update(products).set({ price: data.price }).where(eq(products.id, data.id)); });",
  "'use server';\nexport const deletePost = actionClient.schema(Input).action(async ({ parsedInput }) => { await db.delete(posts).where(eq(posts.id, parsedInput.id)); });",
];

export const good = [
  "'use server';\nexport async function deletePost(id: string) { const session = await auth(); if (!session) throw new Error('unauthorized'); await db.delete(posts).where(and(eq(posts.id, id), eq(posts.authorId, session.user.id))); }",
  "'use server';\nexport async function subscribe(email: string) { await db.insert(subscribers).values({ email }); }",
  "'use server';\nexport async function updateProfile(name: string) { const { data: { user } } = await supabase.auth.getUser(); await supabase.from('profiles').update({ name }).eq('id', user.id); }",
  "export const setPrice = createServerFn({ method: 'POST' }).middleware([adminOnly]).validator(Price).handler(async ({ data }) => { await db().update(products).set({ price: data.price }).where(eq(products.id, data.id)); });",
  "export async function deletePost(id: string) { await db.delete(posts).where(eq(posts.id, id)); }",
  "'use server';\nexport async function clearDraft(key: string) { drafts.delete(key); }",
  "'use server';\nexport const deletePost = authActionClient.action(async ({ parsedInput, ctx }) => { await db.delete(posts).where(and(eq(posts.id, parsedInput.id), eq(posts.userId, ctx.userId))); });",
];
