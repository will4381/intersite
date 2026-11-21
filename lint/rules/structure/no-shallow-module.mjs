// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, filePath, isGenerated, isTestFile, walk } from "../shared.mjs";

/** A module this wide or wider is measured; a few small exports are a normal, focused module. */
const MIN_EXPORTS = 8;
/** Statements per exported function, on average, below which the interface is wider than the work behind it. */
const MAX_AVERAGE = 2;

/** The exported functions of a statement: `export function f`, `export const f = () => …`. @param {any} statement */
function exportedFunctions(statement) {
  if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) return [];
  const d = statement.declaration;
  if (d.type === "FunctionDeclaration") return [d];
  if (d.type !== "VariableDeclaration") return [];
  return d.declarations.filter((/** @type {any} */ v) => FUNCTIONS.has(v.init?.type)).map((/** @type {any} */ v) => v.init);
}

/** Statements a function runs, those of its callbacks included; an expression body is one. @param {any} fn */
function statements(fn) {
  if (fn.body.type !== "BlockStatement") return 1;
  let count = 0;
  walk(fn.body, (n) => void ((n.type.endsWith("Statement") && n.type !== "BlockStatement") || n.type === "VariableDeclaration" ? count++ : 0));
  return count;
}

/** Whether a function returns JSX: a component, which a module of components exports by design. @param {any} fn */
function returnsJsx(fn) {
  let jsx = false;
  walk(fn.body, (n) => {
    if (n.type === "JSXElement" || n.type === "JSXFragment") jsx = true;
    return !jsx;
  });
  return jsx;
}

export const id = "no-shallow-module";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      shallow: "This module exports {{count}} functions that average {{average}} statements each: a wide interface over little work, so every caller learns {{count}} names and stitches them together itself. Merge the ones callers use together into fewer functions that each do a whole task, and keep the steps private.",
    },
  },
  createOnce(context) {
    return {
      // An index file re-exports a package's surface; constants and types files are tables, not behaviour.
      before: () => !isTestFile(context) && !isGenerated(context) && !/(^|\/)(index|constants?|types?)\.[cm]?[jt]sx?$/.test(filePath(context)),
      Program(program) {
        const fns = program.body.flatMap(exportedFunctions).filter((/** @type {any} */ fn) => !returnsJsx(fn));
        if (fns.length < MIN_EXPORTS) return;
        // Work the module does privately counts too: a deep module has a small interface over a large body.
        const exported = new Set(fns);
        let total = fns.reduce((sum, fn) => sum + statements(fn), 0);
        walk(program, (n) => {
          if (FUNCTIONS.has(n.type) && !exported.has(n) && n.parent?.type !== "CallExpression") {
            total += statements(n);
            return false;
          }
        });
        const average = total / fns.length;
        if (average >= MAX_AVERAGE) return;
        context.report({ node: program.body.find((/** @type {any} */ s) => exportedFunctions(s).includes(fns[0])), messageId: "shallow", data: { count: String(fns.length), average: average.toFixed(1) } });
      },
    };
  },
});

const many = (/** @type {string[]} */ names, /** @type {(n: string) => string} */ body) => names.map(body).join("\n");

export const bad = [
  many(["getUserName", "getUserEmail", "getUserAvatar", "getUserRole", "getUserPlan", "getUserTeam", "getUserLocale", "getUserTimezone"], (n) => `export const ${n} = (user) => user.${n.slice(7).toLowerCase()};`),
  many(["saveDraft", "loadDraft", "deleteDraft", "listDrafts", "renameDraft", "copyDraft", "archiveDraft", "restoreDraft"], (n) => `export async function ${n}(id, body) { return api.post('/drafts/${n}', { id, body }); }`),
];

export const good = [
  many(["getUserName", "getUserEmail", "getUserAvatar"], (n) => `export const ${n} = (user) => user.${n.slice(7).toLowerCase()};`),
  `${many(["a", "b", "c", "d", "e", "f", "g", "h"], (n) => `export const ${n} = (x) => run('${n}', x);`)}\nfunction run(op, x) {\n  const plan = compile(op);\n  const checked = validate(plan, x);\n  if (!checked.ok) throw new Error(checked.reason);\n  const result = execute(plan, checked.value);\n  log(op, result);\n  metrics.count(op);\n  cache.set(op, result);\n  return result;\n}`,
];
