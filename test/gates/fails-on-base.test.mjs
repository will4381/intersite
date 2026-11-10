// @ts-check
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { repo, run } from "./repo.mjs";

/**
 * A repo whose base commit has a buggy `add`, and whose HEAD fixes it and adds `testSource` as test/add.test.mjs.
 * @param {string} testSource
 */
function fixed(testSource) {
  const r = repo({ "add.mjs": "export const add = (a, b) => a - b;\n" });
  r.write({
    "add.mjs": "export const add = (a, b) => a + b;\n",
    "test/add.test.mjs": `import assert from "node:assert/strict";\nimport { add } from "../add.mjs";\n${testSource}\n`,
  });
  r.commit("fix add");
  return r;
}

const args = ["fails-on-base", "--cmd", "node test/add.test.mjs", "--paths", "test/**"];

test("exits 0 when the new test fails on the base commit, and removes the worktree", async () => {
  const r = fixed("assert.equal(add(2, 2), 4);");
  assert.equal((await run(r.cwd, args)).code, 0);
  assert.equal(r.worktrees(), 1);
});

test("exits 1 when the new test passes on the base commit, and removes the worktree", async () => {
  const r = fixed("assert.equal(typeof add, 'function');");
  const { code, out } = await run(r.cwd, args);
  assert.equal(code, 1);
  assert.match(out[0], /^test\/add\.test\.mjs passes on base without the change, so it does not test it; rerun: node test\/add\.test\.mjs \| to accept: /);
  assert.equal(r.worktrees(), 1);
});

test("exits 2 when no changed file matches --paths", async () => {
  const r = fixed("assert.equal(add(2, 2), 4);");
  assert.equal((await run(r.cwd, ["fails-on-base", "--cmd", "true", "--paths", "spec/**"])).code, 2);
});

test("takes the command and paths from intersite.yml, the test from the working tree, and links node_modules", async () => {
  const r = repo({ "add.mjs": "export const add = (a, b) => a - b;\n", ".gitignore": "node_modules\n" }, { testCmd: "node test/dep.test.mjs" });
  r.write({ "node_modules/dep/package.json": '{ "name": "dep", "main": "index.js" }', "node_modules/dep/index.js": "module.exports = 2;\n" });
  // Uncommitted, and passes on base only if `dep` resolves there.
  r.write({ "test/dep.test.mjs": 'import assert from "node:assert/strict";\nimport dep from "dep";\nassert.equal(dep, 2);\n' });
  const { code, out } = await run(r.cwd, ["fails-on-base"]);
  assert.equal(code, 1);
  assert.match(out[0], /^test\/dep\.test\.mjs passes on base/);
  assert.equal(r.worktrees(), 1);
});

test("Ctrl-C while the test command runs stops it and removes the worktree", async () => {
  const r = fixed("assert.equal(add(2, 2), 4);");
  const hang = `node -e "console.log('ready ' + process.pid); setInterval(() => {}, 1000)"`;
  const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));
  const child = spawn(process.execPath, [bin, "gate", "fails-on-base", "--cmd", hang, "--paths", "test/**"], { cwd: r.cwd, stdio: ["ignore", "ignore", "pipe"] });
  const [line] = await once(createInterface({ input: /** @type {import("node:stream").Readable} */ (child.stderr) }), "line");
  const pid = Number(/^ready (\d+)$/.exec(line)?.[1]);
  assert.ok(pid, line);
  child.kill("SIGINT");
  const [code] = await once(child, "exit");
  assert.equal(code, 130);
  // Gone, or a zombie waiting to be reaped: either way no longer running.
  const stateOf = () => spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  // The signal is delivered after the CLI exits, so give the process a bounded moment to go.
  let state = stateOf();
  for (let tries = 0; tries < 100 && state !== "" && !state.startsWith("Z"); tries++) {
    await new Promise((done) => setTimeout(done, 20));
    state = stateOf();
  }
  assert.ok(state === "" || state.startsWith("Z"), `the test command was left running (${state})`);
  assert.equal(r.worktrees(), 1);
});
