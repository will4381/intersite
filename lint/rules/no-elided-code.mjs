// @ts-check
import { defineRule } from "@oxlint/plugins";

const ellipsis = /\.{3}|…/;
/** What an elision comment says was left out. `code`, `implementation` and `logic` need nothing more. */
const always = "(?:code|implementation|logic)";
const noun = "(?:functions?|methods?|imports?|handlers?|tests?|cases?|props|fields|properties|styles|routes|config(?:uration)?|content|body|component|class|file|setup|helpers?|exports?|types?|steps?|options)";
const owner = "(?:the\\s+|this\\s+|your\\s+)?";
const what = `(?:(?:the\\s+)?rest\\s+of\\s+${owner}|(?:the\\s+)?(?:existing|other|remaining|previous|original|same|unchanged)\\s+)`;
const tail = "(?:here|goes here|as before|as is|(?:remains?|stays?|is|are)(?:\\s+(?:the\\s+same|unchanged|as\\s+(?:is|before)))?|unchanged|omitted|elided|for brevity)";
/** `rest of the code`, `existing code here`: always a placeholder. */
const placeholder = new RegExp(`^(?:${what}${always}(?:\\s+${tail})?|${what}${noun}\\s+${tail}|unchanged|no changes?|same as before)$`, "i");
/** `existing tests`, `other methods`: a placeholder only beside an ellipsis. */
const withEllipsis = new RegExp(`^(?:${what}${noun}|${tail})$`, "i");

/**
 * True when the comment stands in for code that was left out: `// ...`, `// ... rest of the code`,
 * `// existing code here`, `/* (unchanged) *\/`.
 * @param {string} value comment text without its markers
 */
export function isElision(value) {
  if (value.includes("\n") || value.length > 80) return false;
  const words = value.replace(/^[\s.…()[\]*:,-]+|[\s.…()[\]*:,-]+$/g, "").replace(/\s+/g, " ");
  if (!words) return ellipsis.test(value);
  return placeholder.test(words) || (ellipsis.test(value) && withEllipsis.test(words));
}

export const id = "no-elided-code";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      elided: "This comment stands in for code that was left out. Write the code it replaces, or delete the comment if nothing is missing.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const { lines } = context.sourceCode;
        for (const comment of context.sourceCode.getAllComments()) {
          // On a line of its own: `expect(total).toBe(121); // unchanged` describes the line it ends.
          const ownLine = !lines[comment.loc.start.line - 1].slice(0, comment.loc.start.column).trim();
          if (ownLine && !comment.value.startsWith("*") && isElision(comment.value)) context.report({ loc: comment.loc, messageId: "elided" });
        }
      },
    };
  },
});

export const bad = [
  "export function save(user) {\n  validate(user);\n  // ... rest of the code\n}",
  "export class Store {\n  // existing code here\n  clear() { this.items = []; }\n}",
  "export function load() {\n  const a = read();\n  /* ... */\n  return a;\n}",
  "export const config = {\n  port: 3000,\n  // ... existing options ...\n};",
  "export function render() {\n  // rest of the implementation remains the same\n  return null;\n}",
  "export function total(items) {\n  // (unchanged)\n  return sum(items);\n}",
];

export const good = [
  "export function save(user) {\n  // ...and nothing else: the audit row is written by the trigger.\n  return db.insert(user);\n}",
  "// The rest of the code assumes ids are already normalized.\nexport const x = 1;",
  "// Existing customers keep their old plan until renewal.\nexport const plan = 'legacy';",
  "export const placeholder = 'https://...';",
  "/** Returns the rest of the list ... after the cursor. */\nexport function rest(list) { return list.slice(1); }",
  "// … but the service's explicit policy wins.\nexport const policy = 1;",
  "test('keeps the label', () => {\n  expect(updated.line1).toBe(body.line1); // unchanged\n});",
];
