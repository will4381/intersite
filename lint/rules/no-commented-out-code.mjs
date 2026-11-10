// @ts-check
import { Script } from "node:vm";

import { defineRule } from "@oxlint/plugins";

/** A line that reads as code: ends like a statement or opens/closes a block, or starts with a keyword. */
const codeEnd = /(?:[;{}[(,]|=>|\)|\]|\*\/)$/;
const codeStart = /^(?:(?:const|let|var|if|for|while|return|import|export|function|await|async|class|try|catch|else|switch|case|throw|new|break|continue|interface|type|enum)\b[\s({]|[})\]]|<\/?[A-Za-z][\w.]*[\s/>]|\w+(?:\.\w+)*\(.*\);?$|@\w+\()/;
/** Documentation that shows code on purpose, including a block under a prose heading such as `Renders:` or `Response shape:`. */
const documented = /@example|```|^\s*(?:e\.g\.|for example|usage|examples?)\b[^\n]*:\s*$|SPDX-License-Identifier|copyright \(c\)|licensed under|^[A-Z][\w ,'()/-]*:$/im;
/** A JSX element: opens with a tag and ends with a closing or self-closing tag. Its text children are not code-shaped. */
const jsxOpen = /^<[A-Za-z][\w.]*(?:[\s/>]|$)/;
const jsxClose = /(?:\/>|<\/[A-Za-z][\w.]*>)$/;

/** @param {string[]} text trimmed, non-empty lines */
const isJsx = (text) => jsxOpen.test(text[0]) && jsxClose.test(text.at(-1) ?? "") && text.filter((l) => /^<\/?[A-Za-z]/.test(l)).length >= 2;

/**
 * True when the text compiles as JavaScript in one of the shapes commented-out code takes: statements (possibly
 * with `await`/`return`), object members, or array/argument items. Compiled only, never run.
 * @param {string} code
 */
function compiles(code) {
  return [`async function* f() {\n${code}\n}`, `({\n${code}\n})`, `[\n${code}\n]`, `class C {\n${code}\n}`].some((wrapped) => {
    try {
      new Script(wrapped);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Removes TypeScript-only syntax that commented-out TS code commonly carries, so it can be compiled as JS:
 * `: Type` annotations before `=`, `,`, `)` or `;`, `as Type` casts and `!` non-null assertions.
 * @param {string} code
 */
const stripTypes = (code) =>
  code
    .replace(/(\w|\))\s*:\s*[A-Za-z_][\w.]*(?:<[^<>]*>)?(?:\[\])*(?:\s*\|\s*[\w.'"]+(?:\[\])*)*(?=\s*[=,);{])/g, "$1")
    .replace(/\s+as\s+[A-Za-z_][\w.]*(?:<[^<>]*>)?(?:\[\])*/g, "")
    .replace(/(\w|\))!(?=[.;,)\s])/g, "$1");

/**
 * True for a block of at least three lines that a reader would take for disabled code rather than prose.
 * @param {string[]} lines comment text, one entry per line, markers removed
 */
export function isCode(lines) {
  const text = lines.map((l) => l.trim()).filter(Boolean);
  if (text.length < 3 || documented.test(text.join("\n"))) return false;
  if (isJsx(text)) return true;
  const code = text.filter((l) => codeEnd.test(l) || codeStart.test(l)).length;
  if (code < 3 || code / text.length < 0.75) return false;
  const joined = text.join("\n");
  return compiles(joined) || compiles(stripTypes(joined));
}

export const id = "no-commented-out-code";
export const pack = "slop";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      code: "This is commented-out code. Delete it: version control keeps the old implementation, and a dead copy here drifts out of date and misleads readers.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const source = context.sourceCode;
        const lines = source.lines;
        /** @type {{ loc: any, text: string[] }[]} runs of whole-line `//` comments on consecutive lines */
        const runs = [];
        for (const comment of source.getAllComments()) {
          const { start, end } = comment.loc;
          const ownLine = !lines[start.line - 1].slice(0, start.column).trim();
          if (comment.type === "Line") {
            const last = runs.at(-1);
            if (ownLine && last && last.loc.end.line === start.line - 1 && last.loc.start.column === start.column) {
              last.text.push(comment.value);
              last.loc = { start: last.loc.start, end };
            } else if (ownLine) runs.push({ loc: { start, end }, text: [comment.value] });
            else runs.push({ loc: { start, end }, text: [] }); // a trailing comment ends the run
          } else if (!comment.value.startsWith("*")) {
            // `/* ... */`, not JSDoc: drop the ` * ` gutter some blocks keep.
            runs.push({ loc: { start, end }, text: comment.value.split("\n").map((l) => l.replace(/^\s*\*(?!\/)\s?/, "")) });
          }
        }
        for (const run of runs) if (isCode(run.text)) context.report({ loc: run.loc, messageId: "code" });
      },
    };
  },
});

export const bad = [
  "export function total(items) {\n  // const tax = rate * sum;\n  // if (tax > 0) {\n  //   return sum + tax;\n  // }\n  return items.length;\n}",
  "/*\nfunction legacyTotal(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\n*/\nexport const total = 1;",
  "export async function load(id: string) {\n  // const user: User = await db.get(id);\n  // if (!user) throw new NotFound(id);\n  // return user;\n  return db.find(id);\n}",
  "export const routes = {\n  home: '/',\n  // settings: '/settings',\n  // billing: '/billing',\n  // admin: '/admin',\n};",
  "export const Page = () => (\n  <main>\n    {/*\n    <Header />\n    <Nav items={items} />\n    <Footer />\n    */}\n  </main>\n);",
  "export const Page = () => null;\n// <Button onClick={save}>\n//   Save\n// </Button>",
];

export const good = [
  "// Totals are computed in cents so rounding never drifts.\n// The tax rate comes from the account, not the request.\n// See billing.md for the rules.\nexport const total = 1;",
  "/**\n * Adds two numbers.\n * @example\n * const sum = add(1, 2);\n * if (sum !== 3) {\n *   throw new Error('bad');\n * }\n */\nexport function add(a, b) { return a + b; }",
  "// Usage:\n//   const capture = createCapture({ project });\n//   await capture.record({ request });\n//   return response;\nexport const usage = 1;",
  "// Copyright (c) 2026 Acme Inc.\n// Licensed under the MIT License.\n// See LICENSE in the project root.\nexport const x = 1;",
  "//  request ──► capture ──► collector\n//                │\n//                └──► replay\nexport const flow = 1;",
  "// Renders:\n// <ul>\n//   <li>item</li>\n// </ul>\nexport const List = () => null;",
  "// When the user is signed out (no session), we redirect to /login;\n// otherwise the page renders the dashboard (see Shell);\n// both paths log the visit.\nexport const y = 1;",
];
