// @ts-check
// The `intersite` oxlint plugin: every package rule (see catalog.mjs) and the project's `lint.custom` rules from the
// intersite.yml of the folder oxlint runs in. `intersite lint` checks that file before starting oxlint, so a broken
// one is reported there in one line; loaded by oxlint directly, the same one-line error is thrown here.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { loadConfig } from "../shared/config.mjs";
import { declaredRule, jsonRules } from "./catalog.mjs";
import codeRules from "./rules/index.mjs";

export default eslintCompatPlugin({
  meta: { name: "intersite" },
  rules: Object.fromEntries([
    ...jsonRules.map((r) => [r.id, declaredRule(r)]),
    ...codeRules.map((r) => [r.id, r.rule]),
    ...loadConfig(process.cwd()).lint.custom.map((/** @type {import("./catalog.mjs").JsonRule} */ r) => [r.id, declaredRule(r)]),
  ]),
});
