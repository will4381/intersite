// @ts-check
import { defineRule } from "@oxlint/plugins";

const LIMIT = 5;

export const id = "max-params";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      many: `This function takes {{count}} parameters (limit ${LIMIT}); at the call site they are a row of unlabeled values that are easy to pass in the wrong order. Pass one object with named fields, or split the function where it does two jobs.`,
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      // A TypeScript `this` parameter is a type annotation, not an argument.
      const count = node.params.filter((/** @type {any} */ p) => !(p.type === "Identifier" && p.name === "this")).length;
      if (count > LIMIT) context.report({ node: node.id ?? node, messageId: "many", data: { count: String(count) } });
    }
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
});

export const bad = [
  "export function createUser(name, email, role, team, active, locale) { return { name, email, role, team, active, locale }; }",
  "export const send = (to, from, subject, body, cc, bcc, replyTo) => mail({ to, from, subject, body, cc, bcc, replyTo });",
  "export class Report { build(from: Date, to: Date, team: string, format: string, currency: string, timezone: string) { return [from, to, team, format, currency, timezone]; } }",
];

export const good = [
  "export function createUser({ name, email, role, team, active, locale }) { return { name, email, role, team, active, locale }; }",
  "export function between(value: number, min: number, max: number, step: number, wrap: boolean) { return [value, min, max, step, wrap]; }",
  "export function handler(this: Window, a: number, b: number, c: number, d: number, e: number) { return a + b + c + d + e + this.length; }",
];
