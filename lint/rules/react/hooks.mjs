// @ts-check
// Syntax helpers the react rules share.

/** True for `useX(...)` or `React.useX(...)` where X matches. @param {any} node @param {RegExp} name */
export const isHookCall = (node, name) =>
  node?.type === "CallExpression" && name.test(node.callee.type === "MemberExpression" ? node.callee.property.name ?? "" : node.callee.name ?? "");

export const EFFECT = /^use(?:Layout)?Effect$/;

/**
 * Every node under `node`, depth first, the root included, with its parent (oxlint does not set `parent` on every node).
 * @param {any} node @param {(n: any, parent: any) => void} visit @param {any} [parent]
 */
export function walk(node, visit, parent = node?.parent) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key in node) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const v of value) walk(v, visit, node);
    else if (value && typeof value === "object" && typeof value.type === "string") walk(value, visit, node);
  }
}

/** The nearest enclosing function, or undefined. @param {any} node */
export function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (n.type.endsWith("FunctionExpression") || n.type === "FunctionDeclaration") return n;
  return undefined;
}

/** The name a function is declared under (`function Row()`, `const Row = () => …`, `const Row = memo(() => …)`). @param {any} fn */
export function functionName(fn) {
  if (fn.id?.name) return fn.id.name;
  let n = fn.parent;
  while (n?.type === "CallExpression") n = n.parent; // memo(...), forwardRef(...)
  return n?.type === "VariableDeclarator" && n.id.type === "Identifier" ? n.id.name : undefined;
}

/** A component (PascalCase) or a custom hook (useX). @param {any} fn */
export const isComponentOrHook = (fn) => /^(?:[A-Z]|use[A-Z0-9])/.test(functionName(fn) ?? "");

/** `[value, setValue] = useState(...)` declarations directly in a function body: setter name -> state name. @param {any} fn */
export function stateSetters(fn) {
  /** @type {Map<string, string>} */
  const setters = new Map();
  for (const statement of fn.body?.body ?? []) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const d of statement.declarations) {
      const [value, setter] = d.id.type === "ArrayPattern" ? d.id.elements : [];
      if (setter?.type === "Identifier" && isHookCall(d.init, /^useState$/)) setters.set(setter.name, value?.type === "Identifier" ? value.name : "");
    }
  }
  return setters;
}
