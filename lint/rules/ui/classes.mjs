// @ts-check
// Shared reading for the ui rules: Tailwind class words in any string, `style` objects, and files that are exempt.
import { relative } from "node:path";

import { isTestFile, unwrap } from "../shared.mjs";

// A class word: utilities, variants and arbitrary values. Prose fails on punctuation or a leading capital-then-space.
const CLASS_WORD = /^!?-?[a-z0-9@[][\w:[\]/.&>=%#()'",+*~^!@-]*$/;
const VAR_CALL = /(?:var|env)\([^()]*(?:\([^()]*\))?[^()]*\)/g;
// Emails, Open Graph images and PDFs render without the app's stylesheet, so inline literals are the only option.
const OWN_RENDERER = /^(?:next\/og|@vercel\/og|satori|@react-email\/|react-email|jsx-email|@react-pdf\/|mjml)/;
const OWN_RENDERER_FILE = /(?:^|\/)(?:emails?|og)\/|(?:^|\/)(?:opengraph-image|twitter-image|apple-icon|icon)\.[jt]sx?$/;
// Where the primitives live (shadcn's components/ui, a packages/ui kit): they define the look the tokens name.
const PRIMITIVES = /(?:^|\/)(?:components\/ui|packages\/ui|shared\/ui|src\/ui|design-system)\//;

export const HEX = /#[\da-f]{3,8}\b/i;
export const COLOR_FN = /(?<![a-z-])(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/i;

/** The value with every var()/env() reference removed, so `var(--x, #fff)` fallbacks and token mixes pass. @param {string} v */
export const withoutVars = (v) => v.replace(VAR_CALL, "");

/** The utility of a class word without variants, `!` or a leading `-`: `md:hover:!-mt-[3px]` -> `mt-[3px]`. @param {string} word */
export function utilityOf(word) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "[") depth++;
    else if (word[i] === "]") depth--;
    else if (word[i] === ":" && depth === 0) start = i + 1;
  }
  return word.slice(start).replace(/^!|!$/g, "").replace(/^-/, "");
}

/** `prefix-[value]` as [prefix, value], or undefined. @param {string} utility */
export function arbitrary(utility) {
  const m = /^([a-z][a-z0-9-]*?)-\[(.+)\](?:\/[\w.]+)?$/.exec(utility);
  return m ? [m[1], m[2]] : undefined;
}

/**
 * Visitors that call `check(utility, word, node)` for every word of every string that reads as a class list: all of
 * its words are class-shaped. Strings in class helpers, `className`, constants and cva maps are all covered. `hint`
 * must match a string before it is split, which keeps the rule cheap on the many strings that are not classes.
 * @param {RegExp} hint @param {(utility: string, word: string, node: any) => void} check
 */
export function eachClass(hint, check) {
  /** @param {string} text @param {any} node */
  const visit = (text, node) => {
    if (!hint.test(text)) return;
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length || !words.every((w) => CLASS_WORD.test(w))) return;
    for (const word of words) check(utilityOf(word), word, node);
  };
  return {
    Literal(/** @type {any} */ node) {
      if (typeof node.value === "string") visit(node.value, node);
    },
    TemplateElement(/** @type {any} */ node) {
      const text = node.value.cooked ?? node.value.raw;
      if (text) visit(text, node);
    },
  };
}

/** What the ui rules look through to a literal: `as X`, `satisfies X` and `!`, not `await`. */
export const CASTS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]);

/** The literal text of a string or number value, or undefined for anything computed. @param {any} node */
export function literalValue(node) {
  node = unwrap(node, CASTS);
  if (node?.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined;
  if (node?.type === "UnaryExpression" && node.operator === "-" && typeof node.argument.value === "number") return `-${node.argument.value}`;
  return undefined;
}

/** The property name of an object member, or undefined. @param {any} p */
export const keyName = (p) => (p.type !== "Property" || p.computed && p.key.type !== "Literal" ? undefined : p.key.name ?? String(p.key.value));

/**
 * Visitors that call `check(object)` for every style object: a JSX `style={{ ... }}` and an object typed or checked as
 * `CSSProperties`. Only in files that also use `className`: a file styled purely inline is markup for a renderer with
 * no stylesheet (Satori, email, a PDF) imported from elsewhere, or a project with no class system to move to.
 * @param {any} context @param {(object: any, attribute?: any) => void} check `attribute` is the JSX `style` attribute, if any
 */
export function eachStyleObject(context, check) {
  let classes = false;
  return {
    Program() {
      classes = context.sourceCode.text.includes("className");
    },
    JSXAttribute(/** @type {any} */ node) {
      if (!classes) return;
      if (node.name?.name !== "style" || node.value?.type !== "JSXExpressionContainer") return;
      const object = unwrap(node.value.expression, CASTS);
      if (object?.type === "ObjectExpression") check(object, node);
    },
    VariableDeclarator(/** @type {any} */ node) {
      const type = node.id.typeAnnotation?.typeAnnotation;
      const name = type?.typeName?.right?.name ?? type?.typeName?.name;
      if (classes && name === "CSSProperties" && node.init?.type === "ObjectExpression") check(node.init);
    },
    TSSatisfiesExpression(/** @type {any} */ node) {
      const name = node.typeAnnotation?.typeName?.right?.name ?? node.typeAnnotation?.typeName?.name;
      if (classes && name === "CSSProperties" && node.expression.type === "ObjectExpression") check(node.expression);
    },
  };
}

/**
 * Whether the ui rules skip this file: tests and fixtures, and emails, OG images and PDFs (no stylesheet to use).
 * Optionally the primitives folder too. @param {any} context @param {{ primitives?: boolean }} [options]
 */
export function skipFile(context, { primitives = false } = {}) {
  if (isTestFile(context)) return true;
  const file = relative(context.cwd, context.filename);
  if (OWN_RENDERER_FILE.test(file) || (primitives && PRIMITIVES.test(file))) return true;
  return context.sourceCode.ast.body.some((/** @type {any} */ s) => s.type === "ImportDeclaration" && OWN_RENDERER.test(s.source.value));
}
