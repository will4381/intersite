// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

/** `sample` is left out: product samples and sample template variables are real domain data. */
const mockName = /^(?:mock|dummy|fake|placeholder)(?:[A-Z0-9_]|$)|^(?:MOCK|DUMMY|FAKE|PLACEHOLDER)_/;
/** An import of a mock module: `./mocks/users`, `../__mocks__/api`, `@/data/mock-data`, `./users.mock`. */
const mockModule = /(?:^|\/)(?:__mocks__|mocks?|mock-?data|fake-?data|dummy-?data)(?:\/|$)|[.-](?:mocks?|fakes?|dummy)(?:\.[cm]?[jt]sx?)?$/i;

/** Literal data: an array or object built only from literals, nested arrays and objects. @param {any} node */
function isLiteralData(node) {
  while (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression") node = node.expression;
  if (node?.type === "ArrayExpression") return node.elements.length > 0 && node.elements.every(isLiteralData);
  if (node?.type === "ObjectExpression") return node.properties.length > 0 && node.properties.every((/** @type {any} */ p) => p.type === "Property" && isLiteralData(p.value));
  return node?.type === "Literal" || (node?.type === "TemplateLiteral" && node.expressions.length === 0) || (node?.type === "UnaryExpression" && node.argument.type === "Literal");
}

export const id = "no-mock-data-in-source";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      declared: "{{name}} is made-up data in shipped code, so the screen looks finished while showing nothing real. Load the real data (and render an empty state when there is none), or move the sample into a test, story or fixture file.",
      imported: "This shipped file imports from a mock module ({{source}}), so users see fake data. Import the real data source; keep mocks in tests and stories.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context),
      VariableDeclarator(node) {
        let init = node.init;
        while (init?.type === "TSAsExpression" || init?.type === "TSSatisfiesExpression") init = init.expression;
        // A table or record, not one value: `placeholder = "Search"` is input hint text.
        if (init?.type !== "ArrayExpression" && init?.type !== "ObjectExpression") return;
        if (node.id.type === "Identifier" && mockName.test(node.id.name) && isLiteralData(init)) context.report({ node: node.id, messageId: "declared", data: { name: node.id.name } });
      },
      ImportDeclaration(node) {
        if (node.importKind !== "type" && mockModule.test(node.source.value)) context.report({ node, messageId: "imported", data: { source: node.source.value } });
      },
    };
  },
});

export const bad = [
  "export const mockUsers = [{ id: 1, name: 'Ada Lovelace', email: 'ada@example.com' }, { id: 2, name: 'Alan Turing', email: 'alan@example.com' }];",
  "const dummyStats = { revenue: 12450, growth: 0.12, customers: 342 };\nexport const Stats = () => dummyStats;",
  "import { orders } from '../mocks/orders';\nexport const Orders = () => orders;",
  "export const FAKE_PRODUCTS = [{ id: 'p1', title: 'Widget', price: 9.99 }] as const;",
];

export const good = [
  "export const sampleRate = 0.1;",
  "export const SAMPLE_STATUS_LABELS = { pending: 'Awaiting approval', shipped: 'Shipped' };",
  "export const placeholder = 'Search users';",
  "export const mockServer = setupServer(...handlers);",
  "import type { Order } from '../mocks/types';\nexport const empty: Order[] = [];",
  "export const fakeTimers = vi.useFakeTimers();",
  "export const emptyUsers = [];",
];
