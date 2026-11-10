// @ts-check
import { matchesGlob, relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

/**
 * A rule that reports every comment `matches` accepts. It gets the comment's first line, with the leading `*` and
 * spaces of a block comment removed, and the whole comment as its second argument.
 * @param {string} message @param {(firstLine: string, whole: string) => boolean} matches @param {string[]} [files]
 */
export function commentRule(message, matches, files) {
  return defineRule({
    meta: { type: "problem", messages: { found: message } },
    createOnce(context) {
      return {
        Program() {
          if (files && !files.some((glob) => matchesGlob(relative(context.cwd, context.filename), glob))) return;
          for (const comment of context.sourceCode.getAllComments()) {
            const first = comment.value.replace(/^[\s*]+/, "").split("\n")[0];
            if (matches(first, comment.value)) context.report({ loc: comment.loc, messageId: "found" });
          }
        },
      };
    },
  });
}
