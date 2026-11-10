// @ts-check
import { defineRule } from "@oxlint/plugins";

export const id = "no-function-class";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      function: "{{name}} holds no state and has one method, so callers must construct an instance just to call {{method}}(), which is really a function. Export a function named for what {{method}} does.",
    },
  },
  createOnce(context) {
    return {
      "ClassDeclaration, ClassExpression"(node) {
        // A subclass, a decorated class or an implementation of an interface takes part in a contract a function cannot.
        if (node.superClass || node.implements?.length || node.decorators?.length || node.abstract || node.declare) return;
        const members = node.body.body;
        if (members.length !== 1) return;
        const [method] = members;
        // A method, or a property holding an arrow function (`send = (to) => mail(to)`).
        const fn = method.type === "MethodDefinition" ? method.kind === "method" && method.value : method.type === "PropertyDefinition" && method.value?.type.endsWith("FunctionExpression") && method.value;
        // No body: an ambient declaration in a .d.ts file describes a class defined elsewhere.
        if (!fn?.body || method.static || method.key.type !== "Identifier") return;
        // A method using `this` reaches state set elsewhere (by a caller, or a prototype trick); leave it.
        if (/\bthis\b/.test(context.sourceCode.getText(fn.body))) return;
        context.report({ node: node.id ?? node, messageId: "function", data: { name: node.id?.name ?? "This class", method: method.key.name } });
      },
    };
  },
});

export const bad = [
  "export class PriceCalculator {\n  calculate(items: { cents: number }[]) { return items.reduce((sum, item) => sum + item.cents, 0); }\n}",
  "export class EmailValidator { validate(email: string) { return /@/.test(email); } }",
  "export class Mailer { send = (to: string) => mail(to); }",
  "export default class { double(x: number) { return x * 2; } }",
  "export default class ReportGenerator {\n  async generate(rows: string[]) {\n    const body = rows.join('\\n');\n    return { body, size: body.length };\n  }\n}",
];

export const good = [
  "export function calculatePrice(items: { cents: number }[]) { return items.reduce((sum, item) => sum + item.cents, 0); }",
  "export class Counter {\n  count = 0;\n  increment() { this.count++; }\n}",
  "export class ValidationError extends Error { describe() { return 'invalid'; } }",
  "export class RetryPolicy implements Policy { next(attempt: number) { return attempt * 1000; } }",
  "export class Cache {\n  constructor(private readonly store: Map<string, string>) {}\n  get(key: string) { return this.store.get(key); }\n}",
  "export class Clock { now = () => Date.now() + this.offset; }",
  "export class Timer { static start() { return Date.now(); } }",
];
