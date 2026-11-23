// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);
const guarded = (/** @type {string} */ model) => `import { getUser } from "@/lib/auth";\nimport { db } from "@/lib/db";\n\nexport async function GET() {\n  const user = await getUser();\n  return Response.json(await db.${model}.findMany({ where: { ownerId: user.id } }));\n}\n`;
const next = {
  "package.json": JSON.stringify({ name: "web" }),
  "app/api/projects/route.ts": guarded("project"),
  "app/api/tasks/route.ts": guarded("task"),
  "app/api/notes/route.ts": guarded("note"),
  "app/api/files/route.ts": guarded("file"),
};

test("a new route handler with no auth check, where the other handlers check, is reported", async () => {
  const r = repo(next);
  r.write({
    "app/api/invoices/route.ts": `import { db } from "@/lib/db";\n\nexport async function GET() {\n  return Response.json(await db.invoice.findMany());\n}\n`,
    "app/api/webhooks/stripe/route.ts": `import { db } from "@/lib/db";\nexport async function POST(req: Request) { await db.event.create({ data: await req.json() }); return new Response("ok"); }\n`,
    "app/api/health/route.ts": `export async function GET() { return Response.json({ ok: await Promise.resolve(true) }); }\n`,
    "app/api/version/route.ts": `export function GET() { return Response.json({ version: "1" }); }\n`,
  });
  const { code, out } = await run(r.cwd, ["auth"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), [
    "app/api/invoices/route.ts:3 GET /api/invoices has no auth check, while 4 of 4 route handlers here check who is calling (most with getUser()): add the same check before it reads or writes anything, and limit it to what that caller may see; do not leave it to the client. If it is public by design, acknowledge it",
  ]);
  assert.match(out[0], /"target": "auth:app\/api\/invoices\/route\.ts:GET"/);
});

test("no convention, a guarded handler, or a comment saying it is public: nothing is reported", async () => {
  const loose = repo({ ...next, "app/api/notes/route.ts": `import { db } from "@/lib/db";\nexport async function GET() { return Response.json(await db.note.findMany()); }\n`, "app/api/files/route.ts": `import { db } from "@/lib/db";\nexport async function GET() { return Response.json(await db.file.findMany()); }\n` });
  loose.write({ "app/api/invoices/route.ts": `import { db } from "@/lib/db";\nexport async function GET() { return Response.json(await db.invoice.findMany()); }\n` });
  assert.equal((await run(loose.cwd, ["auth"])).code, 0, "2 of 4 is no convention");

  const r = repo(next);
  r.write({
    "app/api/invoices/route.ts": guarded("invoice"),
    "app/api/plans/route.ts": `import { db } from "@/lib/db";\n\n// Public: the pricing page lists plans before sign-in.\nexport async function GET() { return Response.json(await db.plan.findMany()); }\n`,
  });
  const { code, out } = await run(r.cwd, ["auth"]);
  assert.equal(code, 0, out.join("\n"));
  assert.match(out[0], /^ok gate auth: 6 endpoints in \d+ files, 5 check who is calling$/);
});

test("Express: a router-level middleware or one mounted with the router guards its routes; an unguarded route is reported", async () => {
  const route = (/** @type {string} */ path) => `router.get("${path}", async (req, res) => res.json(await db.query("select 1")));\n`;
  const r = repo({
    "package.json": JSON.stringify({ name: "api" }),
    "src/app.ts": `import express from "express";\nimport { requireAdmin } from "./auth";\nimport adminRouter from "./admin";\nconst app = express();\napp.use("/admin", requireAdmin, adminRouter);\n`,
    "src/admin.ts": `import { Router } from "express";\nconst router = Router();\n${route("/stats")}${route("/users")}export default router;\n`,
    "src/items.ts": `import { Router } from "express";\nimport { requireAuth } from "./auth";\nconst router = Router();\nrouter.use(requireAuth);\n${route("/items")}${route("/items/:id")}export default router;\n`,
  });
  r.write({
    "src/admin.ts": `import { Router } from "express";\nconst router = Router();\n${route("/stats")}${route("/users")}${route("/audit")}export default router;\n`,
    "src/orders.ts": `import { Router } from "express";\nimport { requireAuth } from "./auth";\nconst router = Router();\nrouter.get("/orders", requireAuth, async (req, res) => res.json(await db.query("select 1")));\nrouter.delete("/orders/:id", async (req, res) => res.json(await db.query("delete")));\nexport default router;\n`,
  });
  const { code, out } = await run(r.cwd, ["auth"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out).map((l) => l.split(" has ")[0]), ["src/orders.ts:5 DELETE /orders/:id"]);
});

test("server actions: an unguarded read is reported; an unguarded write is left to lint's no-unguarded-server-action", async () => {
  const action = (/** @type {string} */ name) => `export async function ${name}() {\n  const session = await auth();\n  return db.select().from(t).where(eq(t.ownerId, session.user.id));\n}\n`;
  const r = repo({ "package.json": JSON.stringify({ name: "web" }), "app/actions.ts": `"use server";\n${action("listA")}${action("listB")}${action("listC")}` });
  r.write({
    "app/actions.ts": `"use server";\n${action("listA")}${action("listB")}${action("listC")}export async function exportAll() {\n  return db.select().from(t);\n}\nexport async function wipe(id: string) {\n  await db.delete(t).where(eq(t.id, id));\n}\n`,
  });
  const { code, out } = await run(r.cwd, ["auth"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out).map((l) => l.split(" has ")[0]), ["app/actions.ts:14 server action exportAll"]);
});

test("--all reports every unguarded endpoint where the convention holds", async () => {
  const r = repo({ ...next, "app/api/invoices/route.ts": `import { db } from "@/lib/db";\nexport async function GET() { return Response.json(await db.invoice.findMany()); }\n` });
  const { code, out } = await run(r.cwd, ["auth", "--all"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out).map((l) => l.split(" has ")[0]), ["app/api/invoices/route.ts:2 GET /api/invoices"]);
});
