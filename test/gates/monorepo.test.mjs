// @ts-check
// A project in a subfolder of a monorepo: the gates judge the project's own change, name files relative to it as lint
// does, and read the rest of the repository only where that is the point (originals, references, shared tokens).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runLint } from "../lint/fixture.mjs";
import { repo, run } from "./repo.mjs";

const AT = "apps/web";
const RUN = ["test-integrity", "duplicates", "similar", "new-deps", "artifacts", "unused", "naming", "style-drift"];
const helper = `export function total(items) {
  let sum = 0;
  for (const item of items) {
    if (item.price > 0) sum += item.price * item.count;
  }
  const tax = sum * 0.2;
  return Math.round((sum + tax) * 100) / 100;
}
`;
const score = `export function weightedScore(entries) {
  let score = 0;
  let weight = 0;
  for (const entry of entries) {
    if (!entry.active) continue;
    score += entry.value * entry.weight;
    weight += entry.weight;
  }
  return weight === 0 ? 0 : Math.round((score / weight) * 10) / 10;
}
`;
// The same helper re-written: every local name changed, nothing pasted line for line.
const rewritten = score.replace("weightedScore(entries)", "meanScore(rows)").replace(/\bentries\b/g, "rows").replace(/\bentry\b/g, "row").replace(/\bscore\b/g, "acc").replace(/(?<!\.)\bweight\b/g, "w");
const pkg = (/** @type {Record<string, unknown>} */ fields) => JSON.stringify(fields, null, 2);
const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

/** What every app starts with: a test, five components named after their export, and code that is used. @param {string} dir */
function app(dir) {
  const names = ["UserAvatar", "ProfileCard", "SettingsPanel", "NavBar", "FooterLinks"];
  return {
    [`${dir}/package.json`]: pkg({ name: dir.split("/").pop() }),
    [`${dir}/src/main.ts`]: `import { a } from "./a";\nimport { UserAvatar, ProfileCard, SettingsPanel, NavBar, FooterLinks } from "./components";\nconsole.log(a, UserAvatar, ProfileCard, SettingsPanel, NavBar, FooterLinks);\n`,
    [`${dir}/src/a.ts`]: "export const a = 1;\n",
    [`${dir}/test/a.test.mjs`]: "test('a', () => { assert.ok(1); assert.ok(2); });\n",
    ...Object.fromEntries(names.map((n) => [`${dir}/src/components/${n}.tsx`, `export default function ${n}() { return null; }\n`])),
  };
}

const layout = {
  "package.json": pkg({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"] }),
  ...app("apps/web"),
  ...app("apps/api"),
  "packages/ui/package.json": pkg({ name: "ui" }),
  "packages/ui/src/total.ts": `export const name = "ui";\n\n${helper}`,
  "packages/ui/src/score.ts": score,
  "packages/ui/src/tokens.css": ":root {\n  --color-ink: #333333;\n}\n",
  "packages/ui/src/app.css": ".a { color: var(--color-ink); }\n.b { color: var(--color-ink); }\n.c { color: var(--color-ink); }\n",
};

/** A change in `dir` that every gate in gates.run reports. @param {string} dir */
const change = (dir) => ({
  [`${dir}/test/a.test.mjs`]: "test('a', () => { assert.ok(1); });\n",
  [`${dir}/src/copy.ts`]: `export const b = 2;\n\n${helper}`,
  [`${dir}/src/sum.ts`]: rewritten,
  [`${dir}/package.json`]: pkg({ name: dir.split("/").pop(), dependencies: { "left-pad": "1" } }),
  [`${dir}/PLAN.md`]: "# Plan\n",
  [`${dir}/src/components/user_card.tsx`]: "export default function UserCard() { return null; }\n",
  [`${dir}/src/card.css`]: ".card { color: #333333; }\n",
});

/** @param {Record<string, unknown>} [gates] */
const mono = (gates) => repo(layout, gates, { at: AT });

test("every gate names files relative to the project, and finds originals in a shared package", async () => {
  const r = mono();
  r.write(change(AT));
  /** @type {Record<string, string[]>} */
  const got = {};
  for (const name of RUN) got[name] = lines((await run(r.cwd, [name])).out);
  assert.deepEqual(got, {
    "test-integrity": ["test/a.test.mjs: assertions 2 → 1 since base"],
    duplicates: ["src/copy.ts:3 repeats ../../packages/ui/src/total.ts:3 (8 lines): reuse it"],
    similar: ["src/sum.ts:1 meanScore is 100% the same as ../../packages/ui/src/score.ts:1 weightedScore: reuse it"],
    "new-deps": ['package.json: new dependency "left-pad": check it exists and is needed, or use what is already installed'],
    artifacts: ["PLAN.md looks like a working note: delete it, or move what should last into the README"],
    unused: [
      "src/card.css is added but no other file imports or names it: wire it in, or delete it",
      "src/components/user_card.tsx is added but no other file imports or names it: wire it in, or delete it",
      "src/copy.ts is added but no other file imports or names it: wire it in, or delete it",
      "src/sum.ts is added but no other file imports or names it: wire it in, or delete it",
    ],
    naming: ["src/components/user_card.tsx: this folder names files in PascalCase (5 of 5): rename to UserCard.tsx"],
    "style-drift": ["src/card.css:1 colour #333333 is the value of --color-ink (used 3 times): use the token"],
  });
  const json = await run(r.cwd, ["artifacts", "--json"]);
  assert.deepEqual(JSON.parse(json.out[0]).findings.map((/** @type {{ target: string }} */ f) => f.target), ["PLAN.md"]);
});

test("a change only in a sibling package is not this project's change", async () => {
  const r = mono();
  r.write(change("apps/api"));
  for (const name of RUN) {
    const { code, out } = await run(r.cwd, [name]);
    assert.equal(code, 0, `${name}: ${out.join("\n")}`);
  }
});

test("lint and the gates print the same path for the same file, from a subfolder of the project too", async () => {
  const r = mono();
  mkdirSync(join(r.cwd, "node_modules/.bin"), { recursive: true });
  symlinkSync(fileURLToPath(new URL("../../node_modules/.bin/oxlint", import.meta.url)), join(r.cwd, "node_modules/.bin/oxlint"));
  r.write({ [`${AT}/src/bad.ts`]: "try { run(); } catch {}\n" });
  const linted = await runLint(r.cwd, ["src/bad.ts"]);
  assert.match(linted.out, /^src\/bad\.ts:1:/);
  const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));
  const gated = spawnSync(process.execPath, [bin, "gate", "unused"], { cwd: join(r.cwd, "src"), encoding: "utf8" });
  assert.match(gated.stdout, /^src\/bad\.ts is added but/);
});

test("config globs and acknowledged targets are relative to the project, defaults included", async () => {
  const r = mono({ entryPaths: ["jobs/**"], artifacts: ["src/**/*.gen.ts"], acknowledged: [{ gate: "artifacts", target: "PLAN.md", why: "kept" }] });
  r.write({
    [`${AT}/jobs/nightly.ts`]: "export const run = 1;\n",
    [`${AT}/src/lonely.ts`]: "export const lonely = 1;\n",
    [`${AT}/src/api.gen.ts`]: "export {};\n",
    [`${AT}/PLAN.md`]: "# Plan\n",
    [`${AT}/NOTES.md`]: "# Notes\n",
  });
  assert.deepEqual(lines((await run(r.cwd, ["unused"])).out), [
    "src/api.gen.ts is added but no other file imports or names it: wire it in, or delete it",
    "src/lonely.ts is added but no other file imports or names it: wire it in, or delete it",
  ]);
  assert.deepEqual(lines((await run(r.cwd, ["artifacts"])).out).sort(), [
    "NOTES.md looks like a working note: delete it, or move what should last into the README",
    "src/api.gen.ts matches gates.artifacts: delete it",
  ]);
});

test("a file of the project used only from a sibling package is used", async () => {
  const r = mono();
  r.write({
    [`${AT}/src/price-format.ts`]: "export const priceFormat = (n) => n;\n",
    "apps/api/src/server.ts": `import { priceFormat } from "../../web/src/price-format";\nconsole.log(priceFormat(1));\n`,
  });
  const { code, out } = await run(r.cwd, ["unused"]);
  assert.equal(code, 0, out.join("\n"));
});

test("a dependency added to the workspace root for this project is a new dependency", async () => {
  const r = mono();
  r.write({ "package.json": pkg({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"], dependencies: { react: "19" } }) });
  const { out } = await run(r.cwd, ["new-deps"]);
  assert.deepEqual(lines(out), ['../../package.json: new dependency "react": check it exists and is needed, or use what is already installed']);
});

test("a root project does not report on the files of a project nested in it, which reports them itself", async () => {
  // A config that cannot load, such as a template's, makes no project.
  const r = repo({ ...layout, [`${AT}/intersite.json`]: JSON.stringify({ project: "web", gates: { base: "base" } }), "templates/intersite.yml": "project: PROJECT\n" });
  r.write({ [`${AT}/PLAN.md`]: "# Plan\n", [`${AT}/src/lonely.ts`]: "export const lonely = 1;\n", "NOTES.md": "# Notes\n", "templates/TODO.md": "# Todo\n" });
  assert.deepEqual(lines((await run(r.cwd, ["artifacts"])).out).sort(), [
    "NOTES.md looks like a working note: delete it, or move what should last into the README",
    "templates/TODO.md looks like a working note: delete it, or move what should last into the README",
  ]);
  assert.equal((await run(r.cwd, ["unused"])).code, 0);
  assert.deepEqual(lines((await run(join(r.cwd, AT), ["artifacts"])).out), ["PLAN.md looks like a working note: delete it, or move what should last into the README"]);
});

const dep = { "node_modules/dep/package.json": '{ "name": "dep", "main": "index.js" }', "node_modules/dep/index.js": "module.exports = 2;\n" };
/** The dependency installed hoisted at the repository top, or in the project's own folder. */
const installs = [["hoisted", ""], ["project-level", `${AT}/`]];

for (const [kind, where] of installs) {
  test(`fails-on-base runs the tests in the project's folder of the worktree, with a ${kind} node_modules`, async () => {
    const r = repo({ ...layout, ".gitignore": "node_modules\n" }, { testCmd: "node test/dep.test.mjs" }, { at: AT });
    r.write(Object.fromEntries(Object.entries(dep).map(([path, text]) => [where + path, text])));
    // Uncommitted, and passes on base only if `dep` resolves there.
    r.write({ [`${AT}/test/dep.test.mjs`]: 'import assert from "node:assert/strict";\nimport dep from "dep";\nassert.equal(dep, 2);\n' });
    const { code, out, err } = await run(r.cwd, ["fails-on-base"]);
    assert.deepEqual(err, []);
    assert.equal(code, 1);
    assert.match(out[0], /^test\/dep\.test\.mjs passes on base/);
    assert.equal(r.worktrees(), 1);
  });

  test(`mutation runs the tests in the project's folder of the worktree, with a ${kind} node_modules`, async () => {
    const r = repo({ ...layout, ".gitignore": "node_modules\n", [`${AT}/src/clamp.mjs`]: "export const clamp = (n) => n;\n" }, { testCmd: "node test/clamp.test.mjs" }, { at: AT });
    r.write(Object.fromEntries(Object.entries(dep).map(([path, text]) => [where + path, text])));
    r.write({
      [`${AT}/src/clamp.mjs`]: "export function clamp(n, lo, hi) {\n  if (n < lo) return lo;\n  return n;\n}\n",
      [`${AT}/test/clamp.test.mjs`]: 'import assert from "node:assert/strict";\nimport dep from "dep";\nimport { clamp } from "../src/clamp.mjs";\nassert.equal(dep + typeof clamp, "2function");\n',
    });
    const { code, out, err } = await run(r.cwd, ["mutation"]);
    assert.deepEqual(err, []);
    assert.equal(code, 1);
    assert.deepEqual(lines(out), ["src/clamp.mjs:2 survived '<' → '>='"]);
    assert.equal(r.worktrees(), 1);
  });
}
