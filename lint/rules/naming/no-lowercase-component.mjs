// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile, walk } from "../shared.mjs";
import { functionName } from "../react/hooks.mjs";
import { atModuleScope } from "./names.mjs";

/** Whether a function returns JSX from its own body (not from a nested function). @param {any} fn */
function returnsJsx(fn) {
  const isJsx = (/** @type {any} */ n) => n?.type === "JSXElement" || n?.type === "JSXFragment";
  if (fn.body.type !== "BlockStatement") return isJsx(fn.body.type === "ParenthesizedExpression" ? fn.body.expression : fn.body);
  let found = false;
  walk(fn.body, (n, parent) => {
    if (n.type === "ReturnStatement" && isJsx(n.argument) && !(parent && /Function/.test(parent.type))) found = true;
  });
  return found;
}

export const id = "no-lowercase-component";
export const pack = "naming";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "{{name}} is an exported component (it takes props and returns JSX) named in lowercase. JSX treats a lowercase tag as an HTML element, so <{{name}} /> renders nothing useful, and the hook rules skip it. Name it {{fixed}}.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context),
      ":function"(fn) {
        const name = functionName(fn);
        if (!name || !/^[a-z]/.test(name) || /^(?:render|use|get|create|build|make|to|with)[A-Z]/.test(name) || !atModuleScope(fn)) return;
        const exported = /Export/.test(fn.parent?.type ?? "") || /Export/.test(fn.parent?.parent?.parent?.type ?? "");
        const props = fn.params.length === 1 && (fn.params[0].type === "ObjectPattern" || fn.params[0].name === "props");
        if (exported && props && fn.body && returnsJsx(fn)) {
          context.report({ node: fn.id ?? fn, messageId: "found", data: { name, fixed: name[0].toUpperCase() + name.slice(1) } });
        }
      },
    };
  },
});

export const bad = [
  "export function userCard({ user }: { user: User }) { return <div>{user.name}</div>; }",
  "export const profileHeader = (props: Props) => <header>{props.title}</header>;",
  "export default function settingsPage({ tab }: { tab: string }) {\n  if (!tab) return null;\n  return <main>{tab}</main>;\n}",
];

export const good = [
  "export function UserCard({ user }: { user: User }) { return <div>{user.name}</div>; }",
  "export function renderRow({ item }: { item: Item }) { return <li>{item.name}</li>; }",
  "function badge({ label }: { label: string }) { return <span>{label}</span>; }\nexport const Badges = () => badge({ label: 'new' });",
  "export const columns = [{ key: 'name', cell: ({ row }: Cell) => <b>{row.name}</b> }];",
  "export function formatLabel({ label }: { label: string }) { return label.trim(); }",
];
