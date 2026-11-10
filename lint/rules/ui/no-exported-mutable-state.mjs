// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

/** An empty `new Map()`, `new Set()` or `[]`: a collection exported for other modules to fill. @param {any} init */
const emptyCollection = (init) =>
  (init?.type === "NewExpression" && /^(?:Map|Set)$/.test(init.callee.name) && !init.arguments.length) || (init?.type === "ArrayExpression" && !init.elements.length);

export const id = "no-exported-mutable-state";
export const pack = "globals";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "This exports mutable state: an exported `let`, or an empty Map, Set or array for other modules to fill. That is a global variable, so any importer can change it with no record of who did, and on a server every request shares it. Keep it private and export the functions that read and change it (`markDirty`, `isDirty`), or hold it in a store or React context; export `const` for true constants.",
    },
  },
  createOnce(context) {
    return {
      // Test helpers share fixtures this way on purpose; Svelte's `export let` declares a prop.
      before() {
        if (isTestFile(context) || /\.(?:svelte|vue|astro)$/.test(context.filename)) return false;
      },
      "ExportNamedDeclaration > VariableDeclaration"(/** @type {any} */ node) {
        if (node.kind !== "const") context.report({ node, messageId: "found" });
        else for (const d of node.declarations) if (emptyCollection(d.init)) context.report({ node: d, messageId: "found" });
      },
    };
  },
});

export const bad = [
  "export let currentUser: User | null = null;",
  "export let config = loadConfig();\nexport function reload() { config = loadConfig(); }",
  "export const dirtySheets = new Set<string>();",
  "export const listeners: Array<() => void> = [];",
];

export const good = [
  "export const LIMIT = 100;",
  "const dirty = new Set<string>();\nexport const markDirty = (id: string) => dirty.add(id);\nexport const isDirty = () => dirty.size > 0;",
  "export const ROUTES = new Map([['home', '/']]);",
  "export const EXPERIMENTS = {} as const;",
  "export function count() { let n = 0; for (const x of [1, 2]) n += x; return n; }",
];
