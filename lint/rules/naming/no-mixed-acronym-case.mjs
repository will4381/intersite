// @ts-check
import { defineRule } from "@oxlint/plugins";

import { bindings, words } from "./names.mjs";

export const id = "no-mixed-acronym-case";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      found: "{{name}} spells {{word}} as {{mine}}, but this file also writes it {{other}} ({{example}}). Two spellings of one word make readers wonder whether they are two things, and searches miss half. Pick one: {{fixed}}.",
    },
  },
  createOnce(context) {
    /** @type {Map<string, { upper: any[], cap: any[] }>} lowercase word -> names spelling it all caps (URL) or capitalised (Url) */
    let seen = new Map();
    const declared = bindings((id, how) => {
      // A whole-name constant (PAYOUT_TIMEOUT_MS) is all caps by convention, not an acronym choice.
      if (how === "destructured" || /^[A-Z0-9_]+$/.test(id.name)) return;
      // The first word of a camelCase name is lowercase in both styles (urlPath, idList), so only later words count.
      for (const w of words(id.name).slice(1)) {
        if (w.length < 2 || w.length > 5 || !/^[A-Z]/.test(w)) continue;
        const style = /^[A-Z0-9]+$/.test(w) ? "upper" : /^[A-Z][a-z0-9]+$/.test(w) ? "cap" : undefined;
        if (!style) continue;
        const entry = seen.get(w.toLowerCase()) ?? { upper: [], cap: [] };
        if (!entry[style].some((n) => n.name === id.name)) entry[style].push(id);
        seen.set(w.toLowerCase(), entry);
      }
    });
    return {
      before() {
        seen = new Map();
      },
      ...declared,
      "Program:exit"() {
        for (const [word, { upper, cap }] of seen) {
          if (!upper.length || !cap.length) continue;
          // Report the less common spelling; on a tie, the later one.
          const [minority, majority] = upper.length > cap.length ? [cap, upper] : cap.length > upper.length ? [upper, cap] : [upper[0].start > cap[0].start ? upper : cap, upper[0].start > cap[0].start ? cap : upper];
          const want = majority === upper ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1);
          for (const node of minority) {
            const mine = words(node.name).slice(1).find((w) => w.toLowerCase() === word) ?? word;
            const fixed = node.name.replace(mine, want);
            context.report({ node, messageId: "found", data: { name: node.name, word, mine, other: want, example: majority[0].name, fixed } });
          }
        }
      },
    };
  },
});

export const bad = [
  "export const userId = session.user;\nexport function loadUser(userID: string) { return db.find(userID); }",
  "export function parseURL(input: string) { return new URL(input); }\nexport const baseUrl = 'https://example.com';\nexport const apiUrl = `${baseUrl}/api`;",
];

export const good = [
  "export const userId = session.user;\nexport function loadUser(id: string) { return db.find(id); }",
  "export const urlPath = '/a';\nexport const baseURL = 'https://example.com';",
  "import { userID } from './ids';\nexport const userId = userID;",
  "export function read({ userID }: Payload) { const userId = userID; return userId; }",
];
