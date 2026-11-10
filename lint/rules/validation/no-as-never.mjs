// @ts-check
import { defineRule } from "@oxlint/plugins";

import { notShipped } from "../shared.mjs";

export const id = "no-as-never";
export const pack = "types";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      never: "`as never` fits any type, so it switches off checking here exactly like `as any`. Fix the types so the value fits; for an exhaustive switch, assign to a never variable (const unreachable: never = value) instead of casting.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    const check = (node) => node.typeAnnotation.type === "TSNeverKeyword" && context.report({ node, messageId: "never" });
    // Test doubles cast to never all the time, and a wrong one fails the test.
    return { before: () => !notShipped(context), TSAsExpression: check, TSTypeAssertion: check };
  },
});

export const bad = [
  "handler(payload as never);",
  "const user = row as never;",
  "export const AuthContext = createContext(null as never);",
  "const user = <never>row;",
];

export const good = [
  "function assertNever(value: never): never { throw new Error(`unexpected ${value}`); }",
  "function label(s: Shape) { switch (s.kind) { case 'a': return 1; default: { const unreachable: never = s; return unreachable; } } }",
  "const user = row as User;",
];
