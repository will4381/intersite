// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";
import { isComponentOrHook, isHookCall } from "./hooks.mjs";

const fresh = /^(?:ArrayExpression|ObjectExpression|ArrowFunctionExpression|FunctionExpression|NewExpression)$/;

/** The object patterns a function body destructures `name` into (`const { items = [] } = props`). @param {any} fn @param {string} name */
const destructured = (fn, name) =>
  (fn.body?.body ?? []).flatMap((/** @type {any} */ s) => (s.type === "VariableDeclaration" ? s.declarations : []))
    .filter((/** @type {any} */ d) => d.id.type === "ObjectPattern" && d.init?.type === "Identifier" && d.init.name === name)
    .map((/** @type {any} */ d) => d.id);

export const id = "no-unstable-default-dependency";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      unstable: "`{{name}} = {{value}}` builds a new value on every render the prop is omitted, and {{name}} is a dependency of {{hook}}, so it re-runs on every render (and loops if it sets state). Hoist the default to a module constant (const EMPTY: Item[] = []) and default to that.",
    },
  },
  createOnce(context) {
    return {
      ":function"(fn) {
        if (!isComponentOrHook(fn)) return;
        const param = fn.params[0]?.type === "AssignmentPattern" ? fn.params[0].left : fn.params[0];
        // `{ items = [] }` in the signature, or `const { items = [] } = props` at the top of the body.
        const patterns = param?.type === "ObjectPattern" ? [param] : param?.type === "Identifier" ? destructured(fn, param.name) : [];
        /** @type {Map<string, any>} */
        const defaults = new Map();
        for (const p of patterns.flatMap((pattern) => pattern.properties)) {
          if (p.value?.type === "AssignmentPattern" && p.value.left.type === "Identifier" && fresh.test(p.value.right.type)) defaults.set(p.value.left.name, p.value);
        }
        if (!defaults.size) return;
        walk(fn.body, (n) => {
          const deps = n.arguments?.[1];
          if (!isHookCall(n, /^use(?:Layout)?Effect$|^useMemo$|^useCallback$/) || deps?.type !== "ArrayExpression") return;
          for (const d of deps.elements) {
            const node = d?.type === "Identifier" ? defaults.get(d.name) : undefined;
            if (!node) continue;
            defaults.delete(d.name);
            const hook = n.callee.type === "MemberExpression" ? n.callee.property.name : n.callee.name;
            context.report({ node, messageId: "unstable", data: { name: d.name, value: context.sourceCode.getText(node.right), hook } });
          }
        });
      },
    };
  },
});

export const bad = [
  "export function Picker({ selected = [] }) {\n  const [open, setOpen] = useState(false);\n  useEffect(() => { setOpen(selected.length > 0); }, [selected]);\n  return <p>{open}</p>;\n}",
  "export const Chart = ({ data, options = {} }) => {\n  const config = useMemo(() => build(data, options), [data, options]);\n  return <Plot config={config} />;\n};",
  "export function Picker(props) {\n  const { selected = [] } = props;\n  useEffect(() => { track(selected); }, [selected]);\n  return null;\n}",
  "export function useSearch({ filters = [] } = {}) {\n  const [hits, setHits] = useState([]);\n  React.useEffect(() => { search(filters).then(setHits); }, [filters]);\n  return hits;\n}",
];

export const good = [
  "const NO_ITEMS = [];\nexport function Picker({ selected = NO_ITEMS }) {\n  useEffect(() => { track(selected); }, [selected]);\n  return null;\n}",
  // A default no hook depends on is harmless.
  "export function List({ items = [] }) {\n  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;\n}",
  // Primitive defaults compare equal across renders.
  "export function Pager({ page = 1, size = 20 }) {\n  useEffect(() => { load(page, size); }, [page, size]);\n  return null;\n}",
  // Only a property is a dependency.
  "export function Chart({ options = {} }) {\n  useEffect(() => { draw(options.color); }, [options.color]);\n  return null;\n}",
];
