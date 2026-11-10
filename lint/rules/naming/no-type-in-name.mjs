// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

const SUFFIX = /^(.*?[a-z0-9])(Boolean|Bool|Object|Obj|Array|Arr|String|Str)$/;
const KIND = { Boolean: "boolean", Bool: "boolean", Object: "object", Obj: "object", Array: "array", Arr: "array", String: "string", Str: "string" };
// The string form of something that is not a string (`queryString`, `dateStr`, `jsonString`) and typed arrays
// (`byteArray`) name a real distinction, not the type.
const FORMAT = /(?:json|query|date|time|iso|url|uri|base64|hex|search|connection|version|cron|format|style|class|path|csv|xml|html|svg|css|sql|encoded|serialized|raw|cookie|header|byte|typed|buffer|int\d*|uint\d*|float\d*|plain|global|target|source|ref|durable|sync)$/i;

/**
 * The kind of value a declaration evidently holds, from its type annotation or its initializer, or undefined.
 * @param {any} id @param {any} init
 */
function kindOf(id, init) {
  const t = id.typeAnnotation?.typeAnnotation;
  if (t?.type === "TSBooleanKeyword") return "boolean";
  if (t?.type === "TSStringKeyword") return "string";
  if (t?.type === "TSArrayType" || (t?.type === "TSTypeReference" && /^(?:Readonly)?Array$/.test(t.typeName?.name))) return "array";
  if (t?.type === "TSTypeLiteral" || t?.type === "TSObjectKeyword" || (t?.type === "TSTypeReference" && t.typeName?.name === "Record")) return "object";
  if (!init) return undefined;
  if (init.type === "Literal") return typeof init.value === "boolean" ? "boolean" : typeof init.value === "string" ? "string" : undefined;
  if (init.type === "TemplateLiteral") return "string";
  if (init.type === "ArrayExpression") return "array";
  if (init.type === "ObjectExpression") return "object";
  if (init.type === "UnaryExpression" && init.operator === "!") return "boolean";
  if (init.type === "BinaryExpression" && /^(?:[<>]=?|[!=]==?|instanceof|in)$/.test(init.operator)) return "boolean";
  return undefined;
}

export const id = "no-type-in-name";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      found: "{{name}} repeats its type in its name; the code already says it is {{article}} {{kind}}, so the suffix is noise readers must skip. Call it {{fixed}}.",
    },
  },
  createOnce(context) {
    /** @param {any} id @param {any} init */
    function check(id, init) {
      const m = id?.type === "Identifier" ? SUFFIX.exec(id.name) : null;
      if (!m || FORMAT.test(m[1])) return;
      const kind = KIND[/** @type {keyof typeof KIND} */ (m[2])];
      if (kindOf(id, init) === kind) context.report({ node: id, messageId: "found", data: { name: id.name, kind, article: /^[ao]/.test(kind) ? "an" : "a", fixed: m[1] } });
    }
    return {
      before: () => !isTestFile(context),
      VariableDeclarator: (node) => check(node.id, node.init),
      ":function"(fn) {
        for (const p of fn.params) check(p.type === "AssignmentPattern" ? p.left : p, p.type === "AssignmentPattern" ? p.right : undefined);
      },
    };
  },
});

export const bad = [
  "export const isLoadingBoolean = false;",
  "export const userDataObject = { id: 1, name: 'Ada' };",
  "export const resultArray: string[] = [];",
  "export function greet(nameString: string) { return `hi ${nameString}`; }",
  "export const hasAccessBool = role === 'admin';",
];

export const good = [
  "export const isLoading = false;",
  "export const queryString = `?page=${page}`;",
  "export const dateStr = '2026-01-01';",
  "export const byteArray: number[] = [];",
  "export const userObject = load();",
  "export function readString(input: string) { return input; }",
  "export const phoneNumber = '555-0100';",
];
