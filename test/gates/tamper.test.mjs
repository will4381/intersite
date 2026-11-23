// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);
const base = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, paths: { "@/*": ["./src/*"] } }, include: ["src"] }, null, 2),
  ".oxlintrc.json": JSON.stringify({ rules: { "no-console": "error" }, ignorePatterns: ["dist"] }, null, 2),
  "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest run", build: "tsc" } }, null, 2),
  ".github/workflows/ci.yml": "on: [pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n",
  "src/a.ts": "export const a = 1;\n",
};

test("weakened type, lint, script and CI settings are each reported with what weakened", async () => {
  const r = repo(base);
  r.write({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false, paths: { "@/*": ["./src/*"] } }, include: ["src"] }),
    ".oxlintrc.json": JSON.stringify({ rules: { "no-console": "off" }, ignorePatterns: ["dist", "src/billing"] }),
    "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest run || true", build: "tsc" } }),
    ".github/workflows/ci.yml": "on: [pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n",
    "src/a.ts": "/* c8 ignore next */\nexport const a = 1;\n",
  });
  const { code, out } = await run(r.cwd, ["tamper"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out).sort(), [
    ".github/workflows/ci.yml: step `npm test` in job ci removed: fix the code instead of loosening the check; if this change is right, acknowledge it with the reason",
    ".oxlintrc.json: ignorePatterns now ignores src/billing: fix the code instead of loosening the check; if this change is right, acknowledge it with the reason",
    ".oxlintrc.json: rules.no-console lowered from error to off: fix the code instead of loosening the check; if this change is right, acknowledge it with the reason",
    "package.json: script `test` gained `|| true`: fix the code instead of loosening the check; if this change is right, acknowledge it with the reason",
    "src/a.ts: 1 coverage-ignore pragma(s) added: they hide this code from coverage: fix the code instead of loosening the check; if this change is right, acknowledge it with the reason",
    "tsconfig.json: compilerOptions.strict turned off: fix the code instead of loosening the check; if this change is right, acknowledge it with the reason",
  ]);
  assert.match(out.join("\n"), /"target": "tsconfig\.json:compilerOptions\.strict"/);
});

test("legitimate config work passes: a new alias, a stricter rule, a new CI step, an acknowledgment", async () => {
  const r = repo(base);
  r.write({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true, paths: { "@/*": ["./src/*"], "~/*": ["./app/*"] } }, include: ["src", "app"], exclude: ["dist"] }),
    ".oxlintrc.json": JSON.stringify({ rules: { "no-console": "error", eqeqeq: "error" }, ignorePatterns: ["dist", ".next"] }),
    "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest run --coverage", build: "tsc -b", lint: "oxlint ." } }),
    ".github/workflows/ci.yml": "on: [pull_request, push]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n      - run: npm run lint\n",
    "intersite.json": JSON.stringify({ project: "t", gates: { base: "base", acknowledged: [{ gate: "sql", target: "a.sql", why: "empty table" }] } }),
  });
  const { code, out } = await run(r.cwd, ["tamper"]);
  assert.equal(code, 0, out.join("\n"));
  assert.match(out[0], /^ok gate tamper: \d+ changed evaluator files checked$/);
});

test("dropping a gate from intersite.json and growing the gates baseline are reported", async () => {
  const r = repo({ ...base, "intersite-gates-baseline.json": JSON.stringify({ unused: ["src/a.ts"] }) });
  r.write({
    "intersite.json": JSON.stringify({ project: "t", gates: { base: "base", run: ["test-integrity", "duplicates"] } }),
    "intersite-gates-baseline.json": JSON.stringify({ unused: ["src/a.ts", "src/b.ts"] }),
  });
  const { code, out } = await run(r.cwd, ["tamper"]);
  assert.equal(code, 1);
  assert.ok(lines(out).some((l) => l.startsWith("intersite.json: gates.run no longer runs similar")), out.join("\n"));
  assert.ok(lines(out).some((l) => l.startsWith("intersite-gates-baseline.json: baseline grew from 1 to 2 recorded findings")), out.join("\n"));
});
