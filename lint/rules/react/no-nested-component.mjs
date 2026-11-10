// @ts-check
import { defineRule } from "@oxlint/plugins";

import { functionName, walk } from "./hooks.mjs";

/** `function Row() {}` or `const Row = () => …` as a statement of `body`: name -> declaration. @param {any} body */
function declaredComponents(body) {
  /** @type {Map<string, any>} */
  const found = new Map();
  for (const s of body.body) {
    if (s.type === "FunctionDeclaration" && /^[A-Z]/.test(s.id?.name ?? "")) found.set(s.id.name, s);
    if (s.type === "VariableDeclaration") {
      for (const d of s.declarations) if (/^[A-Z]/.test(d.id.name ?? "") && d.init?.type.endsWith("FunctionExpression")) found.set(d.id.name, d);
    }
  }
  return found;
}

export const id = "no-nested-component";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      nested: "{{name}} is defined inside {{outer}}, so every render of {{outer}} creates a new component type: React unmounts and remounts it, losing its state, focus and DOM each time. Move {{name}} to module scope and pass what it reads from {{outer}} as props.",
    },
  },
  createOnce(context) {
    return {
      ":function"(fn) {
        const outer = functionName(fn);
        if (!/^[A-Z]/.test(outer ?? "") || fn.body?.type !== "BlockStatement") return;
        const inner = declaredComponents(fn.body);
        if (!inner.size) return;
        // Rendered as <Row />: called as Row() it is just a function returning JSX, which is fine.
        walk(fn.body, (n) => {
          const node = n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier" ? inner.get(n.name.name) : undefined;
          if (!node) return;
          inner.delete(n.name.name);
          context.report({ node, messageId: "nested", data: { name: n.name.name, outer } });
        });
      },
    };
  },
});

export const bad = [
  "export function List({ items }) {\n  function Row({ item }) { return <li>{item.name}</li>; }\n  return <ul>{items.map((item) => <Row key={item.id} item={item} />)}</ul>;\n}",
  "export const Form = () => {\n  const [name, setName] = useState('');\n  const Field = () => <input value={name} onChange={(e) => setName(e.target.value)} />;\n  return <form><Field /></form>;\n};",
  "export default function Page() {\n  const Chart = function ({ data }) { return <svg>{data.length}</svg>; };\n  return <main><Chart data={[]} /></main>;\n}",
];

export const good = [
  "function Row({ item }) { return <li>{item.name}</li>; }\nexport function List({ items }) {\n  return <ul>{items.map((item) => <Row key={item.id} item={item} />)}</ul>;\n}",
  // Called, not rendered: a helper that returns JSX keeps no state of its own.
  "export function List({ items }) {\n  const Empty = () => <p>Nothing yet</p>;\n  return items.length ? <ul /> : Empty();\n}",
  // A render prop is a function, not a component type.
  "export function Grid({ rows }) {\n  return <Table rows={rows} cell={(row) => <span>{row.name}</span>} />;\n}",
  "export function useColumns() {\n  const Cell = ({ v }) => <span>{v}</span>;\n  return [{ id: 'a', cell: Cell }];\n}",
];
