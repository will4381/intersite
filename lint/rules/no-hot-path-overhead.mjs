// @ts-check
import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, isMethodCall } from "./shared.mjs";

/** Files a project marks as running on every request: `*.hot.ts`, `*.hot.tsx`. */
const HOT_FILE = /\.hot\.[cm]?[jt]sx?$/;
/** Calls that only declare at module scope: `Symbol("x")`, `new Map(Object.entries(x))`, `Object.freeze({...})`. */
const DECLARING = new Set(["Symbol", "Object", "Set", "Map"]);

export const id = "no-hot-path-overhead";
export const pack = "perf";
export const ext = "hot.ts";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      regex: "This regular expression is built again on every call, and a .hot. file runs on every request. Hoist it to a module-level constant.",
      dynamicImport: "A dynamic import() makes the request wait while a module loads, and a .hot. file runs on every request. Import it statically at the top of the file.",
      deepCopy: "A deep copy (structuredClone or a JSON round trip) copies the whole object on every request in a .hot. file. Read or copy only the fields you need.",
      moduleWork: "Module scope runs when the server or worker starts, often under a tight CPU limit, and slows every cold start. Only declare things at module scope; do the work inside the function that needs it.",
    },
  },
  createOnce(context) {
    return {
      before: () => HOT_FILE.test(context.filename),
      Literal(node) {
        if (/** @type {any} */ (node).regex && enclosingFunction(node)) context.report({ node, messageId: "regex" });
      },
      NewExpression(node) {
        if (/** @type {any} */ (node.callee).name === "RegExp" && enclosingFunction(node)) context.report({ node, messageId: "regex" });
      },
      ImportExpression(node) {
        context.report({ node, messageId: "dynamicImport" });
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.name === "structuredClone" || (isMethodCall(node, "JSON", "parse") && isMethodCall(node.arguments[0], "JSON", "stringify"))) return context.report({ node, messageId: "deepCopy" });
        if (enclosingFunction(node) || node.parent?.type === "NewExpression" || DECLARING.has(callee.name) || callee.object?.name === "Object") return;
        context.report({ node, messageId: "moduleWork" });
      },
    };
  },
});

export const bad = [
  "export function slug(title: string) { return title.replace(/[^a-z0-9]+/g, '-'); }",
  "export function matches(path: string, prefix: string) { return new RegExp(`^${prefix}`).test(path); }",
  "export async function handle(request: Request) { const { render } = await import('./render.js'); return render(request); }",
  "export function snapshot(state: State) { return structuredClone(state); }",
  "export function copy(body: Body) { return JSON.parse(JSON.stringify(body)); }",
  "const routes = buildRouteTable(manifest);\nexport function route(path: string) { return routes.get(path); }",
];

export const good = [
  "const SLUG = /[^a-z0-9]+/g;\nexport function slug(title: string) { return title.replace(SLUG, '-'); }",
  "import { render } from './render.js';\nexport function handle(request: Request) { return render(request); }",
  "export function pick(body: Body) { return { id: body.id, name: body.name }; }",
  "const KIND = Symbol('kind');\nconst cache = new Map(Object.entries(seed));\nconst LIMITS = Object.freeze({ max: 10 });\nexport function limit(key: string) { return cache.get(key) ?? LIMITS.max; }",
  "let routes: Map<string, Route> | undefined;\nexport function route(path: string) { routes ??= buildRouteTable(manifest); return routes.get(path); }",
];
