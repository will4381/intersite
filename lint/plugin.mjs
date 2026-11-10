// @ts-check
// The `intersite` oxlint plugin: every package rule (lint/packs/*.yml plus lint/rules/**) and the project's
// `lint.custom` rules from intersite.yml in the working directory.
import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob, relative } from "node:path";

import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import { parse } from "yaml";

import { loadConfig } from "../shared/config.mjs";
import { commentRule } from "./comment-rule.mjs";
import codeRules from "./rules/index.mjs";

/**
 * A rule declared in YAML: a `selector` over the syntax tree, or a `comment` regular expression (optionally with
 * `unless`, a second expression that exempts a comment).
 * @typedef {{ id: string, pack?: string, selector?: string, comment?: string, unless?: string, message: string, files?: string[], bad?: string[], good?: string[] }} JsonRule
 */

/** Every file in lint/packs: `rules` are declared rules, `builtin` switches on rules oxlint already ships. */
const packFiles = readdirSync(new URL("./packs/", import.meta.url)).filter((name) => name.endsWith(".yml")).sort()
  .map((name) => parse(readFileSync(new URL(`./packs/${name}`, import.meta.url), "utf8")));

/** @type {JsonRule[]} */
export const jsonRules = packFiles.flatMap((file) => file.rules ?? []);

/**
 * Rules oxlint ships that a pack turns on, named as oxlint names them (`react/no-array-index-key`).
 * @type {{ rule: string, pack: string }[]}
 */
export const builtinRules = packFiles.flatMap((file) => file.builtin ?? []);

/** Every package rule as `{ id, pack, bad, good }`. */
export const packageRules = [...jsonRules, ...codeRules];

/** @returns {JsonRule[]} */
export function customRules(cwd = process.cwd()) {
  return loadConfig(cwd).lint.custom;
}

/** @param {JsonRule} r */
function declaredRule(r) {
  if (r.comment) {
    const comment = new RegExp(r.comment, "i");
    const unless = r.unless ? new RegExp(r.unless, "i") : undefined;
    return commentRule(r.message, (first) => comment.test(first) && !unless?.test(first), r.files);
  }
  if (!r.selector) throw new Error(`intersite rule "${r.id}" needs a selector or a comment`);
  const selector = r.selector;
  return defineRule({
    meta: { type: "problem", messages: { found: r.message } },
    createOnce(context) {
      return {
        before() {
          const file = relative(context.cwd, context.filename);
          return !r.files || r.files.some((glob) => matchesGlob(file, glob));
        },
        [selector](/** @type {any} */ node) {
          context.report({ node, messageId: "found" });
        },
      };
    },
  });
}

export default eslintCompatPlugin({
  meta: { name: "intersite" },
  rules: Object.fromEntries([
    ...jsonRules.map((r) => [r.id, declaredRule(r)]),
    ...codeRules.map((r) => [r.id, r.rule]),
    ...customRules().map((r) => [r.id, declaredRule(r)]),
  ]),
});
