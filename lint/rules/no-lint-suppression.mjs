// @ts-check
import { commentRule } from "../comment-rule.mjs";

// A bare `eslint-disable` (no rule names) silences this rule too, because oxlint honors it before any rule runs;
// cli/lint.mjs catches those with a text scan, reported as no-bare-suppression.
const suppression = /^\s*(@ts-ignore|@ts-nocheck|eslint-disable|oxlint-disable)/;
/** The one allowed form: a single line, a named rule, and a written reason. */
const reasoned = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)\s+\S.*\s--\s+\S/;

export const id = "no-lint-suppression";
export const pack = "slop";

export const rule = commentRule(
  "This comment silences the type checker or linter instead of fixing the problem. Remove it and fix the code it hides. For a deliberate exception, use `// oxlint-disable-next-line <rule> -- <why>`.",
  (_first, whole) => suppression.test(whole) && !reasoned.test(whole),
);

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
