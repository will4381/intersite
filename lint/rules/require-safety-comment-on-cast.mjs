// @ts-check
import { defineRule } from "@oxlint/plugins";

/** Where a cast's comment may sit: before the cast, or before the statement or class field holding it. */
const OWNERS = new Set(["ExpressionStatement", "PropertyDefinition", "ReturnStatement", "ThrowStatement", "VariableDeclaration"]);
const SAFETY = /\bSAFETY\s*:/;

/** `x as const`, `<const>x`. @param {any} node */
const isConst = (node) => node.typeAnnotation.type === "TSTypeReference" && node.typeAnnotation.typeName.name === "const";

export const id = "require-safety-comment-on-cast";
export const pack = "comments";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      missing: "This cast tells TypeScript to trust a type it cannot check, and nothing says why that is true. State the invariant that makes it safe in a SAFETY: comment just before the cast or its statement, or remove the cast by parsing or narrowing the value.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      if (isConst(node)) return;
      for (let n = node; n; n = n.parent) {
        if (context.sourceCode.getCommentsBefore(n).some((/** @type {any} */ c) => c.end <= node.start && SAFETY.test(c.value))) return;
        // `// SAFETY: ...` above `export const x = y as T` sits before the export, one level above the declaration.
        if ((OWNERS.has(n.type) && !n.parent?.type.startsWith("Export")) || n.parent?.type === "Program") break;
      }
      context.report({ node, messageId: "missing" });
    }
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
});

export const bad = [
  "export const user = JSON.parse(text) as User;",
  "export function load(row: unknown) {\n  return row as Account;\n}",
  "// the API always sends a list\nexport const items = response.data as Item[];",
];

export const good = [
  "// SAFETY: the schema above rejected every other shape\nexport const user = JSON.parse(text) as User;",
  "export function load(row: unknown) {\n  // SAFETY: rows come from the accounts table, typed by its migration\n  return row as Account;\n}",
  "export const KINDS = ['draft', 'live'] as const;",
];
