// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, fromSource, isRequestInput, notShipped, unwrap } from "../shared.mjs";

// Schema calls whose result is the checked value (zod, valibot, yup, joi, superstruct `create`).
const PARSE = /^(parse|parseAsync|safeParse|safeParseAsync|validate|validateSync|validateAsync)$/;
// Receivers whose parse is not a schema: JSON.parse(text); used for its throw only, its result is not the point.
const NOT_SCHEMA = /^(JSON|Date|URL|path|Number|program|yargs|cli|argv|parser|marked|qs|querystring)$/;

/**
 * Raw data whose shape nothing has fixed: request input, a parsed body, or a parameter typed unknown or any (or a const
 * alias of one). A parse used as an assertion on an already typed value (a range check on a number) keeps nothing back.
 * @param {any} node @param {any} sourceCode
 */
function isRaw(node, sourceCode) {
  const untypedBody = (/** @type {any} */ n) => isRequestInput(n) || (n?.type === "CallExpression" && /^(json|parse)$/.test(calleeName(n)) && (calleeName(n) === "json" || n.callee.object?.name === "JSON"));
  if (fromSource(node, untypedBody, sourceCode)) return true;
  if (node.type !== "Identifier") return false;
  const variable = sourceCode.getScope(node).references.find((/** @type {any} */ r) => r.identifier === node)?.resolved;
  const def = variable?.defs[0];
  return def?.type === "Parameter" && /^TS(Unknown|Any)Keyword$/.test(def.name.typeAnnotation?.typeAnnotation.type ?? "");
}

/** The source text of a node, for comparing two reads of the same value. @param {any} context @param {any} node */
const text = (context, node) => context.sourceCode.getText(node);

export const id = "no-discarded-parse";
export const pack = "validation";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      discarded: "This throws away the parsed value and goes on using the raw `{{value}}`. The raw value still has the fields the schema strips, none of its transforms or defaults, and no type. Use the result: const input = schema.parse({{value}}), then read input. (safeParse and joi's validate do not even throw: check result.success or result.error.)",
    },
  },
  createOnce(context) {
    return {
      // A test parses a fixture to assert it is valid, then uses the fixture.
      before: () => !notShipped(context),
      ExpressionStatement(node) {
        const call = unwrap(node.expression);
        if (call?.type !== "CallExpression" || !PARSE.test(calleeName(call)) || call.callee.type !== "MemberExpression") return;
        if (NOT_SCHEMA.test(call.callee.object.name ?? "")) return;
        // valibot: v.parse(Schema, value)
        const arg = call.arguments[/^(v|valibot)$/.test(call.callee.object.name ?? "") && call.arguments.length === 2 ? 1 : 0];
        if (!arg || !/^(Identifier|MemberExpression)$/.test(arg.type) || !isRaw(arg, context.sourceCode)) return;
        // `schema.parse(body)` then `body` read again later in the same block.
        const block = /** @type {any} */ (node).parent;
        const later = block?.body?.slice(block.body.indexOf(node) + 1) ?? [];
        const raw = text(context, arg);
        const pattern = new RegExp(`(^|[^\\w.$])${raw.replace(/[.$]/g, "\\$&")}(?![\\w$])`);
        if (later.some((/** @type {any} */ s) => pattern.test(text(context, s)))) context.report({ node, messageId: "discarded", data: { value: raw } });
      },
    };
  },
});

export const bad = [
  "app.post('/users', async (req, res) => { CreateUser.parse(req.body); res.json(await db.user.create({ data: req.body })); });",
  "export async function POST(request: Request) { const body = await request.json(); InviteSchema.parse(body); await invite(body.email); return Response.json({ ok: true }); }",
  "async function save(input: unknown) { await schema.validate(input); return db.insert(input); }",
  "function handle(body: unknown) { Body.safeParse(body); return process(body); }",
  "export async function POST(request: Request) { const body = await request.json(); v.parse(Schema, body); await save(body); }",
];

export const good = [
  "app.post('/users', async (req, res) => { const input = CreateUser.parse(req.body); res.json(await db.user.create({ data: input })); });",
  "function check(text: string) { JSON.parse(text); return text; }",
  "function handle(body: unknown) { const result = Body.safeParse(body); if (!result.success) throw result.error; return process(result.data); }",
  "program.parse(process.argv); run(process.argv);",
  "function verify(body: unknown) { Body.parse(body); }",
  "function put(bytes: Uint8Array) { z.number().int().max(MAX).parse(bytes.byteLength); return upload(bytes); }",
  "function read(page: Page) { textSchema.parse(page.cursor); return load(page.cursor); }",
];
