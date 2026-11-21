// @ts-check
import { readFileSync, readdirSync } from "node:fs";

import { defineRule } from "@oxlint/plugins";
import { parse } from "yaml";

import { isGenerated, isTestFile } from "./shared.mjs";

/** Packs whose rules guard correctness itself: a test that can still fail, code that is not exploitable. */
const GUARDS = new Set(["security", "tests"]);
/** Rule ids per guarding pack, `intersite/<id>`. @type {Map<string, Set<string>> | undefined} */
let byPack;
const named = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?\s+(.*?)(?:\s+--\s|$)/;

/**
 * The ids of the guarding packs' rules, read from the pack files and the code rules' sources the first time they are
 * needed (importing the catalogue would be a cycle: it imports this rule).
 */
function guardIds() {
  if (byPack) return byPack;
  const packs = new URL("../packs/", import.meta.url);
  const declared = readdirSync(packs).filter((f) => f.endsWith(".yml")).flatMap((f) => parse(readFileSync(new URL(f, packs), "utf8")).rules ?? []);
  const rulesDir = new URL("./", import.meta.url);
  const coded = readdirSync(rulesDir, { recursive: true }).map(String).filter((f) => f.endsWith(".mjs")).map((f) => {
    const text = readFileSync(new URL(f, rulesDir), "utf8");
    return { id: /export const id = "([^"]+)"/.exec(text)?.[1], pack: /export const pack = "([^"]+)"/.exec(text)?.[1] };
  });
  byPack = new Map([...GUARDS].map((pack) => [pack, new Set([...declared, ...coded].filter((r) => r.id && r.pack === pack).map((r) => `intersite/${r.id}`))]));
  return byPack;
}

export const id = "no-guard-suppression";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      guard: "{{rules}} guards a test's ability to fail or the code's safety, so a comment cannot waive it, even with a reason. Fix the code. If the rule is wrong for these files, switch it off for them in the project's .oxlintrc.json overrides (or lint.rules in intersite.yml), where review sees it.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isGenerated(context),
      Program() {
        // A test may hold a made-up secret for a scrubber to find; it is never shipped. Test rules hold everywhere.
        const packs = isTestFile(context) ? ["tests"] : [...GUARDS];
        for (const comment of context.sourceCode.getAllComments()) {
          const list = named.exec(comment.value)?.[1];
          const hit = list ? list.split(/[\s,]+/).filter((name) => packs.some((pack) => guardIds().get(pack)?.has(name))) : [];
          if (hit.length) context.report({ loc: comment.loc, messageId: "guard", data: { rules: hit.join(", ") } });
        }
      },
    };
  },
});

export const bad = [
  "// oxlint-disable-next-line intersite/no-interpolated-sql -- the table name is from our own enum\nawait db.query(`SELECT * FROM ${table}`);",
  "it('saves', async () => {\n  // oxlint-disable-next-line intersite/require-assertion -- smoke test\n  await save(row);\n});",
];

export const good = [
  "// oxlint-disable-next-line no-console -- the CLI prints its result\nconsole.log(total);",
  "// oxlint-disable-next-line intersite/max-params -- mirrors the provider's callback signature\nexport function onEvent(a, b, c, d, e, f) { return [a, b, c, d, e, f]; }",
];
