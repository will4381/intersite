// @ts-check
import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, walk } from "../shared.mjs";
import { stateSetters } from "./hooks.mjs";

/** Methods whose result moves items to other positions as the inputs change. */
const reorders = /^(?:filter|sort|toSorted|reverse|toReversed)$/;

/** `items.filter(…)` or `[...items].sort(…)`, through any chain (`items.filter(f).map(g)`). @param {any} n */
const reordered = (n) => {
  let found = false;
  for (; n?.type === "CallExpression" && n.callee.type === "MemberExpression"; n = n.callee.object) found ||= reorders.test(n.callee.property.name ?? "");
  // [a, b].filter(Boolean) is a fixed list with gaps closed; [...rows].sort() is not.
  return found && (n?.type !== "ArrayExpression" || n.elements.some((/** @type {any} */ e) => e?.type === "SpreadElement"));
};

export const id = "no-index-key-on-changing-list";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      index: "`{{list}}` is {{why}}, so its items change position, and an index key hands one item's DOM and state (an input's text, an open row) to whichever item lands in its place. Key by something the item owns, such as {{item}}.id.",
    },
  },
  createOnce(context) {
    return {
      "JSXAttribute[name.name='key']"(node) {
        const expression = node.value?.type === "JSXExpressionContainer" ? node.value.expression : undefined;
        if (!expression) return;
        // The nearest .map((item, index) => …) whose index the key reads.
        let fn = enclosingFunction(node);
        while (fn && !(fn.parent.type === "CallExpression" && fn.parent.arguments[0] === fn && fn.parent.callee.property?.name === "map")) fn = enclosingFunction(fn);
        const [item, index] = fn?.params ?? [];
        if (item?.type !== "Identifier" || item.name.startsWith("_") || index?.type !== "Identifier") return;
        /** @type {Set<string>} */
        const names = new Set();
        walk(expression, (n) => void (n.type === "Identifier" && names.add(n.name)));
        const readsIndex = names.has(index.name);
        const readsItem = names.has(item.name);
        if (!readsIndex || readsItem) return; // `${item.date}-${i}` is unique enough

        const list = fn.parent.callee.object;
        const component = enclosingFunction(fn.parent);
        let why = "";
        if (reordered(list)) why = "filtered or sorted";
        else if (list.type === "Identifier" && component) {
          // State only counts when it is set to a filtered or sorted copy (a removed todo); an appended log keeps its positions.
          const setter = [...stateSetters(component)].find(([, value]) => value === list.name)?.[0];
          walk(component.body, (n) => {
            if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.id.name === list.name && reordered(n.init)) why = "filtered or sorted";
            if (setter && n.type === "CallExpression" && n.callee.name === setter) walk(n.arguments[0], (a) => void (reordered(a) && (why = "state that items are removed from or reordered in")));
          });
        }
        if (why) context.report({ node, messageId: "index", data: { list: context.sourceCode.getText(list), why, item: item.name } });
      },
    };
  },
});

export const bad = [
  "export function Todos() {\n  const [todos, setTodos] = useState([]);\n  return <ul>{todos.map((todo, i) => <Todo key={i} todo={todo} onRemove={() => setTodos(todos.filter((t) => t !== todo))} />)}</ul>;\n}",
  "export function Results({ items, query }) {\n  return <ul>{items.filter((item) => item.name.includes(query)).map((item, index) => <li key={index}>{item.name}</li>)}</ul>;\n}",
  "export function Table({ rows, by }) {\n  const sorted = [...rows].sort((a, b) => a[by] - b[by]);\n  return <tbody>{sorted.map((row, i) => <Row key={`row-${i}`} row={row} />)}</tbody>;\n}",
];

export const good = [
  // A fixed list never moves.
  "export function Skeleton() {\n  return <div>{Array.from({ length: 5 }).map((_, i) => <Line key={i} />)}</div>;\n}",
  "export function Faq() {\n  return <dl>{faqs.map((faq, index) => <Item key={index} faq={faq} />)}</dl>;\n}",
  "export function Results({ items, query }) {\n  return <ul>{items.filter((item) => item.name.includes(query)).map((item) => <li key={item.id}>{item.name}</li>)}</ul>;\n}",
  "export function Log() {\n  const [lines, setLines] = useState([]);\n  useEffect(() => subscribe((line) => setLines((prev) => [...prev, line])), []);\n  return <pre>{lines.map((line, i) => <div key={i}>{line}</div>)}</pre>;\n}",
  "export function Meta({ a, b }) {\n  const parts = [a, b].filter(Boolean);\n  return <p>{parts.map((part, i) => <span key={i}>{part}</span>)}</p>;\n}",
  "export function Slots({ slots }) {\n  const open = slots.filter((s) => s.open);\n  return <ul>{open.map((slot, i) => <li key={`${slot.time}-${i}`}>{slot.time}</li>)}</ul>;\n}",
];
