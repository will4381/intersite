// @ts-check
import { defineRule } from "@oxlint/plugins";

import { notShipped } from "../shared.mjs";

export const id = "no-object-literal-cast";
export const pack = "types";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      cast: "`{ ... } as {{type}}` stops the compiler checking this object: a missing or misspelled field passes silently. Annotate instead (const x: {{type}} = { ... }), or write `{ ... } satisfies {{type}}`, so the compiler checks every field.",
    },
  },
  createOnce(context) {
    return {
      before: () => !notShipped(context),
      TSAsExpression(node) {
        const value = /** @type {any} */ (node.expression);
        const type = /** @type {any} */ (node.typeAnnotation);
        if (value.type !== "ObjectExpression" || type.type === "TSUnknownKeyword") return;
        // `{ [field]: v }` widens its key to string, so naming the key type takes a cast.
        if (value.properties.some((/** @type {any} */ p) => p.computed)) return;
        // `style={{ "--x": v } as CSSProperties}`: React's types have no other way to accept a custom property.
        if (type.type === "TSTypeReference" && /^(const|CSSProperties)$/.test(type.typeName.name ?? type.typeName.right?.name)) return;
        // An argument (`reduce(fn, {} as Totals)`, `useState({} as Form)`) has no annotation to move to.
        const parent = /** @type {any} */ (node).parent;
        if ((parent.type === "CallExpression" || parent.type === "NewExpression") && parent.arguments.includes(node)) return;
        if (parent.type === "JSXSpreadAttribute" || parent.type === "AssignmentPattern") return;
        context.report({ node, messageId: "cast", data: { type: context.sourceCode.getText(type).slice(0, 40) } });
      },
    };
  },
});

export const ext = "tsx";

export const bad = [
  "const user = { id: '1', name: 'Ada' } as User;",
  "const empty = {} as Settings;",
  "function toWire(row: Row) { return { id: row.id, total: row.total } as OrderWire; }",
  "export const config = { port: 3000, host: 'localhost' } as ServerConfig;",
];

export const good = [
  "const user: User = { id: '1', name: 'Ada' };",
  "const config = { port: 3000 } satisfies ServerConfig;",
  "const routes = { home: '/', about: '/about' } as const;",
  "const totals = rows.reduce((acc, r) => ({ ...acc, [r.id]: r.total }), {} as Record<string, number>);",
  "const [form, setForm] = useState({} as Form);",
  "const items = [] as Item[];",
  "function page<O>(options = {} as O) { return options; }",
  "const where = { [field]: { lt: cursor } } as Record<K, Range>;",
  "const Bar = ({ pct }) => <span style={{ '--bar-w': `${pct}%` } as React.CSSProperties} />;",
];
