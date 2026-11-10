// @ts-check
import { defineRule } from "@oxlint/plugins";

import { bindings } from "./names.mjs";

/**
 * Longer than any name in a corpus of 135,000 declarations across 22 projects (longest 55, 99.99th percentile 47).
 * Long, specific names are fine; past this, a name is a sentence.
 */
// ponytail: one fixed ceiling; per-project percentiles if a codebase legitimately runs longer
const MAX = 56;

export const id = "no-overlong-name";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      found: "{{name}} is {{length}} characters, longer than any name in a corpus of real projects, so it reads as a sentence and wraps every line it is on. Keep the words that tell it apart from its neighbours and let the module or type carry the rest.",
    },
  },
  createOnce(context) {
    return bindings((id, how) => {
      if (how !== "destructured" && id.name.length > MAX) context.report({ node: id, messageId: "found", data: { name: id.name, length: String(id.name.length) } });
    });
  },
});

export const bad = ["export function handleUserProfileSettingsUpdateButtonClickEventForCurrentUser() {}"];

export const good = ["export function requeuePostgresPaidSocialProvisioningJobsAfterReconnect() {}"];
