// @ts-check
import { defineRule } from "@oxlint/plugins";

// ponytail: a bare `eslint-disable` (no rule names) silences this rule too, because oxlint honors it before any rule
// runs; catching that needs a text scan in cli/lint.mjs outside oxlint.
const suppression = /^\s*(@ts-ignore|@ts-nocheck|eslint-disable|oxlint-disable)/;
/** The one allowed form: a single line, a named rule, and a written reason. */
const reasoned = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)\s+\S.*\s--\s+\S/;

export const id = "no-lint-suppression";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      suppressed: "This comment silences the type checker or linter instead of fixing the problem. Remove it and fix the code it hides. For a deliberate exception, use `// oxlint-disable-next-line <rule> -- <why>`.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (suppression.test(comment.value) && !reasoned.test(comment.value)) context.report({ loc: comment.loc, messageId: "suppressed" });
        }
      },
    };
  },
});

export const bad = [
  "// @ts-ignore\nconst n: number = 'x';",
  "/* eslint-disable no-console */\nrun();",
  "run(); // oxlint-disable-line no-console",
  "// @ts-nocheck\nrun();",
  "// oxlint-disable-next-line no-console\nrun();",
  "/* eslint-disable no-console -- everywhere */\nrun();",
];

export const good = [
  "// The cache is warmed on boot, see boot.ts.\nrun();",
  "// @ts-expect-error testing that bad input is rejected\nparse(1);",
  "// oxlint-disable-next-line no-console -- printing is this command's output\nrun();",
];
