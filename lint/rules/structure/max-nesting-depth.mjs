// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS } from "./paths.mjs";

const LIMIT = 4;
const NESTING = ["IfStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "TryStatement"];

/** Control-flow blocks around `node` up to its function. `else if` continues its `if`, so it adds no level. @param {any} node */
function depth(node) {
  let levels = 0;
  for (let n = node; n && !FUNCTIONS.has(n.type); n = n.parent) {
    if (!NESTING.includes(n.type)) continue;
    if (n.type === "IfStatement" && n.parent?.type === "IfStatement" && n.parent.alternate === n) continue;
    levels++;
  }
  return levels;
}

export const id = "max-nesting-depth";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      deep: `This block sits ${LIMIT + 1} control-flow levels deep, so reading it means holding every enclosing condition in your head. Return or continue early for the edge cases, or move the inner loop body into a named function.`,
    },
  },
  createOnce(context) {
    /** Reports the block that first crosses the limit, not each block inside it. @param {any} node */
    const check = (node) => depth(node) === LIMIT + 1 && context.report({ node, messageId: "deep" });
    return Object.fromEntries(NESTING.map((type) => [type, check]));
  },
});

export const bad = [
  "export function f(rows) {\n  for (const row of rows) {\n    if (row.ok) {\n      for (const cell of row.cells) {\n        if (cell.value) {\n          if (cell.value > 1) total(cell);\n        }\n      }\n    }\n  }\n}",
  "export function f(a, b, c, d, e) {\n  while (a) {\n    try {\n      switch (b) {\n        case 1:\n          if (c) {\n            for (const x of d) use(x);\n          }\n      }\n    } catch (error) { throw error; }\n  }\n}",
  "export const f = (xs) => {\n  if (xs) {\n    for (const x of xs) {\n      if (x) {\n        do {\n          if (x.next) x = x.next;\n        } while (x);\n      }\n    }\n  }\n};",
];

export const good = [
  "export function f(rows) {\n  for (const row of rows) {\n    if (!row.ok) continue;\n    for (const cell of row.cells) {\n      if (cell.value > 1) total(cell);\n    }\n  }\n}",
  "export function f(x) {\n  if (x === 1) a();\n  else if (x === 2) b();\n  else if (x === 3) c();\n  else if (x === 4) d();\n  else if (x === 5) { if (y) { if (z) e(); } }\n}",
  "export function f(groups) {\n  for (const g of groups) {\n    if (g.open) {\n      g.items.forEach((item) => {\n        if (item.ok) {\n          for (const tag of item.tags) {\n            if (tag) use(tag);\n          }\n        }\n      });\n    }\n  }\n}",
];
