// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Whether an assignment only sets the value up: it sits under `if (!NAME)` (a lazy cache, run once), or outside every
 * function (module setup such as `if (process.env.STAGING) BASE_URL = …`), so the value never changes after.
 * @param {any} id
 */
function setup(id) {
  for (let n = id.parent; n; n = n.parent) {
    if (n.type === "IfStatement" && n.test.type === "UnaryExpression" && n.test.operator === "!" && n.test.argument.name === id.name) return true;
    if (/Function/.test(n.type)) return false;
  }
  return true;
}

export const id = "no-reassigned-constant";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "{{name}} is named like a constant (UPPER_SNAKE_CASE) but reassigned here, so readers trust a value that changes under them. Make it a real constant, or name it in camelCase so it reads as state.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    const check = (node) => UPPER_SNAKE.test(node?.name ?? "") && !setup(node) && context.report({ node, messageId: "found", data: { name: node.name } });
    return {
      // Tests reset fixtures in beforeEach; `??=` and `||=` fill a lazy cache once, which still reads as a constant.
      before: () => !isTestFile(context),
      AssignmentExpression: (node) => node.left.type === "Identifier" && !/^(?:\?\?|\|\||&&)=$/.test(node.operator) && check(node.left),
      UpdateExpression: (node) => node.argument.type === "Identifier" && check(node.argument),
    };
  },
});

export const bad = [
  "let MAX_RETRIES = 3;\nexport function reset() { MAX_RETRIES = 5; }",
  "let REQUEST_COUNT = 0;\nexport const track = () => REQUEST_COUNT++;",
];

export const good = [
  "export const MAX_RETRIES = 3;",
  "let requestCount = 0;\nexport const track = () => requestCount++;",
  "export const LIMITS = { max: 3 };\nLIMITS.max = 4;",
  "let KIT_NAMES;\nexport const kit = () => (KIT_NAMES ??= load());",
  "let BASE_URL = 'https://api.example.com';\nif (process.env.STAGING) BASE_URL = 'https://staging.example.com';\nexport const url = () => BASE_URL;",
  "let ERROR_CODES;\nexport function codes() {\n  if (!ERROR_CODES) {\n    ERROR_CODES = new Set(load());\n  }\n  return ERROR_CODES;\n}",
];
