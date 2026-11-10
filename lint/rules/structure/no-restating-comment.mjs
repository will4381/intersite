// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "./paths.mjs";

/** Words that carry no meaning of their own in a comment. */
const STOP = new Set("a an the to of for and or in on with this that it its is are be been being we our you your each every all from by as at into if then else when so via up out just also only now here there do does will can should may might must any some which what them they their these those my me i us one our".split(" "));
/** Comment verbs and the code that says the same thing. */
const SAME = /** @type {Record<string, string[]>} */ ({
  check: ["if"], loop: ["for", "foreach", "map", "while"], iterate: ["for", "foreach", "map", "while"], return: ["return"],
  initialize: ["usestate", "new", "init"], init: ["usestate", "new", "init"], call: ["call"], increment: ["++", "+="],
  create: ["create", "new"], fetch: ["fetch", "get", "load"], get: ["get", "fetch", "read", "find"], define: ["const", "let", "function", "type", "interface"],
  declare: ["const", "let", "function", "type", "interface"], import: ["import", "require"], export: ["export"], set: ["set", "="],
  update: ["set", "update"], add: ["add", "push"], render: ["return", "render"], wait: ["await"], await: ["await"], log: ["console", "log"],
});
/**
 * Imperative verbs a restating comment opens with ("Fetch the user", "Increment the counter"). A noun phrase ("Promo code",
 * "Exit conditions") is a section label grouping the lines below it, and is left alone.
 */
const VERBS = new Set([...Object.keys(SAME), ..."delete remove save load parse validate send convert calculate compute filter map sort find store push append reset clear close open start stop print show hide toggle apply build make generate format extract assign use handle decrement".split(" ")]);
/** Stock comments that label code instead of explaining it, whatever follows them. */
const STOCK = /^(?:imports?|import (?:all )?(?:the )?(?:necessary |required )?(?:dependencies|modules|libraries|packages|components|types|styles|hooks)|constants|variables|types|interfaces|state(?: variables)?|initiali[sz]e (?:the )?state|return (?:the )?(?:result|response|data|value|component|jsx|markup)|(?:loop|iterate) (?:through|over) (?:each|every|all|the) \w+|(?:define|declare) (?:the )?(?:component|function|variables?|constants?|types?|interfaces?|props|state)|export (?:default )?(?:the )?(?:component|function|module)|main (?:function|component)|helper functions?|event handlers?|(?:handle|handles) (?:the )?(?:click|submit|change)|render(?: the)?(?: component| ui| jsx)?|constructor|end of (?:file|component|function|class))\.?$/i;

/** Lowercase word stems: `items` and `item` match, `loading` and `load` match. @param {string} word */
const stem = (word) => word.replace(/(?:ies)$/, "y").replace(/(?:ing|ed|es|s)$/, "") || word;

/** The words in a line of code: identifiers split at camelCase and underscores, plus operators worth naming. @param {string} code */
function codeWords(code) {
  const words = code.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$]/g, " ").toLowerCase().match(/[a-z]+/g) ?? [];
  const set = new Set(words.flatMap((w) => [w, stem(w)]));
  for (const op of ["++", "+=", "="]) if (code.includes(op)) set.add(op);
  // `items.forEach(` and `forEach` read as one word.
  for (const m of code.toLowerCase().matchAll(/[a-z]+/g)) set.add(m[0]);
  return set;
}

export const id = "no-restating-comment";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      restates: "This comment says what the next line already says, so it is noise to read and a second thing to keep in sync. Delete it, or say why the code does this (the constraint, the edge case, the decision) instead of what it does.",
    },
  },
  createOnce(context) {
    return {
      // Tests narrate their steps (// Click "Save") on purpose, as a script a reader follows.
      before: () => !isTestFile(context),
      Program() {
        const { sourceCode } = context;
        const lines = sourceCode.lines ?? sourceCode.text.split("\n");
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type === "Block" && (comment.value.startsWith("*") || comment.loc.start.line !== comment.loc.end.line)) continue;
          const text = comment.value.trim();
          // Only a comment alone on its line, directly above code.
          if (lines[comment.loc.start.line - 1].slice(0, comment.loc.start.column).trim()) continue;
          const next = lines[comment.loc.end.line]?.trim() ?? "";
          if (!next || next.startsWith("//") || next.startsWith("/*") || next.startsWith("*")) continue;
          if (/[?:;]|https?:|\b(?:todo|fixme|note|hack|why|because|since|so that|otherwise|unless|until|before|after|instead|without|eslint|oxlint|prettier|@ts-)\b/i.test(text)) continue;
          if (STOCK.test(text)) {
            context.report({ loc: comment.loc, messageId: "restates" });
            continue;
          }
          const words = (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !STOP.has(w));
          if (words.length < 2 || words.length > 6 || !VERBS.has(words[0])) continue;
          const code = codeWords(next);
          if (words.every((w) => code.has(w) || code.has(stem(w)) || (SAME[w] ?? []).some((s) => code.has(s)))) context.report({ loc: comment.loc, messageId: "restates" });
        }
      },
    };
  },
});

export const bad = [
  "export function total(items) {\n  let sum = 0;\n  // Loop through each item\n  for (const item of items) sum += item.price;\n  // Return the sum\n  return sum;\n}",
  "// Import dependencies\nimport { readFile } from 'node:fs/promises';\nexport const read = readFile;",
  "export async function load(id) {\n  // Fetch the user\n  const user = await fetchUser(id);\n  return user;\n}",
  "export function inc(state) {\n  // Increment the counter\n  state.counter++;\n}",
  "export function Page() {\n  // Initialize state\n  const [open, setOpen] = useState(false);\n  return open;\n}",
];

export const good = [
  "export async function load(id) {\n  // Cached for 30s: the provider rate-limits per user\n  const user = await fetchUser(id);\n  return user;\n}",
  "export function total(items) {\n  // Prices are integer cents, so the sum is exact\n  return items.reduce((sum, item) => sum + item.price, 0);\n}",
  "export function retry(fn) {\n  // Retry once\n  // (the second failure is reported)\n  return fn().catch(fn);\n}",
  "export function save(user) {\n  // Save the user before sending the email, otherwise the link 404s\n  saveUser(user);\n}",
  "export function f(user) {\n  // Admins skip the queue\n  if (user.isAdmin) return run(user);\n  return enqueue(user);\n}",
  "export const view = {\n  // Promo code\n  promoCode: '',\n  // Bus service\n  busService: null,\n};",
];
