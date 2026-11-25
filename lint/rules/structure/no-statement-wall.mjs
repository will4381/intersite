// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isGenerated, isTestFile } from "../shared.mjs";

// A wall is this many statements over this many lines with nothing between them. Tuned on nine repositories: some
// teams write without blank lines by choice, and at 12 statements over 20 lines one flagged 457 functions; this flags
// the runs no house style makes readable.
const STATEMENTS = 20;
const LINES = 40;

export const id = "no-statement-wall";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      wall: `These {{count}} statements run {{lines}} lines with no blank line or comment between them, so a reader cannot see where one step ends and the next begins. Put a blank line between the steps (setup, the work, the result), or move a step into a named function.`,
    },
  },
  createOnce(context) {
    /** @type {string[]} */
    let lines = [];
    /** Whether a blank or comment-only line sits between two statements. @param {any} a @param {any} b */
    const parted = (a, b) => {
      for (let line = a.loc.end.line; line < b.loc.start.line - 1; line++) {
        const t = lines[line].trim();
        if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return true;
      }
      return false;
    };
    return {
      before() {
        lines = context.sourceCode.lines ?? context.sourceCode.text.split("\n");
        // Tests are setup and assertions in a row by nature; generated code is the generator's to shape.
        return !isTestFile(context) && !isGenerated(context);
      },
      /** A function's body or a block inside one; module scope is imports and declarations. @param {any} node */
      BlockStatement(node) {
        let fn = node.parent;
        while (fn && !FUNCTIONS.has(fn.type) && fn.type !== "Program") fn = fn.parent;
        if (!fn || fn.type === "Program") return;
        const body = node.body;
        for (let start = 0, i = 1; i <= body.length; i++) {
          if (i < body.length && !parted(body[i - 1], body[i])) continue;
          const count = i - start;
          const span = body[i - 1].loc.end.line - body[start].loc.start.line + 1;
          // One-line statements of one kind (route registrations, declarations) are a list, which reads fine.
          const run = body.slice(start, i);
          const list = run.every((/** @type {any} */ n) => n.type === run[0].type && n.loc.start.line === n.loc.end.line);
          if (count >= STATEMENTS && span >= LINES && !list) context.report({ node: body[start], messageId: "wall", data: { count: String(count), lines: String(span) } });
          start = i;
        }
      },
    };
  },
});

const steps = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `  const v${i} = read(input, ${i});`).join("\n");

export const bad = [
  `export function build(input) {\n${steps(42)}\n  send(v0);\n  return [v0, v41];\n}`,
  `export const run = async (input) => {\n  if (input) {\n${steps(16)}\n    await send({\n${Array.from({ length: 20 }, (_, i) => `      k${i}: v${i % 16},`).join("\n")}\n    });\n    log(v0);\n    log(v1);\n    log(v2);\n    log(v3);\n  }\n};`,
];

export const good = [
  `export function build(input) {\n${steps(21)}\n\n${steps(21).replaceAll("v", "w")}\n  return [v0, w0];\n}`,
  `export function build(input) {\n${steps(21)}\n  // The second half depends on the first being complete.\n${steps(21).replaceAll("v", "w")}\n  return [v0, w0];\n}`,
  `export function view(input) {\n  const rows = input.rows;\n  return {\n${Array.from({ length: 30 }, (_, i) => `    k${i}: rows[${i}],`).join("\n")}\n  };\n}`,
  `${steps(44).replaceAll("  const", "const")}\nexport default v0;`,
  `export function routes(app) {\n${Array.from({ length: 44 }, (_, i) => `  app.get("/r${i}", handlers[${i}]);`).join("\n")}\n}`,
];
