// @ts-check
// The `intersite` oxlint plugin: every package rule (lint/rules.json plus lint/rules/*.mjs) and the project's
// `lint.custom` rules from intersite.json in the working directory.
import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";

import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

import { CONFIG_FILE, loadConfig } from "../shared/config.mjs";
import codeRules from "./rules/index.mjs";

/** @typedef {{ id: string, pack?: string, selector: string, message: string, files?: string[], bad?: string[], good?: string[] }} JsonRule */

/** @type {JsonRule[]} */
export const jsonRules = JSON.parse(readFileSync(new URL("./rules.json", import.meta.url), "utf8")).rules;

/** Every package rule as `{ id, pack, bad, good }`. */
export const packageRules = [...jsonRules, ...codeRules];

/** @returns {JsonRule[]} */
export function customRules(cwd = process.cwd()) {
  return existsSync(join(cwd, CONFIG_FILE)) ? loadConfig(cwd).lint.custom : [];
}

/** @param {JsonRule} r */
function selectorRule(r) {
  return defineRule({
    meta: { type: "problem", messages: { found: r.message } },
    createOnce(context) {
      return {
        before() {
          const file = relative(context.cwd, context.filename);
          return !r.files || r.files.some((glob) => matchesGlob(file, glob));
        },
        [r.selector](/** @type {any} */ node) {
          context.report({ node, messageId: "found" });
        },
      };
    },
  });
}

export default eslintCompatPlugin({
  meta: { name: "intersite" },
  rules: Object.fromEntries([
    ...jsonRules.map((r) => [r.id, selectorRule(r)]),
    ...codeRules.map((r) => [r.id, r.rule]),
    ...customRules().map((r) => [r.id, selectorRule(r)]),
  ]),
});
