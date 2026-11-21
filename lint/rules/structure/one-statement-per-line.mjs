// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isGenerated } from "../shared.mjs";

/** Lists of statements: a block, a program, a switch case's body. */
const BODIES = ["BlockStatement", "Program", "StaticBlock", "SwitchCase"];
const JUMPS = new Set(["BreakStatement", "ContinueStatement", "ReturnStatement", "ThrowStatement"]);

export const id = "one-statement-per-line";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      crammed: "This statement starts on the line the previous one ends on. Readers scan down the left edge and miss it, and a diff that changes one changes both. Put each statement on its own line (a formatter such as Prettier does this).",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      const list = node.type === "SwitchCase" ? node.consequent : node.body;
      for (let i = 1; i < list.length; i++) {
        const [before, statement] = [list[i - 1], list[i]];
        // A jump after one statement (`case "a": run(); break;`, `if (bad) { log(x); continue; }`) ends that statement's
        // story on its line, by long habit; an empty `;` is nothing.
        if (JUMPS.has(statement.type) || statement.type === "EmptyStatement" || before.type === "EmptyStatement") continue;
        if (before.loc.end.line === statement.loc.start.line) context.report({ node: statement, messageId: "crammed" });
      }
    }
    return {
      before: () => !isGenerated(context),
      ...Object.fromEntries(BODIES.map((type) => [type, check])),
    };
  },
});

export const bad = [
  "export async function reject(id: string) {\n  const rejected = await select(id); assert.equal(rejected.status, 403);\n}",
  "const a = 1; const b = 2;\nexport const sum = a + b;",
  "export const reset = () => { cache.clear(); seen.clear(); };",
];

export const good = [
  "export async function reject(id: string) {\n  const rejected = await select(id);\n  assert.equal(rejected.status, 403);\n}",
  "export function kind(k: string) {\n  switch (k) {\n    case 'a': run(); break;\n    default: return 0;\n  }\n}",
  "export const first = (items: number[]) => (items.length ? items[0] : 0);",
  "export function total(rows: Row[]) {\n  let sum = 0;\n  for (const r of rows) {\n    if (r.void) { skipped++; continue; }\n    sum += r.amount;\n  }\n  return sum;\n}",
];
