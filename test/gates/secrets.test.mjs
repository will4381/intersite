// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

// Built from pieces so this file never holds a whole credential itself.
const STRIPE = ["sk", "live", "51HxQ2bLk8dPq3RtY7uVw9ZaB"].join("_");
const GITHUB = ["ghp", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"].join("_");
const DB = `postgres://admin:${"S3cr3tPassw0rd"}@db.prod.acme.io:5432/app`;
const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

test("a credential added to a config file, a workflow or docs is reported without printing it", async () => {
  const r = repo({ "README.md": "# app\n", "src/app.ts": "export const x = 1;\n" });
  r.write({
    "deploy/values.yaml": `stripe:\n  key: ${STRIPE}\n`,
    ".github/workflows/ci.yml": `env:\n  GH_TOKEN: ${GITHUB}\n`,
    "README.md": `# app\n\nConnect with \`${DB}\`\n`,
  });
  const { code, out } = await run(r.cwd, ["secrets"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out).map((l) => l.split(" (")[0]), [".github/workflows/ci.yml:2 GitHub token", "README.md:3 database URL with a password", "deploy/values.yaml:2 Stripe live key"]);
  assert.ok(out.every((l) => !l.includes(STRIPE) && !l.includes(GITHUB) && !l.includes("S3cr3tPassw0rd")), "the secret is never printed");
  assert.match(out[2], /rotate it/);
  assert.match(out[2], /"target": "secrets:deploy\/values\.yaml:Stripe live key"/);
});

test("placeholders, local URLs, test fixtures and JavaScript strings (lint's) are not reported", async () => {
  const r = repo({ "src/app.ts": "export const x = 1;\n" });
  r.write({
    "docs/setup.md": "STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxxxxxxxx\nDATABASE_URL=postgres://postgres:postgres1@localhost:5432/dev\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n",
    "test/fixtures/keys.json": JSON.stringify({ key: STRIPE }),
    "src/stripe.test.ts": `const key = "${STRIPE}";\n`,
    "src/pay.ts": `export const key = "${STRIPE}";\n`,
    ".env.example": "STRIPE_SECRET_KEY=sk_live_your_key_here\nJWT_SECRET=\n",
  });
  const { code, out } = await run(r.cwd, ["secrets"]);
  assert.equal(code, 0, out.join("\n"));
  assert.match(out[0], /^ok gate secrets: \d+ files checked for credentials$/);
});

test("a committed env file with a real secret value is reported; public values and templates are not", async () => {
  const r = repo({ "src/app.ts": "export const x = 1;\n" });
  r.write({
    ".env.local": "NEXT_PUBLIC_SITE_URL=https://acme.io\nSESSION_SECRET=9fK2LmQp7RtXv3NbZc8Yd\n",
    ".env.development": "VITE_API_URL=https://api.acme.io\nPORT=3000\n",
  });
  const { code, out } = await run(r.cwd, ["secrets"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out).map((l) => l.split(" (")[0]), [".env.local:2 SESSION_SECRET set in a committed env file"]);
});

test("a private key file is reported, and --all reads the whole project", async () => {
  const r = repo({ "src/app.ts": "export const x = 1;\n", "config/old.yml": `token: ${GITHUB}\n` });
  r.write({ "certs/client.p12": Buffer.from([0, 1, 2, 3, 0, 255]).toString("latin1") });
  const diff = await run(r.cwd, ["secrets"]);
  assert.deepEqual(lines(diff.out), ["certs/client.p12 is a private key file: remove it and rotate it, because a secret that reached git (or a pushed branch) is leaked; read it from an environment variable or secret store. Do not just move it to another tracked file"]);
  const all = await run(r.cwd, ["secrets", "--all"]);
  assert.deepEqual(lines(all.out).map((l) => l.split(" (")[0].split(" is ")[0]), ["certs/client.p12", "config/old.yml:1 GitHub token"]);
});
