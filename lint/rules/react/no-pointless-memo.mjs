// @ts-check
import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, walk } from "../shared.mjs";
import { isHookCall } from "./hooks.mjs";

/**
 * A value as cheap to compute as to look up, with no identity to keep: a primitive literal, a name, a property
 * read, or operators over those. Calls, `new`, arrays, objects, functions and JSX are not trivial.
 * @param {any} n
 * @returns {boolean}
 */
const trivial = (n) => {
  switch (n?.type) {
    case "Literal": return !n.regex;
    case "Identifier": return true;
    case "ChainExpression": return trivial(n.expression);
    case "MemberExpression": return trivial(n.object) && (!n.computed || trivial(n.property));
    case "TemplateLiteral": return n.expressions.every(trivial);
    case "UnaryExpression": return trivial(n.argument);
    case "BinaryExpression":
    case "LogicalExpression": return trivial(n.left) && trivial(n.right);
    case "ConditionalExpression": return trivial(n.test) && trivial(n.consequent) && trivial(n.alternate);
    case "TSAsExpression":
    case "TSNonNullExpression": return trivial(n.expression);
    default: return false;
  }
};

/** What a callback returns: its expression body, or the argument of a body that is one return. @param {any} fn */
const returned = (fn) => (fn.body.type !== "BlockStatement" ? fn.body : fn.body.body.length === 1 && fn.body.body[0].type === "ReturnStatement" ? fn.body.body[0].argument : undefined);

export const id = "no-pointless-memo";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      value: "useMemo around `{{value}}` costs more than computing it: the value is a cheap read with no identity to keep stable. Write const x = {{value}} directly.",
      forward: "This useCallback only forwards its arguments to `{{callee}}`. Pass {{callee}} itself.",
      host: "`{{name}}` is only passed to built-in elements ({{elements}}), which do not compare handler identity, so useCallback buys nothing here. Use a plain function.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const [callback, deps] = node.arguments;
        if (!callback?.type.endsWith("FunctionExpression") || deps?.type !== "ArrayExpression") return;
        if (isHookCall(node, /^useMemo$/)) {
          const value = returned(callback);
          if (trivial(value)) context.report({ node, messageId: "value", data: { value: context.sourceCode.getText(value) } });
          return;
        }
        if (!isHookCall(node, /^useCallback$/)) return;

        // (value) => setValue(value): the same arguments, in order, to a plain function (a method would lose its `this`).
        const call = returned(callback);
        const params = callback.params;
        if (
          call?.type === "CallExpression" && call.callee.type === "Identifier" && params.length && call.arguments.length === params.length &&
          params.every((/** @type {any} */ p, /** @type {number} */ i) => p.type === "Identifier" && call.arguments[i].type === "Identifier" && call.arguments[i].name === p.name)
        ) {
          context.report({ node, messageId: "forward", data: { callee: call.callee.name } });
          return;
        }

        const declarator = node.parent;
        const component = enclosingFunction(node);
        if (declarator.type !== "VariableDeclarator" || declarator.id.type !== "Identifier" || !component) return;
        const name = declarator.id.name;
        let uses = 0;
        /** Elements it is a prop of, when that element is built in (`<button onClick={cb}>`). */
        const hosts = new Set();
        let hostUses = 0;
        walk(component.body, (n) => {
          if (n.type === "Identifier" && n.name === name && n !== declarator.id) uses++;
          if (n.type !== "JSXOpeningElement" || n.name.type !== "JSXIdentifier" || !/^[a-z]/.test(n.name.name)) return;
          for (const a of n.attributes) {
            // A callback ref is the exception: a new one each render detaches and reattaches the node.
            if (a.type === "JSXAttribute" && a.name.name !== "ref" && a.value?.expression?.type === "Identifier" && a.value.expression.name === name) {
              hostUses++;
              hosts.add(`<${n.name.name}>`);
            }
          }
        });
        if (uses && uses === hostUses) context.report({ node, messageId: "host", data: { name, elements: [...hosts].join(", ") } });
      },
    };
  },
});

export const bad = [
  "export function Total({ cart }) {\n  const count = useMemo(() => cart.items.length, [cart.items]);\n  return <p>{count}</p>;\n}",
  "export function Badge({ a, b }) {\n  const sum = React.useMemo(() => { return a + b; }, [a, b]);\n  return <p>{sum}</p>;\n}",
  "export function Flag() {\n  const enabled = useMemo(() => true, []);\n  return <p>{String(enabled)}</p>;\n}",
  "export function Input() {\n  const [value, setValue] = useState('');\n  const onChange = useCallback((next) => setValue(next), []);\n  return <Field value={value} onChange={onChange} />;\n}",
  "export function Save({ save, id }) {\n  const onClick = useCallback(() => save(id), [save, id]);\n  return <button onClick={onClick}>Save</button>;\n}",
];

export const good = [
  // A stable identity for an object or array dependency is the point of useMemo.
  "export function Chart({ a, b }) {\n  const options = useMemo(() => ({ a, b }), [a, b]);\n  return <Plot options={options} />;\n}",
  "export function List({ items }) {\n  const rows = useMemo(() => items ?? [], [items]);\n  return <Table rows={rows} />;\n}",
  "export function Search({ items, query }) {\n  const hits = useMemo(() => items.filter((i) => i.name.includes(query)), [items, query]);\n  return <Table rows={hits} />;\n}",
  // Handed to a component, or used as a dependency, its identity matters.
  "export function Save({ save, id }) {\n  const onClick = useCallback(() => save(id), [save, id]);\n  return <Button onClick={onClick}>Save</Button>;\n}",
  "export function Watch({ load, id }) {\n  const refresh = useCallback(() => load(id), [load, id]);\n  useEffect(() => { refresh(); }, [refresh]);\n  return <button onClick={refresh}>Reload</button>;\n}",
  "export function Dock() {\n  const [inSheet, setInSheet] = useState(false);\n  const marker = useCallback((node) => { if (node) setInSheet(Boolean(node.closest('[role=dialog]'))); }, []);\n  return <span ref={marker} data-sheet={inSheet} />;\n}",
  // Not a pure forward: no arguments (onClick would pass the event), or a method that needs its `this`.
  "export function Reload({ refetch }) {\n  const onReload = useCallback(() => refetch(), [refetch]);\n  return <Toolbar onReload={onReload} />;\n}",
  "export function Pick({ store }) {\n  const onPick = useCallback((id) => store.select(id), [store]);\n  return <Picker onPick={onPick} />;\n}",
];
