// @ts-check
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { fixture, runLint, write } from "./fixture.mjs";

/** @param {string} out @returns {{ findings: { file: string, line: number, column: number, rule: string, message: string }[], baselined: number }} */
const parse = (out) => JSON.parse(out);
const exec = promisify(execFile);

test("bare suppressions are reported with file and line and go through the baseline", async () => {
  const cwd = fixture({
    "intersite.json": { project: "bare" },
    "src/file.ts": "/* eslint-disable */\ntry { run(); } catch {}\n",
    "src/line.ts": "export const a = run(); // oxlint-disable-line\n",
    "src/next.ts": "export function f() {\n  // oxlint-disable-next-line -- no rule named\n  return run();\n}\n",
    "src/reasoned.ts": "// oxlint-disable-next-line no-debugger -- exercising the debugger rule\ndebugger;\n",
    "src/string.ts": 'export const s = "/* eslint-disable */";\n',
  });
  let r = await runLint(cwd, ["--json"]);
  assert.equal(r.code, 1);
  const bare = parse(r.out).findings.filter((f) => f.rule === "intersite/no-bare-suppression").map((f) => `${f.file}:${f.line}:${f.column}`);
  assert.deepEqual(bare.sort(), ["src/file.ts:1:1", "src/line.ts:1:25", "src/next.ts:2:3"]);
  assert.match(r.out, /names no rule/);

  assert.equal((await runLint(cwd, ["--write=init"])).code, 0);
  r = await runLint(cwd);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ok lint: 5 files, 0 new findings, \d+ baselined$/);

  write(cwd, "src/string.ts", 'export const s = "x";\n/* oxlint-disable */\n');
  r = await runLint(cwd);
  assert.equal(r.code, 1);
  assert.match(r.out, /^src\/string\.ts:2:1 intersite\/no-bare-suppression /m);
});

test("success is one line, and --json prints findings and the baselined count", async () => {
  const cwd = fixture({ "intersite.json": { project: "clean" }, "src/a.ts": "export const a = 1;\n" });
  assert.deepEqual(await runLint(cwd), { code: 0, out: "ok lint: 1 files, 0 new findings" });
  assert.deepEqual(parse((await runLint(cwd, ["--json"])).out), { findings: [], baselined: 0 });

  write(cwd, "src/b.ts", "try { run(); } catch {}\n");
  const r = await runLint(cwd, ["--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(parse(r.out), {
    findings: [{ file: "src/b.ts", line: 1, column: 22, rule: "intersite/no-empty-catch", message: "An empty catch hides the error. Handle it (return an explicit fallback and say why), rethrow it, or remove the try." }],
    baselined: 0,
  });
});

const packFiles = {
  // Split so this file does not hold a live-shaped key itself.
  "src/secret.ts": "export const key = 'sk_" + "live_51HxQ2bLk8dPq3RtY7uVw9ZaB';\n",
  "src/state.ts": "export let count = 0;\n",
  "src/counter.ts": "let calls = 0;\nexport const next = () => ++calls;\n",
  "src/page.tsx": "export const Save = () => <button>Save</button>;\n",
  "test/state.test.ts": "export let server;\n",
};

/** @param {string} out */
const rulesHit = (out) => [...new Set(parse(out).findings.map((f) => `${f.file} ${f.rule}`))].sort();

test("security and globals are on by default; runtime and actions only when listed in lint.packs", async () => {
  let cwd = fixture({ "intersite.json": { project: "packs" }, ...packFiles });
  assert.deepEqual(rulesHit((await runLint(cwd, ["--json"])).out), ["src/secret.ts intersite/no-hardcoded-secret", "src/state.ts intersite/no-exported-mutable-state"]);

  cwd = fixture({ "intersite.json": { project: "packs", lint: { packs: ["runtime", "actions"] } }, ...packFiles });
  assert.deepEqual(rulesHit((await runLint(cwd, ["--json"])).out), ["src/counter.ts intersite/no-module-scope-let", "src/page.tsx intersite/require-action-name"]);
});

test("--rules lists every rule with its pack and whether this project's config turns it on", async () => {
  const cwd = fixture({
    "intersite.json": {
      project: "listing",
      lint: {
        rules: { "no-hardcoded-secret": "off", "no-module-scope-let": "error" },
        custom: [{ id: "no-fetch", selector: "CallExpression[callee.name='fetch']", message: "Use the client." }],
      },
    },
  });
  const r = await runLint(cwd, ["--rules"]);
  assert.equal(r.code, 0);
  const lines = r.out.split("\n");
  for (const line of [
    "tests no-mock-only-assertions on",
    "slop no-bare-suppression on",
    "security no-hardcoded-secret off",
    "security no-interpolated-sql on",
    "runtime no-module-scope-let on",
    "actions require-action-name off",
    "custom no-fetch on",
  ]) {
    assert.ok(lines.includes(line), `missing "${line}" in:\n${r.out}`);
  }
  assert.ok(lines.every((line) => /^\S+ \S+ (on|off)$/.test(line)), r.out);
});

test("a broken intersite.yml is one line naming the file, even when it is in the folder intersite runs from", async () => {
  const cwd = fixture({ "intersite.yml": "project: broken\nlint: [\n", "src/a.ts": "export const a = 1;\n" });
  const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));
  const r = await exec(process.execPath, [bin, "lint"], { cwd }).catch((/** @type {any} */ e) => e);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^intersite lint: intersite\.yml: [^\n]+\n$/);
  assert.doesNotMatch(r.stderr, /INTERSITE_DEBUG/, "reported by lint itself, not as a crash while loading the plugin");
});

test("declared rules skip tests and generated files when told to, and the plugin works when oxlint loads it directly", async () => {
  const custom = [
    { id: "no-fetch-anywhere", selector: "CallExpression[callee.name='fetch']", message: "Use the client." },
    { id: "no-fetch-in-source", selector: "CallExpression[callee.name='fetch']", message: "Use the client.", "skip": ["tests", "generated"] },
    { id: "no-todo-in-source", comment: "^TODO\\b", message: "Track it in an issue.", "skip": ["tests"] },
  ];
  const code = "// TODO tidy\nfetch('/x');\n";
  const cwd = fixture({
    "intersite.json": { project: "skip", lint: { packs: [], custom } },
    "src/a.ts": code,
    "src/a.test.ts": code,
    "src/generated/client.ts": code,
    "src/api.ts": `// @generated by openapi\n${code}`,
  });
  const r = await runLint(cwd, ["--json"]);
  assert.deepEqual(rulesHit(r.out), [
    "src/a.test.ts intersite/no-fetch-anywhere",
    "src/a.ts intersite/no-fetch-anywhere",
    "src/a.ts intersite/no-fetch-in-source",
    "src/a.ts intersite/no-todo-in-source",
    "src/api.ts intersite/no-fetch-anywhere",
    "src/api.ts intersite/no-todo-in-source",
    "src/generated/client.ts intersite/no-fetch-anywhere",
    "src/generated/client.ts intersite/no-todo-in-source",
  ]);

  // oxlint started by hand, with intersite's plugin and the project's config, sees the same custom rules.
  const plugin = fileURLToPath(new URL("../../lint/plugin.mjs", import.meta.url));
  write(cwd, "direct.json", { jsPlugins: [plugin], plugins: [], rules: { "intersite/no-fetch-in-source": "error" } });
  const direct = await exec(join(cwd, "node_modules/.bin/oxlint"), ["-c", "direct.json", "-f", "json", "src"], { cwd }).catch((/** @type {any} */ e) => e);
  assert.deepEqual(JSON.parse(direct.stdout).diagnostics.map((/** @type {{ filename: string }} */ d) => d.filename), ["src/a.ts"]);
});

test("an unknown skip is one line naming the rule", async () => {
  const custom = [{ id: "no-fetch", selector: "CallExpression[callee.name='fetch']", message: "Use the client.", "skip": ["vendored"] }];
  const cwd = fixture({ "intersite.json": { project: "skip", lint: { custom } }, "src/a.ts": "fetch('/x');\n" });
  assert.deepEqual(await runLint(cwd), { code: 2, out: 'intersite lint: intersite rule "no-fetch": skip "vendored" is not one of tests, generated' });
});

test("inline styles are reported in a file with no className, unless an image, email or PDF renderer renders it", async () => {
  const card = "export const Card = () => <div style={{ display: 'flex', color: '#2564eb' }}>New</div>;\n";
  const cwd = fixture({
    "intersite.json": { project: "og", lint: { packs: ["ui"] } },
    "src/box.tsx": 'export const Box = () => <div style={{ color: "#2564eb" }}>New</div>;\n',
    "src/og/route.tsx": 'import { ImageResponse } from "@vercel/og";\nimport { Card } from "../social/card";\nexport const GET = () => new ImageResponse(<Card />);\n',
    "src/social/card.tsx": card,
    "src/mail/send.tsx": 'import { render } from "@react-email/render";\nimport { Receipt } from "@/emails-kit/receipt";\nexport const html = () => render(<Receipt />);\n',
    "src/emails-kit/receipt.tsx": card.replace("Card", "Receipt"),
  });
  assert.deepEqual(rulesHit((await runLint(cwd, ["--json"])).out), ["src/box.tsx intersite/no-hardcoded-color"]);
});
