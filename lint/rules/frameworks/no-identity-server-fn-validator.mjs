// @ts-check
import { defineRule } from "@oxlint/plugins";

import { chainRoot } from "./syntax.mjs";

export const id = "no-identity-server-fn-validator";
export const pack = "start";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      identity: "This validator returns its input unchanged, so it only gives `data` a TypeScript type. A server function is a public HTTP endpoint and anyone can call it with any payload. Validate at runtime: pass a schema (.validator(z.object({ ... }))) or check each field and throw on bad input.",
    },
  },
  createOnce(context) {
    return {
      // `createServerFn().validator((input: Invite) => input)`
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        const fn = /** @type {any} */ (node.arguments[0]);
        if (callee.type !== "MemberExpression" || !/^(validator|inputValidator)$/.test(callee.property.name ?? "")) return;
        if (!/^(Arrow)?FunctionExpression$/.test(fn?.type ?? "") || fn.params.length !== 1 || fn.params[0].type !== "Identifier") return;
        let body = fn.body;
        if (body.type === "BlockStatement" && body.body.length === 1 && body.body[0].type === "ReturnStatement") body = body.body[0].argument;
        while (body?.type === "TSAsExpression" || body?.type === "TSSatisfiesExpression") body = body.expression;
        if (body?.type !== "Identifier" || body.name !== fn.params[0].name) return;
        const root = chainRoot(callee.object);
        if (root?.type === "Identifier" && root.name === "createServerFn") context.report({ node: fn, messageId: "identity" });
      },
    };
  },
});

export const bad = [
  "const loadInvite = createServerFn().validator((invite: Invite) => invite).handler(({ data }) => getInvite(data.token));",
  "export const rename = createServerFn({ method: 'POST' })\n  .middleware([auth])\n  .inputValidator((input: { id: string; name: string }) => input)\n  .handler(async ({ data }) => db.update(items).set({ name: data.name }).where(eq(items.id, data.id)));",
  "const save = createServerFn({ method: 'POST' }).validator((d: unknown) => {\n  return d as Draft;\n}).handler(({ data }) => store(data));",
  "const save = createServerFn().validator(function (d: Draft) { return d; }).handler(({ data }) => store(data));",
];

export const good = [
  "const loadInvite = createServerFn().validator(z.object({ token: z.string() })).handler(({ data }) => getInvite(data.token));",
  "const loadInvite = createServerFn().validator((input: unknown) => Invite.parse(input)).handler(({ data }) => getInvite(data.token));",
  "const loadCode = createServerFn().validator((code: string) => {\n  if (!/^[a-z0-9]{6}$/.test(code)) throw new Error('Bad code');\n  return code;\n}).handler(({ data }) => lookup(data));",
  "const form = useForm({ validator: (values: Values) => values });",
];
