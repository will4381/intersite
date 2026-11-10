// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";
import { bindings } from "./names.mjs";

const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/** Bindings a file needs before its majority counts as its style. */
const MIN = 10;

export const id = "no-mixed-case-style";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      found: "{{name}} is snake_case in a file that names its bindings in camelCase ({{camel}} of {{total}}), which is how pasted or generated code shows. Rename it {{fixed}}.",
    },
  },
  createOnce(context) {
    /** @type {any[]} */ let snake = [];
    let camel = 0;
    /** @type {Set<string>} keys of object literals and types, whose spelling belongs to the data */
    let keys = new Set();
    const declared = bindings((id, how) => {
      if (how === "destructured") return;
      if (CAMEL.test(id.name)) camel++;
      else if (SNAKE.test(id.name)) snake.push(id);
    });
    return {
      before() {
        [snake, camel, keys] = [[], 0, new Set()];
        return !isTestFile(context);
      },
      ...declared,
      "Property, TSPropertySignature"(node) {
        if (node.key?.type === "Identifier") keys.add(node.key.name);
        else if (node.key?.type === "Literal") keys.add(String(node.key.value));
      },
      // `body.suite_selections = …` and `Body["suite_selections"]` name a payload field too.
      "MemberExpression[computed=false] > Identifier.property"(node) {
        keys.add(node.name);
      },
      "TSIndexedAccessType > TSLiteralType > Literal"(node) {
        keys.add(String(node.value));
      },
      "Program:exit"() {
        const own = snake.filter((id) => !keys.has(id.name));
        const total = camel + own.length;
        // ponytail: a file counts as camelCase at 10+ camel bindings and at most 1 in 5 snake; tuned on the corpus
        if (camel < MIN || own.length > total / 5) return;
        for (const id of own) {
          const fixed = id.name.replace(/_([a-z0-9])/g, (/** @type {string} */ _, /** @type {string} */ c) => c.toUpperCase());
          context.report({ node: id, messageId: "found", data: { name: id.name, camel: String(camel), total: String(total), fixed } });
        }
      },
    };
  },
});

const camelLines = "const firstName = a;\nconst lastName = b;\nconst fullName = c;\nconst userEmail = d;\nconst userPhone = e;\nconst homeCity = f;\nconst workCity = g;\nconst startDate = h;\nconst endDate = i;\nconst isActive = j;\n";

export const bad = [`${camelLines}const total_count = 0;\nexport { total_count };`];

export const good = [
  `${camelLines}export const payload = { total_count: 0 };\nconst total_count = payload.total_count;`,
  `${camelLines}export function read({ total_count }: Row) { return total_count; }`,
  `${camelLines}let suite_selections: Body["suite_selections"];\nexport const selections = () => suite_selections;`,
  "const total_count = 1;\nconst page_size = 2;\nexport const sum = total_count + page_size;",
];
