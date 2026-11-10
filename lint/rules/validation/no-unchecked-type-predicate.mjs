// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";

// Targets an existence or object test does prove.
const SHALLOW_TARGET = /^TS(Unknown|Object|String|Number|Boolean|BigInt|Symbol|Null|Undefined)Keyword$/;

/**
 * A parameter typed so the compiler knows nothing: unknown, any, object, or no annotation on a function that is not a
 * callback (`.filter((x): x is T => x != null)` takes its parameter type from the array).
 * @param {any} param @param {any} fn
 */
function untyped(param, fn) {
  const t = param?.typeAnnotation?.typeAnnotation;
  if (!t) return fn.parent?.type !== "CallExpression";
  return /^TS(Unknown|Any|Object)Keyword$/.test(t.type) || (t.type === "TSTypeReference" && t.typeName.name === "Object");
}

/** A predicate target with a shape: a named type or object type other than Record<string, unknown>. @param {any} t */
function hasShape(t) {
  if (!t || SHALLOW_TARGET.test(t.type)) return false;
  const name = t.type === "TSTypeReference" ? t.typeName.name : "";
  if (/^(Record|Readonly|Array|ReadonlyArray|NonNullable|Exclude|Extract)$/.test(name)) return false;
  if (t.type === "TSTypeLiteral") return t.members.some((/** @type {any} */ m) => m.typeAnnotation?.typeAnnotation.type !== "TSUnknownKeyword");
  return /^TS(TypeReference|TypeLiteral|IntersectionType)$/.test(t.type);
}

/**
 * True when an expression only tests that `name` exists or is an object: `true`, `x`, `!!x`, `Boolean(x)`, `x != null`,
 * `typeof x === "object"`, joined with &&. Reading a field, `in`, or calling a helper is a real check.
 * @param {any} e @param {string} name
 */
function shallow(e, name) {
  if (!e) return false;
  if (e.type === "Literal") return e.value === true;
  if (e.type === "Identifier") return e.name === name;
  if (e.type === "UnaryExpression") return (e.operator === "!" || e.operator === "typeof") && shallow(e.argument, name);
  if (e.type === "CallExpression") return e.callee.name === "Boolean" && shallow(e.arguments[0], name);
  if (e.type === "LogicalExpression") return e.operator === "&&" && shallow(e.left, name) && shallow(e.right, name);
  if (e.type === "BinaryExpression" && e.operator === "instanceof") return e.right.name === "Object" && shallow(e.left, name);
  if (e.type === "BinaryExpression" && /^[!=]==?$/.test(e.operator)) {
    const literal = (/** @type {any} */ n) => n.type === "Literal" || (n.type === "Identifier" && n.name === "undefined");
    return (shallow(e.left, name) && literal(e.right)) || (literal(e.left) && shallow(e.right, name));
  }
  return false;
}

/** Every value the function returns: the arrow's expression body, or each `return`. @param {any} fn */
function returned(fn) {
  if (fn.body.type !== "BlockStatement") return [fn.body];
  /** @type {any[]} */
  const values = [];
  walk(fn.body, (n) => {
    if (n.type === "ReturnStatement") values.push(n.argument);
  });
  return values;
}

/** An asserts function body that can never throw: no throw and no call that might (logging aside). @param {any} fn */
function neverThrows(fn) {
  let found = false;
  walk(fn.body, (n) => {
    if (n.type === "ThrowStatement" || n.type === "NewExpression" || (n.type === "CallExpression" && n.callee.object?.name !== "console")) found = true;
  });
  return !found;
}

export const id = "no-unchecked-type-predicate";
export const pack = "types";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      predicate: "This type guard tells the compiler the value is {{type}}, but it only checks that the value exists. The compiler trusts a guard without reading it, so every caller now skips checks it needed. Check the fields the code relies on (or parse with a schema and return result.success).",
      asserts: "This assertion function never throws, so it asserts nothing: callers are told the value is checked when it is not. Throw when the check fails, or parse with a schema.",
    },
  },
  createOnce(context) {
    /** @param {any} fn */
    function check(fn) {
      const predicate = fn.returnType?.typeAnnotation;
      if (predicate?.type !== "TSTypePredicate") return;
      if (predicate.asserts) {
        if (fn.body && neverThrows(fn)) context.report({ node: predicate, messageId: "asserts" });
        return;
      }
      const name = predicate.parameterName?.name;
      const target = predicate.typeAnnotation?.typeAnnotation;
      const param = fn.params.find((/** @type {any} */ p) => p.name === name);
      if (!fn.body || !param || !untyped(param, fn) || !hasShape(target)) return;
      const values = returned(fn);
      if (values.length && values.every((v) => shallow(v, name))) {
        context.report({ node: predicate, messageId: "predicate", data: { type: context.sourceCode.getText(target).slice(0, 40) } });
      }
    }
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
});

export const bad = [
  "function isUser(value: unknown): value is User { return true; }",
  "const isUser = (value: unknown): value is User => !!value;",
  "function isOrder(input: any): input is Order { return typeof input === 'object' && input !== null; }",
  "function isEvent(data): data is WebhookEvent { return Boolean(data); }",
  "function assertUser(value: unknown): asserts value is User { if (typeof value !== 'object') console.warn('not a user'); }",
  "const isPayload = (body: unknown): body is { id: string; amount: number } => body != null;",
  "function isUser(v: unknown): v is User { return v instanceof Object; }",
];

export const good = [
  "function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }",
  "function isUser(value: unknown): value is User { return isRecord(value) && typeof value.id === 'string'; }",
  "const isPet = (p: Pet | undefined): p is Pet => p !== undefined;",
  "function isFile(answer: string | FileAnswer): answer is FileAnswer { return typeof answer === 'object'; }",
  "function assertUser(value: unknown): asserts value is User { if (!isUser(value)) throw new Error('not a user'); }",
  "function assertUser(value: unknown): asserts value is User { UserSchema.parse(value); }",
  "function isUser(value: unknown): value is User { return UserSchema.safeParse(value).success; }",
  "const pets = list.filter((p): p is Pet => p !== undefined);",
  "const defined = (value: unknown): value is NonNullable<unknown> => value != null;",
];
