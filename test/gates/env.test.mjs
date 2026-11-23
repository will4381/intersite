// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

const base = {
  "package.json": JSON.stringify({ name: "app" }),
  ".env.example": "# Stripe\nSTRIPE_WEBHOOK_SECRET=\nDATABASE_URL=postgres://localhost/app\n# OPTIONAL_FLAG=1\n",
  "src/db.ts": "export const url = process.env.DATABASE_URL;\n",
};

test("a read of a variable .env.example does not list is reported, with the declared name it is probably a typo of", async () => {
  const r = repo(base);
  r.write({ "src/hook.ts": "export const secret = process.env.STRIPE_WEBHOOK_SECRT;\nexport const key = process.env.RESEND_API_KEY;\nexport const again = process.env.RESEND_API_KEY;\n" });
  const { code, out } = await run(r.cwd, ["env"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), [
    "src/hook.ts:1 STRIPE_WEBHOOK_SECRT is not declared in .env.example (did you mean STRIPE_WEBHOOK_SECRET?): fix the name if it is a typo, or list it there so whoever deploys knows to set it",
    "src/hook.ts:2 RESEND_API_KEY (read 2 times) is not declared in .env.example: fix the name if it is a typo, or list it there so whoever deploys knows to set it",
  ]);
  assert.match(out[1], /"target": "env:RESEND_API_KEY"/);
});

test("declared, commented, platform, defaulted and assigned variables pass, and so does a project with no env template", async () => {
  const r = repo(base);
  r.write({
    "src/ok.ts": [
      "export const a = process.env.STRIPE_WEBHOOK_SECRET;",
      "export const b = process.env.OPTIONAL_FLAG;",
      "export const c = process.env.NODE_ENV === 'production' && process.env.VERCEL_URL;",
      "export const d = process.env.LOG_LEVEL ?? 'info';",
      "export const e = process.env.REGION?.trim();",
      "process.env.TZ_OVERRIDE = 'UTC';",
      "",
    ].join("\n"),
  });
  const { code, out } = await run(r.cwd, ["env"]);
  assert.equal(code, 0, out.join("\n"));
  const bare = repo({ "package.json": JSON.stringify({ name: "x" }) });
  bare.write({ "src/a.ts": "export const k = process.env.ANYTHING_AT_ALL;\n" });
  assert.equal((await run(bare.cwd, ["env"])).code, 0);
});

test("a t3-env or zod env schema declares its keys and turns the check on", async () => {
  const r = repo({
    "package.json": JSON.stringify({ name: "app" }),
    "src/env.ts": 'export const env = createEnv({ server: { DATABASE_URL: z.string() }, client: { NEXT_PUBLIC_APP_URL: z.string() }, runtimeEnv: {} });\n',
  });
  r.write({ "src/a.ts": "export const u = process.env.NEXT_PUBLIC_APP_URL;\nexport const k = process.env.OPENAI_KEY;\n" });
  const { code, out } = await run(r.cwd, ["env"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/a.ts:2 OPENAI_KEY is not declared in src/env.ts: fix the name if it is a typo, or list it there so whoever deploys knows to set it"]);
});
