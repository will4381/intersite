// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isTestFile } from "./paths.mjs";

/** An edit-history suffix: `handleSubmitNew`, `parseOld`, `fetchUserV2`, `utilsFixed`. (`Copy` is left out: `heroCopy` is UI text.) */
const edited = /^(.*?[a-z0-9])_?(New|Old|Fixed|Refactored|Improved|Enhanced|Backup|V\d+)$/;
const words = "data|result|res|response|temp|tmp|item|items|value|val|obj|arr|list|output|thing|stuff|info";
const capitalized = words.split("|").map((w) => w[0].toUpperCase() + w.slice(1)).join("|");
/** A generic word plus a counter: `data2`, `result1`, `temp3`, `finalResult2`; not `interval1` or `addressLine1`. */
const numbered = new RegExp(`^(?:${words})\\d+$|[a-z0-9](?:${capitalized})\\d+$`);
/** Names that say nothing about what the code does. */
const generic = new Set(["myFunction", "myFunc", "myMethod", "myComponent", "MyComponent", "myVar", "myVariable", "doStuff", "doSomething", "doThing", "doThings", "doWork", "handleStuff", "handleThing", "handleSomething", "processData", "processStuff", "processThing", "foo", "baz", "qux"]);


export const id = "no-throwaway-name";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      edited: "{{name}} sits next to {{base}} and is named for its place in an edit history (new, old, fixed, v2). Replace {{base}} with it and take that name, or name it for what makes it different.",
      numbered: "{{name}} is a generic word with a counter, so readers cannot tell it apart from its siblings without tracing both. Name it for what it holds (activeUsers, retryResponse).",
      generic: "{{name}} says nothing about what the code does. Name it for its job (sendInvoice, parseCsvRow).",
    },
  },
  createOnce(context) {
    /** @type {Map<any, Map<string, any>>} scope (function, class body or program) -> names declared directly in it */
    let declared = new Map();
    /** @param {any} id */
    function check(id) {
      if (id?.type !== "Identifier") return;
      let scope = id.parent.parent;
      while (scope && !FUNCTIONS.has(scope.type) && scope.type !== "ClassBody" && scope.type !== "Program") scope = scope.parent;
      const names = declared.get(scope) ?? new Map();
      if (!names.has(id.name)) names.set(id.name, id);
      declared.set(scope, names);
      if (generic.has(id.name)) context.report({ node: id, messageId: "generic", data: { name: id.name } });
      else if (numbered.test(id.name)) context.report({ node: id, messageId: "numbered", data: { name: id.name } });
    }
    return {
      before() {
        declared = new Map();
        return !isTestFile(context);
      },
      VariableDeclarator: (node) => check(node.id),
      FunctionDeclaration: (node) => check(node.id),
      ClassDeclaration: (node) => check(node.id),
      "MethodDefinition, PropertyDefinition": (node) => !node.computed && check(node.key),
      // Only next to the name it replaced: alone, handleNew (the New button) or stripeV2 (Stripe's v2 API) are real names.
      "Program:exit"() {
        for (const names of declared.values()) {
          for (const [name, id] of names) {
            const base = edited.exec(name)?.[1];
            if (base && names.has(base)) context.report({ node: id, messageId: "edited", data: { name, base } });
          }
        }
      },
    };
  },
});

export const bad = [
  "export function handleSubmit(event: Event) { return event; }\nexport function handleSubmitNew(event: Event) { return event; }",
  "const fetchUser = (id: string) => fetch(`/user/${id}`);\nexport const fetchUserV2 = (id: string) => fetch(`/users/${id}`);\nexport default fetchUser;",
  "export function parse(text: string) { return text.split(';'); }\nexport function parseOld(text: string) { return text.split(','); }",
  "export const Button = () => null;\nexport const ButtonFixed = () => null;",
  "const data2 = rows.filter(Boolean);\nexport const finalResult2 = data2.length;",
  "export function processData(input: string[]) { return input; }",
];

export const good = [
  "export const isNew = created > lastVisit;",
  "export const handleNew = () => openCreateDialog();",
  "export const stripeV2 = (path: string) => fetch(`https://api.stripe.com/v2${path}`);",
  "export function pay() { const stripe = connect(); return stripe; }\nexport function stripeV2(path: string) { return fetch(path); }",
  "export const bar = cursor.indexOf('|');",
  "export const addressLine1 = form.line1;",
  "export const sha256 = hash('sha256');",
  "export function markFixed(issue: Issue) { issue.state = 'fixed'; }",
  "export const lastUpdated = new Date();",
  "export const step2 = steps[1];",
];
