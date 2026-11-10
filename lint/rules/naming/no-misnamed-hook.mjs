// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";
import { functionName } from "../react/hooks.mjs";
import { atModuleScope } from "./names.mjs";

/** A hook reached through an object: `trpc.user.get.useQuery()`, `Route.useParams()`, `store.use.count()`. @param {any} node */
const memberHook = (node) => node.callee.type === "MemberExpression" && /^use[A-Z0-9]/.test(node.callee.property?.name ?? "");

/**
 * A hook call: `useX(...)`, `React.useX(...)`, or `use(...)` when React's `use` is imported (elsewhere a bare `use` is
 * just a function).
 * @param {any} node @param {boolean} reactUse
 */
function hookName(node, reactUse) {
  const callee = node.callee;
  const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.object.name === "React" ? callee.property.name : undefined;
  return /^use[A-Z0-9]/.test(name ?? "") || (name === "use" && (reactUse || callee.type === "MemberExpression")) ? name : undefined;
}

/** React's own hooks: calling one is evidence the file is React code, which a project's `useServedCollector()` is not. */
const BUILTIN = /^use(?:State|Effect|LayoutEffect|InsertionEffect|Context|Reducer|Ref|Memo|Callback|Id|Transition|DeferredValue|SyncExternalStore|ImperativeHandle|Optimistic|ActionState|FormStatus|DebugValue)?$/;

/** The name a function is declared under directly: not a callback handed to a call (`create((set) => …)`). @param {any} fn */
const ownName = (fn) => fn.id?.name ?? (fn.parent?.type === "VariableDeclarator" ? fn.parent.id.name : undefined);

export const id = "no-misnamed-hook";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      notHook: "{{name}} is named like a hook but calls none, so React's hook rules bind its callers for nothing and readers go looking for state that is not there. Drop the prefix: {{fixed}}.",
      isHook: "{{name}} calls {{hook}}, which only works inside a component or a hook, but its name says neither, so the hook rules cannot check its callers. Name it {{fixed}} (or in PascalCase if it renders).",
    },
  },
  createOnce(context) {
    /** @type {{ fn: any, hook?: string, anyHook?: boolean }[]} `anyHook` also counts member hooks, which a NestJS `app.useGlobalPipes()` looks like */
    let stack = [];
    /** @type {{ node: any, name: string, fixed: string }[]} functions named use* that call no hook, reported at the end */
    let unhooked = [];
    /** @type {{ node: any, name: string, hook: string, fixed: string }[]} lowercase functions that call a hook, reported at the end */
    let hooked = [];
    let react = false;
    let reactUse = false;
    return {
      before() {
        stack = [];
        unhooked = [];
        hooked = [];
        react = /\.[jt]sx$/.test(context.filename);
        reactUse = false;
        return !isTestFile(context);
      },
      ImportDeclaration(node) {
        // React itself, or a React library: @tanstack/react-query, react-hook-form, next/navigation, swr, zustand.
        if (!/react|^next\/|^(?:swr|zustand|jotai)(?:\/|$)/.test(node.source.value)) return;
        react = true;
        reactUse ||= /^(?:react|preact)(?:\/|$)/.test(node.source.value) && node.specifiers.some((/** @type {any} */ s) => s.imported?.name === "use");
      },
      "JSXElement, JSXFragment"() {
        react = true;
      },
      ":function"(fn) {
        stack.push({ fn });
      },
      CallExpression(node) {
        const frame = stack[stack.length - 1];
        const hook = hookName(node, reactUse);
        if (hook && (BUILTIN.test(hook) || node.callee.type === "MemberExpression")) react = true;
        if (frame && !frame.hook) frame.hook = hook;
        if (frame) frame.anyHook ||= Boolean(hook) || memberHook(node);
      },
      ":function:exit"(fn) {
        const frame = stack.pop();
        const name = functionName(fn);
        if (!frame || !name || !fn.body || (fn.body.type === "BlockStatement" && !fn.body.body.length)) return;
        if (/^use[A-Z0-9]/.test(ownName(fn) ?? "") && !frame.anyHook) {
          unhooked.push({ node: fn.id ?? fn, name, fixed: name.slice(3, 4).toLowerCase() + name.slice(4) });
        } else if (frame.hook && /^[a-z]/.test(name) && !/^use(?:[A-Z0-9]|$)/.test(name) && atModuleScope(fn)) {
          hooked.push({ node: fn.id ?? fn, name, hook: frame.hook, fixed: `use${name[0].toUpperCase()}${name.slice(1)}` });
        }
      },
      // Outside React code (no React import, JSX or React hook), `use` is an ordinary verb: `useSupportModels(models)` in a
      // server test helper, `useServedCollector(url)` in a CLI.
      "Program:exit"() {
        if (!react) return;
        for (const u of unhooked) context.report({ node: u.node, messageId: "notHook", data: { name: u.name, fixed: u.fixed } });
        for (const h of hooked) context.report({ node: h.node, messageId: "isHook", data: { name: h.name, hook: h.hook, fixed: h.fixed } });
      },
    };
  },
});

export const bad = [
  "import { useState } from 'react';\nexport function useFormatPrice(cents: number) { return `$${(cents / 100).toFixed(2)}`; }",
  "import { memo } from 'react';\nexport const useIsAdmin = (user: User) => user.role === 'admin';",
  "import { useMemo } from 'react';\nexport function cartTotal() {\n  const items = useCart();\n  return items.length;\n}",
  "export const currentUser = () => useContext(UserContext);",
  "import { useQuery } from '@tanstack/react-query';\nexport function useExploreApi(scope: Scope) { return { ...createApi(scope) }; }",
];

export const good = [
  "export function useCartTotal() {\n  const items = useCart();\n  return items.length;\n}",
  "export const useTheme = () => React.useContext(ThemeContext);",
  "export function formatPrice(cents: number) { return `$${(cents / 100).toFixed(2)}`; }",
  "export function Cart() {\n  const items = useCart();\n  return items.length;\n}",
  "import { use } from 'react';\nexport function useData(url: string) { return use(fetchData(url)); }",
  "export function useSupportModels(models: Models) { override = models; }",
  "import { create } from 'zustand';\nimport 'react';\nexport const useCartStore = create((set) => ({ items: [], clear: () => set({ items: [] }) }));",
  "export async function refresh(id: string) { return use((db) => db.find(id)); }",
  "app.use(function logger(req, res, next) { useless(); next(); });",
  "import { useServedCollector } from '../shared/config.mjs';\nexport async function ensureCollector(url: string) { useServedCollector(url); }",
  "import { trpc } from './trpc';\nimport 'react';\nexport const useUser = (id: string) => trpc.user.get.useQuery({ id });\nexport function useSearch() { return Route.useSearch(); }",
  "async function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  app.useGlobalPipes(new ValidationPipe());\n}\nbootstrap();",
];
