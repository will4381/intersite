// @ts-check
import { defineRule } from "@oxlint/plugins";

/**
 * A rule that reports every comment `matches` accepts. It gets the comment's first line, with the leading `*` and
 * spaces of a block comment removed, and the whole comment as its second argument.
 * @param {string} message @param {(firstLine: string, whole: string) => boolean} matches
 * @param {(context: any) => boolean} [applies] whether the rule runs on the file being linted; every file when omitted
 */
export function commentRule(message, matches, applies) {
  return defineRule({
    meta: { type: "problem", messages: { found: message } },
    createOnce(context) {
      return {
        Program() {
          if (applies && !applies(context)) return;
          for (const comment of context.sourceCode.getAllComments()) {
            // `#!/usr/bin/env node` tells the shell how to run the file; it is not a comment anyone wrote to explain code.
            if (comment.type === "Shebang") continue;
            const first = comment.value.replace(/^[\s*]+/, "").split("\n")[0];
            if (matches(first, comment.value)) context.report({ loc: comment.loc, messageId: "found" });
          }
        },
      };
    },
  });
}
