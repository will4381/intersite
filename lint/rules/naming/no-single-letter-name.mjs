// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

/** Letters with a conventional meaning: coordinates, sizes, loop counters, time, colour channels, a count. */
const CONVENTIONAL = /^[xyzwhijkntrgbae_$]$/;

export const id = "no-single-letter-name";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      found: "{{name}} is a one-letter name for {{what}}, so every caller and reader has to open it to learn what it does. Name it for its job.",
    },
  },
  createOnce(context) {
    /** @param {any} id @param {string} what */
    const check = (id, what) => {
      if (id?.type === "Identifier" && id.name.length === 1 && !CONVENTIONAL.test(id.name)) context.report({ node: id, messageId: "found", data: { name: id.name, what } });
    };
    return {
      before: () => !isTestFile(context),
      // Functions and exports only: callback parameters (`(a, b) => a - b`), loop variables, local temporaries and
      // module aliases (`const D = Prisma.Decimal`, `const s = z.string()`) are idiomatic.
      Program(node) {
        for (const s of node.body) {
          const exported = s.type === "ExportNamedDeclaration" ? s.declaration : undefined;
          if (exported?.type === "VariableDeclaration") for (const d of exported.declarations) check(d.id, d.init?.type?.endsWith("FunctionExpression") ? "a function" : "an export");
          if (s.type === "VariableDeclaration") for (const d of s.declarations) if (d.init?.type?.endsWith("FunctionExpression")) check(d.id, "a function");
        }
      },
      FunctionDeclaration(node) {
        check(node.id, "a function");
      },
    };
  },
});

export const bad = [
  "export const c = createClient({ url: process.env.DB_URL });",
  "function f(items: Item[]) { return items.filter(Boolean); }\nexport const clean = f;",
  "export const p = (value: number) => `${value}%`;",
];

export const good = [
  "export const sorted = list.sort((a, b) => a.rank - b.rank);",
  "for (let i = 0; i < 3; i++) step(i);",
  "export const x = 0;",
  "const D = Prisma.Decimal;\nexport const zero = new D(0);",
  "export function area(width: number) { const s = width * width; return s; }",
];
