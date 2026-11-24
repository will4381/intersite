// @ts-check
import { defineRule } from "@oxlint/plugins";

import { notShipped } from "../shared.mjs";

/** `unknown`, `any`, `object`, `{}` or `Record<string, unknown | any>`: a type that says nothing about the value. */
export function saysNothing(/** @type {any} */ type) {
  if (!type) return false;
  if (/^TS(Unknown|Any|Object)Keyword$/.test(type.type)) return true;
  if (type.type === "TSTypeLiteral" && !type.members.length) return true;
  const args = type.typeArguments?.params ?? type.typeParameters?.params;
  return type.type === "TSTypeReference" && type.typeName?.name === "Record" && args?.length === 2 && /^TS(Unknown|Any)Keyword$/.test(args[1].type);
}

/**
 * A cast to a shape whose every field may be missing (`Partial<Frame>`, `{ error?: { code?: unknown } } | null`): the
 * first step of checking a value field by field, not a claim about it.
 * @param {any} type
 */
function tentative(type) {
  if (type.type === "TSUnionType") return type.types.every((/** @type {any} */ t) => /^TS(Null|Undefined)Keyword$/.test(t.type) || tentative(t));
  if (type.type === "TSTypeReference") return type.typeName?.name === "Partial";
  return type.type === "TSTypeLiteral" && type.members.length > 0 && type.members.every((/** @type {any} */ m) => m.optional);
}

/** The function (or program) a node is in. @param {any} node */
function owner(node) {
  for (let n = node.parent; n; n = n.parent) if (/Function|Program/.test(n.type)) return n;
  return undefined;
}

export const id = "no-widen-then-assert";
export const pack = "types";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ name }}` was declared as `{{ wide }}`, then cast to `{{ type }}`: the declaration threw away what the value is, and the cast claims it back with nothing checked in between. Parse or check the value into `{{ type }}` where it comes in (a schema, a type guard), or keep its real type from the start.",
    },
  },
  createOnce(context) {
    /** @type {Map<string, { owner: any, wide: string, checked?: boolean }>} */
    let widened = new Map();
    /** @param {any} node */
    const cast = (node) => {
      const value = node.expression;
      const type = node.typeAnnotation;
      if (value.type !== "Identifier" || saysNothing(type) || tentative(type) || type.typeName?.name === "const") return;
      const known = widened.get(value.name);
      if (!known || known.checked || known.owner !== owner(node)) return;
      context.report({ node, messageId: "found", data: { name: value.name, wide: known.wide, type: context.sourceCode.getText(type).slice(0, 40) } });
    };
    return {
      before() {
        widened = new Map();
        return !notShipped(context);
      },
      VariableDeclarator(/** @type {any} */ node) {
        const type = node.id.typeAnnotation?.typeAnnotation;
        if (node.parent.kind !== "const" || node.id.type !== "Identifier" || !node.init || !saysNothing(type)) return;
        widened.set(node.id.name, { owner: owner(node), wide: context.sourceCode.getText(type).slice(0, 40) });
      },
      // `typeof value === "object"` or `"id" in value` before the cast: the value was checked, if only partly.
      UnaryExpression(/** @type {any} */ node) {
        const known = node.operator === "typeof" && node.argument.type === "Identifier" && widened.get(node.argument.name);
        if (known) known.checked = true;
      },
      BinaryExpression(/** @type {any} */ node) {
        const known = node.operator === "in" && node.right.type === "Identifier" && widened.get(node.right.name);
        if (known) known.checked = true;
      },
      TSAsExpression: cast,
      TSTypeAssertion: cast,
    };
  },
});

export const bad = [
  "export async function load(res: Response) {\n  const data: unknown = await res.json();\n  return data as Order;\n}",
  "export function read(raw: string) {\n  const parsed: any = JSON.parse(raw);\n  const user = parsed as User;\n  return user.id;\n}",
  "export function settings(input: Input) {\n  const values: Record<string, unknown> = { ...input };\n  return <Settings>values;\n}",
];

export const good = [
  "export async function load(res: Response) {\n  const data: unknown = await res.json();\n  return OrderSchema.parse(data);\n}",
  "export function read(raw: string) {\n  const parsed: unknown = JSON.parse(raw);\n  if (!isUser(parsed)) throw new Error('bad user');\n  return parsed.id;\n}",
  "export function first(rows: Row[]) {\n  const row = rows[0];\n  return row as Row;\n}",
  "const value: unknown = load();\nexport function other() {\n  const value = make();\n  return value as Thing;\n}",
  "export const ROUTES = { home: '/' } as const;",
  "export function load(raw: string) {\n  const parsed: unknown = JSON.parse(raw);\n  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) return null;\n  return parsed as Config;\n}",
  "export function parse(data: string) {\n  const value: unknown = JSON.parse(data);\n  const frame = value as Partial<Frame>;\n  return frame.version === 1;\n}",
  "export function code(body: unknown) {\n  const parsed: unknown = body;\n  return (parsed as { error?: { code?: unknown } } | null)?.error?.code;\n}",
];
