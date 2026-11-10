// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isTestFile } from "../shared.mjs";

const LIMIT = 80;
/** Statements, not lines: a long data table, object literal or JSX tree is one statement and costs nothing. */
const STATEMENTS = ["ExpressionStatement", "VariableDeclaration", "ReturnStatement", "ThrowStatement", "IfStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "TryStatement"];

export const id = "max-function-statements";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      long: `This function runs {{count}} statements (limit ${LIMIT}, not counting the functions inside it), so it is doing several jobs at once. Split it into named steps that each do one job, and keep this function as the short sequence that calls them.`,
    },
  },
  createOnce(context) {
    /** @type {Map<any, number>} function -> its own statements, not those of functions inside it */
    let counts = new Map();

    /** @param {any} node */
    function count(node) {
      if (node.type === "VariableDeclaration" && node.parent.type.startsWith("For")) return;
      let fn = node.parent;
      while (fn && !FUNCTIONS.has(fn.type)) fn = fn.parent;
      if (fn) counts.set(fn, (counts.get(fn) ?? 0) + 1);
    }

    return {
      before() {
        counts = new Map();
        // Test files are long sequences of setup and assertions by nature.
        return !isTestFile(context);
      },
      ...Object.fromEntries(STATEMENTS.map((type) => [type, count])),
      "Program:exit"() {
        for (const [node, count] of counts) {
          if (count > LIMIT) context.report({ loc: { start: node.loc.start, end: node.body.loc.start }, messageId: "long", data: { count: String(count) } });
        }
      },
    };
  },
});

/** @param {number} n */
const many = (n) => Array.from({ length: n }, (_, i) => `  const v${i} = step(${i});`).join("\n");

export const bad = [
  `export function run() {\n${many(LIMIT + 1)}\n}`,
  `export const handler = async (event) => {\n${many(LIMIT)}\n  return event;\n}`,
  `export function route(req) {\n  switch (req.kind) {\n${Array.from({ length: LIMIT }, (_, i) => `    case ${i}: req.step(${i});`).join("\n")}\n  }\n}`,
];

export const good = [
  `export function Page() {\n  const onSave = () => {\n${many(LIMIT / 2)}\n  };\n  const onLoad = () => {\n${many(LIMIT / 2)}\n  };\n  return null;\n}`,
  `export function run() {\n${many(LIMIT - 1)}\n}`,
  `export const table = [\n${Array.from({ length: 300 }, (_, i) => `  { id: ${i}, label: "row ${i}" },`).join("\n")}\n];\nexport function find(id) { return table.find((row) => row.id === id); }`,
  `export function defaults() {\n  return {\n${Array.from({ length: 200 }, (_, i) => `    key${i}: { label: "Key ${i}", enabled: ${i % 2 === 0} },`).join("\n")}\n  };\n}`,
];
