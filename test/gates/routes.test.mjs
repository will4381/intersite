// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

const next = {
  "package.json": JSON.stringify({ name: "web", dependencies: { next: "15.0.0" } }),
  "app/page.tsx": "export default function Home() { return null; }\n",
  "app/(auth)/login/page.tsx": "export default function Login() { return null; }\n",
  "app/projects/[id]/edit/page.tsx": "export default function Edit() { return null; }\n",
  "app/docs/[[...slug]]/page.tsx": "export default function Docs() { return null; }\n",
  "app/api/invoices/route.ts": "export async function GET() { return Response.json([]); }\n",
  "app/api/invoices/[id]/route.ts": "export async function GET() {}\nexport async function DELETE() {}\n",
  "public/logo.svg": "<svg/>",
};

test("a link to a page no route has, an API call no handler answers and a method a route lacks are reported", async () => {
  const r = repo(next);
  r.write({
    "components/nav.tsx": [
      'import Link from "next/link";',
      "export function Nav({ id }) {",
      '  return <><Link href="/settings/billing">Billing</Link><Link href="/auth/login">Log in</Link></>;',
      "}",
      "export async function save(id) {",
      '  await fetch("/api/invoice", { method: "POST" });',
      '  await fetch("/api/invoices", { method: "POST" });',
      "}",
      "",
    ].join("\n"),
  });
  const { code, out } = await run(r.cwd, ["routes"]);
  assert.equal(code, 1, out.join("\n"));
  assert.deepEqual(lines(out), [
    "components/nav.tsx:3 no page at /auth/login: link to an existing route or add the page",
    "components/nav.tsx:3 no page at /settings/billing: link to an existing route or add the page",
    "components/nav.tsx:6 no route handles /api/invoice: call an existing route or add the handler",
    "components/nav.tsx:7 POST /api/invoices: the route handles only GET",
  ]);
  assert.match(out[3], /"target": "routes:POST \/api\/invoices"/);
});

test("links and calls that match a route, a dynamic segment, a catch-all, a public file or a query string pass", async () => {
  const r = repo(next);
  r.write({
    "components/nav.tsx": [
      'import Link from "next/link";',
      "export function Nav({ id, router }) {",
      '  router.push(`/projects/${id}/edit?tab=1`);',
      '  return <><Link href="/login">In</Link><Link href="/docs/a/b">Docs</Link><Link href="/docs">Docs</Link><a href="/#pricing">Top</a><img src="/logo.svg" /><a href="https://example.com/x">x</a></>;',
      "}",
      'export const remove = (id) => fetch(`/api/invoices/${id}`, { method: "DELETE" });',
      'export const list = () => fetch("/api/invoices");',
      "",
    ].join("\n"),
  });
  const { code, out } = await run(r.cwd, ["routes"]);
  assert.equal(code, 0, out.join("\n"));
  assert.match(out[0], /^ok gate routes: 7 links, navigations and API calls checked/);
});

test("React Router routes are read from <Route> nesting; the root * route is a not-found page, not every path", async () => {
  const r = repo({
    "package.json": JSON.stringify({ name: "spa", dependencies: { "react-router-dom": "6.0.0" } }),
    "src/App.tsx": [
      "export function App() {",
      "  return <Routes>",
      '    <Route path="/settings" element={<S />}><Route path="billing" element={<B />} /></Route>',
      '    <Route path="/users/:id" element={<U />} />',
      '    <Route path="*" element={<NotFound />} />',
      "  </Routes>;",
      "}",
      "",
    ].join("\n"),
  });
  r.write({ "src/menu.tsx": 'export const items = [{ href: "/settings/billing" }, { href: "/users/7" }, { href: "/setings" }];\nexport function Go({ navigate }) { navigate("/users"); return null; }\n' });
  const { code, out } = await run(r.cwd, ["routes"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/menu.tsx:1 no page at /setings: link to an existing route or add the page", "src/menu.tsx:2 no page at /users: link to an existing route or add the page"]);
});

test("Express routes mounted from another file get the mount's prefix; a mount that cannot be followed is never reported", async () => {
  const r = repo({
    "package.json": JSON.stringify({ name: "api", dependencies: { express: "4.0.0", next: "15.0.0" } }),
    "app/page.tsx": "export default function Home() { return null; }\n",
    "server/users.ts": 'import { Router } from "express";\nconst router = Router();\nrouter.get("/:id", (req, res) => res.json({}));\nexport default router;\n',
    "server/index.ts": 'import express from "express";\nimport users from "./users";\nconst app = express();\napp.use("/api/users", users);\napp.use("/api/legacy", require("./legacy"));\napp.post("/api/orders", (req, res) => res.json({}));\n',
  });
  r.write({ "components/x.tsx": 'export const a = (id) => fetch(`/api/users/${id}`);\nexport const b = () => fetch("/api/legacy/thing");\nexport const c = () => fetch("/api/order", { method: "POST" });\nexport const d = () => fetch("/api/orders");\n' });
  const { code, out } = await run(r.cwd, ["routes"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["components/x.tsx:3 no route handles /api/order: call an existing route or add the handler", "components/x.tsx:4 GET /api/orders: the route handles only POST"]);
});

test("a router in a .tsx or .jsx file is followed like any other", async () => {
  const r = repo({
    "package.json": JSON.stringify({ name: "api", dependencies: { express: "4.0.0", next: "15.0.0" } }),
    "app/page.tsx": "export default function Home() { return null; }\n",
    "server/admin.tsx": 'import { Router } from "express";\nconst router = Router();\nrouter.get("/stats", (req, res) => res.json({}));\nexport default router;\n',
    "server/index.ts": 'import express from "express";\nimport admin from "./admin";\nconst app = express();\napp.use("/api/admin", admin);\n',
  });
  r.write({ "components/x.tsx": 'export const a = () => fetch("/api/admin/stats");\nexport const b = () => fetch("/api/admin/stat");\n' });
  const { code, out } = await run(r.cwd, ["routes"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["components/x.tsx:2 no route handles /api/admin/stat: call an existing route or add the handler"]);
});

test("a middleware that rewrites turns page-link checks off, and a project with no route source is not checked", async () => {
  const r = repo({ ...next, "middleware.ts": "export function middleware(req) { return NextResponse.rewrite(new URL('/x', req.url)); }\n" });
  r.write({ "components/nav.tsx": 'export const Nav = () => <a href="/anything">x</a>;\n' });
  assert.equal((await run(r.cwd, ["routes"])).code, 0);
  const plain = repo({ "package.json": JSON.stringify({ name: "lib" }), "src/a.ts": "export const a = 1;\n" });
  plain.write({ "src/b.tsx": 'export const B = () => <a href="/nowhere">x</a>;\n' });
  assert.equal((await run(plain.cwd, ["routes"])).code, 0);
});
