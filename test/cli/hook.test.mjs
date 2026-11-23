// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";

import { ensureCore } from "../../gates/core.mjs";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));

// The hook never builds the engine (an edit must not wait minutes), so the tests build it first.
before(() => ensureCore());

/** A project folder with these files. @param {Record<string, string>} files */
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "intersite-hook-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, text] of Object.entries({ "intersite.json": JSON.stringify({ project: "t" }), ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** Runs the hook on one tool call. @param {string} dir @param {string} tool @param {Record<string, unknown>} input */
function hook(dir, tool, input) {
  const run = spawnSync(process.execPath, [bin, "hook"], { cwd: dir, input: JSON.stringify({ tool_name: tool, tool_input: { ...input, file_path: join(dir, String(input.file_path)) } }), encoding: "utf8" });
  return { code: run.status, err: run.stderr };
}

test("an edit that turns a strict option off is blocked with what to do instead; a harmless one passes", () => {
  const dir = project({ "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }, null, 2) });
  const blocked = hook(dir, "Edit", { file_path: "tsconfig.json", old_string: '"strict": true', new_string: '"strict": false' });
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /^intersite: blocked this edit to tsconfig\.json: compilerOptions\.strict turned off\. Fix the code so the check passes instead of loosening the check\. If this change really is right .*\{ gate: "tamper", target: "tsconfig\.json:compilerOptions\.strict", why: "…" \}\.\n$/);
  const fine = hook(dir, "Edit", { file_path: "tsconfig.json", old_string: '"strict": true', new_string: '"strict": true,\n    "noUncheckedIndexedAccess": true' });
  assert.deepEqual(fine, { code: 0, err: "" });
});

test("rewriting a test file with fewer assertions or a skip is blocked; adding a test passes", () => {
  const dir = project({ "src/a.test.ts": "test('a', () => {\n  expect(a()).toBe(1);\n  expect(b()).toBe(2);\n});\n" });
  const fewer = hook(dir, "Write", { file_path: "src/a.test.ts", content: "test('a', () => {\n  expect(a()).toBe(1);\n});\n" });
  assert.equal(fewer.code, 2);
  assert.match(fewer.err, /blocked this edit to src\/a\.test\.ts: assertions 2 → 1\. Fix the code so the tests pass instead of removing or skipping tests\./);
  const skipped = hook(dir, "MultiEdit", { file_path: "src/a.test.ts", edits: [{ old_string: "test('a'", new_string: "test.skip('a'" }] });
  assert.equal(skipped.code, 2);
  const more = hook(dir, "Edit", { file_path: "src/a.test.ts", old_string: "});\n", new_string: "});\ntest('c', () => { expect(c()).toBe(3); });\n" });
  assert.deepEqual(more, { code: 0, err: "" });
});

test("an acknowledged change, an ordinary source edit and unreadable input all pass silently", () => {
  const dir = project({
    "intersite.json": JSON.stringify({ project: "t", gates: { acknowledged: [{ gate: "tamper", target: "tsconfig.json:compilerOptions.strict", why: "migrating a JS codebase" }] } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "src/a.ts": "export const a = 1;\n",
  });
  assert.deepEqual(hook(dir, "Edit", { file_path: "tsconfig.json", old_string: '"strict":true', new_string: '"strict":false' }), { code: 0, err: "" });
  assert.deepEqual(hook(dir, "Edit", { file_path: "src/a.ts", old_string: "1", new_string: "2" }), { code: 0, err: "" });
  const garbage = spawnSync(process.execPath, [bin, "hook"], { cwd: dir, input: "not json", encoding: "utf8" });
  assert.deepEqual({ code: garbage.status, err: garbage.stderr }, { code: 0, err: "" });
});
