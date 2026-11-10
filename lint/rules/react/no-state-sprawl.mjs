// @ts-check
import { defineRule } from "@oxlint/plugins";

import { functionName, isHookCall } from "./hooks.mjs";

/** The corpus this was tuned on: 7+ states flagged ordinary forms, 12+ only wizard pages and god components. */
const LIMIT = 12;

/** Boolean flags are left to no-boolean-state-cluster (pack `state`), so one component is not reported twice for them. @param {any} init */
const isBooleanState = (init) => init.arguments[0]?.type === "Literal" && typeof init.arguments[0].value === "boolean";

export const id = "no-state-sprawl";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      sprawl: "{{name}} holds {{count}} separate useState values, so related values drift apart (one setter forgotten on reset, two fields briefly disagreeing). Group values that change together into one object or a useReducer, or split {{name}} into smaller components that each own their part.",
    },
  },
  createOnce(context) {
    return {
      ":function"(fn) {
        const name = functionName(fn);
        if (!/^[A-Z]/.test(name ?? "") || fn.body?.type !== "BlockStatement") return;
        let count = 0;
        for (const s of fn.body.body) {
          if (s.type !== "VariableDeclaration") continue;
          for (const d of s.declarations) if (isHookCall(d.init, /^useState$/) && !isBooleanState(d.init)) count++;
        }
        if (count >= LIMIT) context.report({ node: fn.parent.type === "VariableDeclarator" ? fn.parent : fn, messageId: "sprawl", data: { name, count: String(count) } });
      },
    };
  },
});

const states = (/** @type {number} */ n, /** @type {string} */ init) => Array.from({ length: n }, (_, i) => `  const [v${i}, setV${i}] = useState(${init});`).join("\n");

export const bad = [
  `export function Wizard() {\n${states(12, "''")}\n  return null;\n}`,
  `export const Booking = () => {\n${states(8, "null")}\n${states(6, "0").replaceAll("v", "w").replaceAll("setV", "setW")}\n  return null;\n};`,
  `export const Editor = React.memo(function Editor() {\n${states(13, "[]").replaceAll("useState", "React.useState")}\n  return null;\n});`,
];

export const good = [
  `export function Form() {\n${states(11, "''")}\n  return null;\n}`,
  // Booleans are counted by no-boolean-state-cluster instead.
  `export function Panel() {\n${states(8, "''")}\n${states(8, "false").replaceAll("v", "f").replaceAll("setV", "setF")}\n  return null;\n}`,
  // Split across components, each owns a few.
  `export function A() {\n${states(6, "''")}\n  return null;\n}\nexport function B() {\n${states(6, "''")}\n  return null;\n}`,
  `export function useWizard() {\n${states(14, "''")}\n  return null;\n}`,
];
