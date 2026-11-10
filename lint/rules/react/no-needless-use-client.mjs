// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";

/** What only works in the browser: hooks, browser globals, context and class components. */
const clientName = /^(?:use[A-Z0-9]\w*|use|window|document|navigator|localStorage|sessionStorage|location|history|matchMedia|requestAnimationFrame|IntersectionObserver|ResizeObserver|createContext|Component|PureComponent)$/;

/**
 * A package: many libraries use hooks without marking themselves "use client", so a file that renders their
 * components may be the boundary that makes them work. Project files (relative or aliased) and Next's own are not.
 */
const packageImport = /^(?![.#~/]|@\/|src\/|next\/)/;

/** Next.js files that must be client components: error boundaries. */
const clientOnlyFile = /(?:^|\/)(?:global-)?error\.[jt]sx?$/;

/** An exported value that is not itself a function but holds one (`columns = [{ cell: () => … }]`): functions cannot cross to the client as data. @param {any} s */
function exportsFunctionData(s) {
  if (s.type !== "ExportNamedDeclaration" || s.declaration?.type !== "VariableDeclaration") return false;
  return s.declaration.declarations.some((/** @type {any} */ d) => {
    if (!d.init || d.init.type.endsWith("FunctionExpression")) return false;
    let found = false;
    walk(d.init, (n) => void (found ||= n.type.endsWith("FunctionExpression")));
    return found;
  });
}

export const id = "no-needless-use-client";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      needless: "This file is marked \"use client\" but uses no hooks, event handlers or browser APIs, so it ships to the browser for nothing and pulls everything it imports in with it. Delete the directive; a server component can still render the client components it imports.",
    },
  },
  createOnce(context) {
    return {
      Program(program) {
        const directive = program.body[0];
        if (directive?.type !== "ExpressionStatement" || directive.directive !== "use client" || clientOnlyFile.test(context.filename)) return;
        /** Names imported from packages, which count when rendered (<Chart />, <motion.div>). */
        const fromPackages = new Set();
        /** Functions this file declares, which cannot be passed as a prop from the server (`format={money}`). */
        // ponytail: an imported function passed as a prop (`format={formatMoney}`) is not seen; resolve imports if it bites
        const functions = new Set();
        let client = false;
        for (const s of program.body) {
          // A side-effect import, a re-export (a barrel of client components) or next/dynamic (`ssr: false`) needs the boundary.
          if (s.type === "ImportDeclaration") {
            client ||= s.specifiers.length === 0 || s.source.value === "next/dynamic";
            if (packageImport.test(s.source.value)) for (const spec of s.specifiers) fromPackages.add(spec.local.name);
          } else client ||= s.type === "ExportAllDeclaration" || (s.type === "ExportNamedDeclaration" && Boolean(s.source)) || exportsFunctionData(s);
          const declaration = s.type === "ExportNamedDeclaration" ? s.declaration : s;
          if (declaration?.type === "FunctionDeclaration") functions.add(declaration.id.name);
          if (declaration?.type === "VariableDeclaration") for (const d of declaration.declarations) if (d.id.type === "Identifier" && d.init?.type.endsWith("FunctionExpression")) functions.add(d.id.name);
        }
        walk(program, (n, parent) => {
          if (client) return;
          // A function prop (onClick={…}, render={() => …}) cannot cross from server to client, and neither can a hook or global.
          if (n.type === "Identifier") client = clientName.test(n.name);
          // <ThemeContext.Provider> and React 19's <ThemeContext> render a context, which only works on the client.
          else if (n.type === "JSXIdentifier") client = clientName.test(n.name) || /^on[A-Z]|Context$/.test(n.name) || (n.name === "Provider" && parent.type === "JSXMemberExpression") || (parent.type !== "JSXAttribute" && fromPackages.has(n.name));
          else if (n.type === "JSXExpressionContainer" && parent.type === "JSXAttribute") client = n.expression.type.endsWith("FunctionExpression") || functions.has(n.expression.name);
        });
        if (!client && program.body.some((/** @type {any} */ s) => s.type !== "ImportDeclaration")) context.report({ node: directive, messageId: "needless" });
      },
    };
  },
});

export const bad = [
  "'use client';\nexport function Card({ title, children }) {\n  return <section><h2>{title}</h2>{children}</section>;\n}",
  "\"use client\";\nimport { Badge } from './badge';\nexport default function Status({ ok }) {\n  return <Badge tone={ok ? 'green' : 'red'}>{ok ? 'Live' : 'Down'}</Badge>;\n}",
  "'use client';\nconst plans = [{ id: 'pro', price: 20 }];\nexport function Prices() {\n  return <ul>{plans.map((p) => <li key={p.id}>{p.price}</li>)}</ul>;\n}",
  "'use client';\nimport { Card } from './card';\nexport const columns = [{ key: 'name', label: 'Name' }];\nexport function Plan({ plan }) {\n  return <Card title={plan.name}>{plan.price}</Card>;\n}",
];

export const good = [
  "'use client';\nexport function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>{n}</button>;\n}",
  "'use client';\nexport function Back() {\n  return <button onClick={goBack}>Back</button>;\n}",
  "'use client';\nexport function Width() {\n  return <p>{window.innerWidth}</p>;\n}",
  "'use client';\nexport const ThemeContext = createContext('light');",
  "'use client';\nexport { Chart } from 'recharts';",
  "'use client';\nimport { ResponsiveContainer, LineChart } from 'recharts';\nexport function Trend({ data }) {\n  return <ResponsiveContainer><LineChart data={data} /></ResponsiveContainer>;\n}",
  "'use client';\nimport { motion } from 'framer-motion';\nexport function Hero() {\n  return <motion.div animate={{ scale: 1 }} />;\n}",
  "'use client';\nexport function Table({ rows }) {\n  return <DataTable rows={rows} cell={(row) => <span>{row.name}</span>} />;\n}",
  "export function Card({ title }) {\n  return <h2>{title}</h2>;\n}",
  "'use client';\nimport dynamic from 'next/dynamic';\nexport const MapView = dynamic(() => import('./map'), { ssr: false });",
  "'use client';\nimport { ThemeContext } from './theme';\nexport function Providers({ children }) {\n  return <ThemeContext.Provider value=\"dark\">{children}</ThemeContext.Provider>;\n}",
  "'use client';\nexport const columns: ColumnDef<Row>[] = [{ accessorKey: 'name', cell: ({ row }) => <b>{row.original.name}</b> }];",
  "'use client';\nimport { Chart } from './chart';\nfunction money(v: number) { return '$' + v; }\nexport function Revenue({ data }) {\n  return <Chart data={data} format={money} />;\n}",
];
