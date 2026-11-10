// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile, unwrap } from "../shared.mjs";
import { CASTS } from "./classes.mjs";

const GLOBAL = /^(?:window|globalThis|global|self)$/;
// Browser properties that are meant to be set: navigation, the window name, event handler slots.
const SETTABLE = /^(?:location|name|on[a-z]+)$/;
// Platform globals Node lacks. Replacing a platform global is a polyfill or a deliberate patch (a fetch interceptor),
// not new app state, so those are left to review.
const BROWSER = /^(?:scheduler|requestIdleCallback|cancelIdleCallback|requestAnimationFrame|cancelAnimationFrame|(?:Intersection|Resize|Mutation|Performance)Observer|matchMedia|localStorage|sessionStorage|indexedDB|XMLHttpRequest|ResizeObserverEntry)$/;

// Globals a third-party script defines its contract by: analytics queues and config objects it reads on load.
const THIRD_PARTY = /^(?:dataLayer|gtag|fbq|_fbq|_paq|ttq|twq|rdt|lintrk|_hsq|hj|clarity|plausible|umami|analytics|Intercom|intercomSettings|\$crisp|CRISP_\w+|grecaptcha|turnstile|MonacoEnvironment)$/;

/** Whether a global name is new state rather than a platform global or a settable browser slot. @param {string | undefined} key */
const isNewGlobal = (key) => !key || !(SETTABLE.test(key) || BROWSER.test(key) || THIRD_PARTY.test(key) || key in globalThis);

/** `window`, `(window as any)`, `globalThis` and friends, else undefined. @param {any} node */
const globalObject = (node) => {
  const object = unwrap(node, CASTS);
  return object?.type === "Identifier" && GLOBAL.test(object.name) ? object.name : undefined;
};

/** `Object.freeze(...)`: a frozen value on a global is configuration, not state. @param {any} node */
const isFrozen = (node) => node?.type === "CallExpression" && node.callee.object?.name === "Object" && node.callee.property?.name === "freeze";

export const id = "no-global-assignment";
export const pack = "globals";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ target }}` puts state on the global object, where any code can change it, nothing types or imports it, and on a server every request shares it. Export it from a module (or pass it in as an argument or React context); for a deliberate global, declare it once in a setup file with `declare global`.",
    },
  },
  createOnce(context) {
    return {
      // Test setup stubs globals on purpose; classic scripts (no import or export) talk to each other through window.
      before() {
        if (isTestFile(context) || /(?:^|[./-])setup\.[cm]?[jt]sx?$/.test(context.filename)) return false;
        if (!context.sourceCode.ast.body.some((/** @type {any} */ s) => /^(?:Import|Export)/.test(s.type))) return false;
      },
      AssignmentExpression(/** @type {any} */ node) {
        const left = unwrap(node.left, CASTS);
        if (left.type !== "MemberExpression" || isFrozen(node.right)) return;
        const name = globalObject(left.object);
        const key = left.computed ? undefined : left.property.name;
        if (name && isNewGlobal(key)) context.report({ node, messageId: "found", data: { target: `${name}.${key ?? "[…]"}` } });
      },
      CallExpression(/** @type {any} */ node) {
        const { callee } = node;
        if (callee.object?.name !== "Object" || callee.property?.name !== "assign") return;
        const [target, source] = node.arguments;
        const name = globalObject(target);
        const keys = source?.type === "ObjectExpression" ? source.properties.map((/** @type {any} */ p) => p.key?.name) : [undefined];
        if (name && keys.some(isNewGlobal)) context.report({ node, messageId: "found", data: { target: `Object.assign(${name}, …)` } });
      },
    };
  },
});

export const bad = [
  "import { createStore } from './store';\n(window as any).store = createStore();",
  "export const cache = new Map();\nglobalThis.__cache = cache;",
  "export function track(id: string) { window.lastEventId = id; }",
  "import { api } from './api';\nObject.assign(window, { api });",
  "export function init() { globalThis.queue ??= []; }",
];

export const good = [
  "export function go(url: string) { window.location.href = url; window.onbeforeunload = null; }",
  "export const runtimeConfig = {};\nwindow.__APP_CONFIG__ = Object.freeze({ apiUrl: '/api' });",
  "window.Icons = { names: [] };",
  "export function install(original: typeof fetch) { globalThis.fetch = (input, init) => original(input, init); }",
  "import { sleep } from './sleep';\nif (!('scheduler' in globalThis)) Object.assign(globalThis, { scheduler: { wait: sleep } });",
  "const globalForDb = globalThis as unknown as { db?: object };\nexport const db = (globalForDb.db ??= {});",
  "export function loadAnalytics() {\n  window.dataLayer = window.dataLayer || [];\n  window.gtag = function gtag() { window.dataLayer.push(arguments); };\n}",
];
