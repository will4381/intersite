// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, fromSource, isStorageRead, notShipped, unwrap } from "../shared.mjs";

/** Inside the block of a `try` (not its catch or finally), or a `.catch()`/`safeParse`-style wrapper. @param {any} node */
function guarded(node) {
  for (let n = node; n.parent; n = n.parent) {
    if (n.parent.type === "TryStatement" && n.parent.block === n) return true;
    if (/Function(Expression|Declaration)$/.test(n.type) && /^(safeJson|tryParse|safeParse|attempt)/i.test(calleeName(n.parent))) return true;
  }
  return false;
}

/** A value from storage, maybe behind `?? '{}'` or `|| 'null'`. @param {any} node */
function stored(node) {
  node = unwrap(node);
  while (node?.type === "LogicalExpression") node = unwrap(node.left);
  return isStorageRead(node);
}

export const id = "no-unguarded-storage-parse";
export const pack = "validation";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      parse: "localStorage holds whatever an older build, another tab, a browser extension or the user wrote there, so JSON.parse here can throw on the first load after a change and take the page down with it. Wrap it in try/catch with a fallback, and check the shape of what comes back (Schema.safeParse) before using it.",
    },
  },
  createOnce(context) {
    return {
      before: () => !notShipped(context),
      CallExpression(node) {
        if (calleeName(node) !== "parse" || /** @type {any} */ (node.callee).object?.name !== "JSON") return;
        const arg = node.arguments[0];
        if (arg && fromSource(arg, stored, context.sourceCode) && !guarded(node)) context.report({ node, messageId: "parse" });
      },
    };
  },
});

export const bad = [
  "const cart = JSON.parse(localStorage.getItem('cart') ?? '[]');",
  "function load() { const raw = localStorage.getItem('prefs'); return raw ? JSON.parse(raw) : defaults; }",
  "const [user, setUser] = useState(() => JSON.parse(sessionStorage.getItem('user') || 'null'));",
  "export const draft = JSON.parse(window.localStorage.getItem('draft')!) as Draft;",
];

export const good = [
  "function load() { try { return Prefs.parse(JSON.parse(localStorage.getItem('prefs') ?? '{}')); } catch { return defaults; } }",
  "const cart = JSON.parse(text);",
  "function load() { const raw = localStorage.getItem('prefs'); if (!raw) return defaults; try { return JSON.parse(raw); } catch { return defaults; } }",
  "localStorage.setItem('cart', JSON.stringify(cart));",
];
