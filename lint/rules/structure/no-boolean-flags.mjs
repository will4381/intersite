// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

/** @param {any} node */
const isBooleanLiteral = (node) => node?.type === "Literal" && typeof node.value === "boolean";

export const id = "no-boolean-flags";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      call: "This call passes {{count}} bare true/false arguments; nobody reading it can tell which flag is which without opening the function. Take one options object with named fields ({ notify: true, force: false }), or split the function into the variants callers actually use.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context),
      // ponytail: also reports APIs the project cannot change (`event.initEvent(type, true, true)`); an allowlist if they show up.
      "CallExpression, NewExpression"(node) {
        const count = node.arguments.filter(isBooleanLiteral).length;
        if (count >= 2) context.report({ node, messageId: "call", data: { count: String(count) } });
      },
    };
  },
});

export const bad = [
  "export const user = createUser('ada', true, false);",
  "export const view = action('Unsubscribe from everything', false, true, 'secondary');",
  "export const panel = new Panel(root, false, true, 300);",
];

export const good = [
  "export const user = createUser('ada', { admin: true, verified: false });",
  "el.addEventListener('scroll', onScroll, true);",
  "export const view = render(view, animate, compact);",
  "export const ok = check(a === b, c > d);",
];
