// @ts-check
import { defineRule } from "@oxlint/plugins";

import { mentions } from "../shared.mjs";
import { functionName, isComponentOrHook, isHookCall } from "./hooks.mjs";

const NEEDS = /useState/;
/** Effects run after render. A dependency list is read during render, so what it names is drawn from. */
const EFFECTS = /^use(?:Layout|Insertion)?Effect$/;
const FUNCTION = /^(?:FunctionExpression|ArrowFunctionExpression)$/;

// ponytail: an event prop is known by its `on` name; a component's own prop types could say which props it calls later.
/** Whether an expression is handed straight to a JSX event prop (`onPress={x}`). @param {any} node */
const isEventProp = (node) => node.parent?.type === "JSXExpressionContainer" && node.parent.parent?.type === "JSXAttribute" && /^on[A-Z]/.test(node.parent.parent.name.name ?? "");

/**
 * Whether a function runs only after render: the callback of an effect with a dependency list or of useEffectEvent, a
 * JSX event handler (`onPress={() => …}`), or a `const` (or useCallback) holding one that is only ever used in those
 * places. An effect with no dependency list runs after every render, so the state it reads drives it. Any other
 * function (a `map` callback, a render prop, useMemo, a render helper in useCallback) may run while rendering.
 * @param {any} fn @param {any} component @param {any} sourceCode @param {number} depth
 */
function runsLater(fn, component, sourceCode, depth) {
  let up = fn.parent;
  if (up?.type === "CallExpression" && up.arguments[0] === fn) {
    if (isHookCall(up, EFFECTS)) return up.arguments.length > 1;
    if (isHookCall(up, /^useEffectEvent$/)) return true;
    if (!isHookCall(up, /^useCallback$/)) return false;
    // A useCallback runs when its result is called: judged by where that result is used.
    fn = up;
    up = up.parent;
  }
  if (isEventProp(fn)) return true;
  if (up?.type !== "VariableDeclarator" || up.init !== fn || up.id.type !== "Identifier" || depth > 3) return false;
  const uses = sourceCode.getScope(component).set.get(up.id.name)?.references.filter((/** @type {any} */ r) => r.isRead()) ?? [];
  return uses.length > 0 && uses.every((/** @type {any} */ r) => isEventProp(r.identifier) || readLater(r.identifier, component, sourceCode, depth + 1));
}

/**
 * Whether a read happens after render: some function between it and the component runs only later.
 * @param {any} node @param {any} component @param {any} sourceCode @param {number} [depth]
 */
function readLater(node, component, sourceCode, depth = 0) {
  for (let n = node.parent; n && n !== component; n = n.parent) if (FUNCTION.test(n.type) && runsLater(n, component, sourceCode, depth)) return true;
  return false;
}

export const id = "no-undrawn-state";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      undrawn: "`{{state}}` is read only in effects and event handlers, never while {{name}} renders, so it does not need to be state: each `{{setter}}` call asks for a render of {{name}} that draws nothing new from it. Keep it in a ref (`useRef`) and read `.current` where it is used.",
    },
  },
  createOnce(context) {
    return {
      before: () => mentions(context, NEEDS),
      VariableDeclarator(/** @type {any} */ node) {
        const [value, setter] = node.id.type === "ArrayPattern" ? node.id.elements : [];
        if (value?.type !== "Identifier" || setter?.type !== "Identifier" || !isHookCall(node.init, /^useState$/)) return;
        const component = node.parent?.parent?.parent;
        if (!FUNCTION.test(component?.type ?? "") && component?.type !== "FunctionDeclaration") return;
        if (!isComponentOrHook(component)) return;
        const scope = context.sourceCode.getScope(component);
        const reads = scope.set.get(value.name)?.references.filter((/** @type {any} */ r) => r.isRead()) ?? [];
        const sets = scope.set.get(setter.name)?.references.filter((/** @type {any} */ r) => r.isRead()) ?? [];
        // Never read is a value nobody uses, or a setter kept to force a render: neither is this rule's.
        if (!reads.length || !sets.length || !reads.every((/** @type {any} */ r) => readLater(r.identifier, component, context.sourceCode))) return;
        context.report({ node, messageId: "undrawn", data: { state: value.name, setter: setter.name, name: functionName(component) ?? "the component" } });
      },
    };
  },
});

export const bad = [
  // A view kept for measuring later renders the screen a second time as it mounts.
  "export function Tour() {\n  const [target, setTarget] = useState<View | null>(null);\n  return <View ref={setTarget} onTouchEnd={() => target?.measure(show)} />;\n}",
  "export function Sheet({ onOpen }: { onOpen: (h: number) => void }) {\n  const [height, setHeight] = useState(0);\n  const open = () => onOpen(height);\n  return <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}><Button onPress={open} /></View>;\n}",
  "export function Form() {\n  const [sending, setSending] = useState(false);\n  const submit = useCallback(async () => {\n    if (sending) return;\n    setSending(true);\n    await save();\n    setSending(false);\n  }, []);\n  return <button onClick={submit}>Save</button>;\n}",
  "export const usePoll = () => {\n  const [timer, setTimer] = React.useState<number>();\n  useEffect(() => {\n    setTimer(window.setInterval(tick, 1000));\n    return () => clearInterval(timer);\n  }, []);\n};",
];

export const good = [
  "export function Counter() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>{count}</button>;\n}",
  // Read in a dependency list: the effect runs again when it changes.
  "export function Search() {\n  const [query, setQuery] = useState('');\n  useEffect(() => {\n    if (query) find(query);\n  }, [query]);\n  return <input onChange={(e) => setQuery(e.target.value)} />;\n}",
  // A map callback and a render prop run while rendering.
  "export function List({ rows }: { rows: Row[] }) {\n  const [picked, setPicked] = useState('');\n  return <ul>{rows.map((r) => <li key={r.id} aria-selected={r.id === picked} onClick={() => setPicked(r.id)} />)}</ul>;\n}",
  "export function Anchor() {\n  const [node, setNode] = useState<HTMLElement | null>(null);\n  const { floatingStyles } = useFloating({ elements: { reference: node } });\n  return <button ref={setNode} style={floatingStyles} />;\n}",
  // An effect with no dependency list runs after every render: setting the state is what runs it again.
  "export function Picker({ busy }: { busy: boolean }) {\n  const [pick, setPick] = useState<false | 'settled'>(false);\n  useEffect(() => {\n    if (pick === 'settled' && !busy) setPick(false);\n  });\n  return <Button onPress={() => setPick('settled')} />;\n}",
  // A render helper in useCallback runs while rendering.
  "export function Jobs({ jobs }: { jobs: Job[] }) {\n  const [refreshing, setRefreshing] = useState(false);\n  const renderList = useCallback(() => <FlatList data={jobs} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => setRefreshing(true)} />} />, [jobs]);\n  return renderList();\n}",
  // A setter with no value read is kept to force a render.
  "export function Clock() {\n  const [, setTick] = useState(0);\n  useEffect(() => {\n    const id = setInterval(() => setTick((t) => t + 1), 1000);\n    return () => clearInterval(id);\n  }, []);\n  return <time>{Date.now()}</time>;\n}",
  // A helper called while rendering draws from it.
  "export function Badge() {\n  const [count, setCount] = useState(0);\n  const label = () => `${count} new`;\n  return <Text onPress={() => setCount(0)}>{label()}</Text>;\n}",
  // A hook hands the value to whoever renders it.
  "export function useToggle() {\n  const [on, setOn] = useState(false);\n  const flip = useCallback(() => setOn(!on), [on]);\n  return { on, flip };\n}",
];
