// @ts-check
// Every package rule (lint/packs/*.yml plus lint/rules/**) and how a declared rule becomes an oxlint rule. Kept apart
// from plugin.mjs so `intersite lint` can read the catalogue without loading any project's intersite.yml.
import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob, relative } from "node:path";

import { defineRule } from "@oxlint/plugins";
import { parse } from "yaml";

import { commentRule } from "./comment-rule.mjs";
import codeRules from "./rules/index.mjs";
import { isGenerated, isTestFile, mentions } from "./rules/shared.mjs";

/**
 * A rule declared in YAML: a `selector` over the syntax tree, or a `comment` regular expression (optionally with
 * `unless`, a second expression that exempts a comment).
 * @typedef {{ id: string, pack?: string, selector?: string, comment?: string, unless?: string, needs?: string, message: string, files?: string[], skip?: string[], ext?: string, bad?: string[], good?: string[] }} JsonRule
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

/** What a declared rule's `skip` may name. */
const SKIPS = /** @type {Record<string, (context: any) => boolean>} */ ({ tests: isTestFile, generated: isGenerated });

/**
 * Whether a declared rule runs on the file being linted: inside `files`, none of its `skip` kinds, and its source can
 * hold what the rule looks for (`needs`).
 * @param {JsonRule} r @returns {((context: any) => boolean) | undefined} undefined when the rule runs on every file
 */
function appliesTo(r) {
  const unknown = r.skip?.find((kind) => !(kind in SKIPS));
  if (unknown) throw new Error(`intersite rule "${r.id}": skip "${unknown}" is not one of ${Object.keys(SKIPS).join(", ")}`);
  const { files } = r;
  const skips = r.skip?.map((kind) => SKIPS[kind]) ?? [];
  const needs = r.needs ? new RegExp(r.needs) : undefined;
  if (!files && !skips.length && !needs) return undefined;
  return (context) =>
    (!files || files.some((glob) => matchesGlob(relative(context.cwd, context.filename), glob))) && !skips.some((skip) => skip(context)) && (!needs || mentions(context, needs));
}

/** The oxlint rule for a declared rule; throws, naming the rule, when it is malformed. @param {JsonRule} r */
export function declaredRule(r) {
  const applies = appliesTo(r);
  if (r.comment) {
    const comment = new RegExp(r.comment, "i");
    const unless = r.unless ? new RegExp(r.unless, "i") : undefined;
    return commentRule(r.message, (first) => comment.test(first) && !unless?.test(first), applies);
  }
  if (!r.selector) throw new Error(`intersite rule "${r.id}" needs a selector or a comment`);
  const selector = r.selector;
  return defineRule({
    meta: { type: "problem", messages: { found: r.message } },
    createOnce(context) {
      return {
        ...(applies && { before: () => applies(context) }),
        [selector](/** @type {any} */ node) {
          context.report({ node, messageId: "found" });
        },
      };
    },
  });
}
