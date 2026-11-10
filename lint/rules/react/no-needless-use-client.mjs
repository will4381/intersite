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
        if (directive?.type !== "ExpressionStatement" || directive.directive !== "use client") return;
        /** Names imported from packages, which count when rendered (<Chart />, <motion.div>). */
        const fromPackages = new Set();
        let client = false;
        for (const s of program.body) {
          // A side-effect import or a re-export (a barrel of client components) needs the boundary.
          if (s.type === "ImportDeclaration") {
            client ||= s.specifiers.length === 0;
            if (packageImport.test(s.source.value)) for (const spec of s.specifiers) fromPackages.add(spec.local.name);
          } else client ||= s.type === "ExportAllDeclaration" || (s.type === "ExportNamedDeclaration" && Boolean(s.source));
        }
        walk(program, (n, parent) => {
          if (client) return;
          // A function prop (onClick={…}, render={() => …}) cannot cross from server to client, and neither can a hook or global.
          if (n.type === "Identifier") client = clientName.test(n.name);
          else if (n.type === "JSXIdentifier") client = clientName.test(n.name) || /^on[A-Z]/.test(n.name) || (parent.type !== "JSXAttribute" && fromPackages.has(n.name));
          else if (n.type === "JSXExpressionContainer" && parent.type === "JSXAttribute") client = n.expression.type.endsWith("FunctionExpression");
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
];
