// @ts-check
import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, walk } from "../shared.mjs";
import { EFFECT, isHookCall, stateSetters } from "./hooks.mjs";

/** Globals a value computed during render may use. Anything else not in the dependency list (a ref, `window`, `Date`) means the effect reads the outside world. */
const pure = new Set(["Math", "String", "Number", "Boolean", "Object", "Array", "JSON", "undefined", "NaN", "Infinity"]);

/** The root identifier of a dependency (`user` for `user.name`). @param {any} node */
const root = (node) => {
  while (node?.type === "MemberExpression" || node?.type === "ChainExpression") node = node.type === "ChainExpression" ? node.expression : node.object;
  return node?.type === "Identifier" ? node.name : undefined;
};

export const id = "no-derived-state-effect";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      derived: "This effect only copies a value computed from {{deps}} into state, so every change renders twice and the first render shows the stale value. Compute it during render instead (const {{state}} = …, in useMemo only if it is expensive) and delete the state and the effect.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const [callback, deps] = node.arguments;
        if (!isHookCall(node, EFFECT) || !callback?.type.endsWith("FunctionExpression") || deps?.type !== "ArrayExpression" || !deps.elements.length) return;
        const component = enclosingFunction(node);
        if (!component) return;
        const setters = stateSetters(component);
        const depNames = new Set(deps.elements.map(root));
        /** @type {any[]} */
        const calls = [];
        /** Only setter calls, optionally under ifs. @param {any} s */
        const onlySets = (s) => {
          if (!s) return true;
          if (s.type === "BlockStatement") return s.body.every(onlySets);
          if (s.type === "IfStatement") return onlySets(s.consequent) && onlySets(s.alternate);
          const call = s.type === "ExpressionStatement" ? s.expression : s;
          if (call.type !== "CallExpression" || !setters.has(call.callee.name) || call.arguments.length !== 1) return false;
          calls.push(call);
          return !call.arguments[0].type.endsWith("FunctionExpression"); // setX(prev => …) accumulates, which render cannot
        };
        if (!onlySets(callback.body) || !calls.length) return;

        // Every name the effect reads is a dependency, a pure global, or local to a callback inside it (`items.filter((i) => …)`).
        const locals = new Set();
        walk(callback.body, (n) => void (n.type.endsWith("FunctionExpression") && walk({ type: "Params", params: n.params }, (p) => void (p.type === "Identifier" && locals.add(p.name)))));
        let readsDep = false;
        let outside = false;
        walk(callback.body, (n, parent) => {
          if (n.type !== "Identifier" || setters.has(n.name) || locals.has(n.name)) return;
          if ((parent.type === "MemberExpression" && parent.property === n && !parent.computed) || (parent.type === "Property" && parent.key === n && !parent.shorthand)) return;
          if (depNames.has(n.name)) readsDep = true;
          else if (!pure.has(n.name)) outside = true;
        });
        if (!readsDep || outside) return;

        // The state is only ever set here: set anywhere else (an input's onChange), it is real state reset by the effect.
        const set = new Set(calls.map((c) => c.callee.name));
        let elsewhere = false;
        walk(component.body, (n, parent) => {
          if (n.type === "Identifier" && set.has(n.name) && parent.type !== "ArrayPattern" && !(n.start >= callback.start && n.end <= callback.end)) elsewhere = true;
        });
        if (elsewhere) return;
        const state = [...set].map((s) => setters.get(s) || s).join(", ");
        context.report({ node, messageId: "derived", data: { deps: deps.elements.map((/** @type {any} */ d) => context.sourceCode.getText(d)).join(", "), state } });
      },
    };
  },
});

export const bad = [
  "export function Name({ first, last }) {\n  const [full, setFull] = useState('');\n  useEffect(() => { setFull(first + ' ' + last); }, [first, last]);\n  return <p>{full}</p>;\n}",
  "export function Results({ items, query }) {\n  const [visible, setVisible] = useState([]);\n  useEffect(() => {\n    setVisible(items.filter((item) => item.name.includes(query)));\n  }, [items, query]);\n  return <List items={visible} />;\n}",
  "export function Mirror({ value }) {\n  const [current, setCurrent] = React.useState(value);\n  React.useEffect(() => { if (value) setCurrent(value); }, [value]);\n  return <p>{current}</p>;\n}",
  "export function Count({ items }) {\n  const [count, setCount] = useState(0);\n  const [empty, setEmpty] = useState(true);\n  useEffect(() => { setCount(items.length); setEmpty(items.length === 0); }, [items]);\n  return <p>{empty ? 'none' : count}</p>;\n}",
];

export const good = [
  // Set by the user too: the effect resets real state when the prop changes.
  "export function Field({ value }) {\n  const [draft, setDraft] = useState(value);\n  useEffect(() => { setDraft(value); }, [value]);\n  return <input value={draft} onChange={(e) => setDraft(e.target.value)} />;\n}",
  // Reads the DOM through a ref: only an effect can measure.
  "export function Panel({ open }) {\n  const ref = useRef(null);\n  const [height, setHeight] = useState(0);\n  useLayoutEffect(() => { setHeight(ref.current.offsetHeight); }, [open]);\n  return <div ref={ref} style={{ height }} />;\n}",
  // Mount flag for hydration: no dependency feeds it.
  "export function ClientOnly({ children }) {\n  const [mounted, setMounted] = useState(false);\n  useEffect(() => { setMounted(true); }, []);\n  return mounted ? children : null;\n}",
  // Accumulates across changes, which render cannot.
  "export function History({ value }) {\n  const [seen, setSeen] = useState([]);\n  useEffect(() => { setSeen((prev) => [...prev, value]); }, [value]);\n  return <p>{seen.length}</p>;\n}",
  // Does more than set state.
  "export function Title({ name }) {\n  const [label, setLabel] = useState('');\n  useEffect(() => { document.title = name; setLabel(name.toUpperCase()); }, [name]);\n  return <h1>{label}</h1>;\n}",
  "export function Clock({ zone }) {\n  const [now, setNow] = useState('');\n  useEffect(() => { setNow(new Date().toLocaleString('en', { timeZone: zone })); }, [zone]);\n  return <time>{now}</time>;\n}",
];
