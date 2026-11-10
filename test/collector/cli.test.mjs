// @ts-check
// `intersite collector`, `actions` and `pin`, run as an agent would run them.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { makeCase } from "./make-case.mjs";

const cli = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));
// Unset, so the local default tokens apply.
const env = { ...process.env, INTERSITE_READ_TOKEN: undefined, INTERSITE_INGEST_TOKEN: undefined };

/** @param {string} [url] */
function project(url) {
  const dir = mkdtempSync(join(tmpdir(), "intersite-cli-"));
  writeFileSync(join(dir, "intersite.json"), JSON.stringify({ project: "p", ...(url && { collector: { url } }) }));
  return dir;
}
/** @param {string} cwd @param {string[]} args */
const run = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });

/** Starts `intersite collector` and waits for its line. @param {string} cwd @param {string[]} args */
async function startCli(cwd, args) {
  const child = spawn(process.execPath, [cli, "collector", ...args], { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(createInterface({ input: /** @type {import("node:stream").Readable} */ (child.stdout) }), "line");
  return { child, line: /** @type {string} */ (line) };
}

test("collector serves, actions and pin print their lines, SIGTERM exits cleanly, a taken port is a setup error", async () => {
  const cwd = project();
  const { child, line } = await startCli(cwd, ["--port", "0", "--db", "data/cases.db"]);
  const url = /^ok collector: (http:\/\/127\.0\.0\.1:\d+) \(db data\/cases\.db\)$/.exec(line)?.[1];
  assert.ok(url, line);
  try {
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
    writeFileSync(join(cwd, "intersite.json"), JSON.stringify({ project: "p", collector: { url } }));
    assert.equal(run(cwd, ["actions"]).stdout, "ok actions: none recorded\n");

    const action = { name: "program.save", page: "/programs/_" };
    const at = new Date().toISOString();
    const cases = [makeCase({ id: "c1", action, at }), makeCase({ id: "c2", action, at, outcome: "error" })];
    const posted = await fetch(`${url}/v1/cases`, {
      method: "POST",
      headers: { authorization: "Bearer local-ingest", "content-type": "application/json" },
      body: JSON.stringify({ cases }),
    });
    assert.equal((await posted.json()).accepted, 2);
    const listed = run(cwd, ["actions", "--since", "7d"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, `program.save /programs/_ ok=1 warn=0 rejected=0 error=1 last=${at}\n`);
    assert.equal(JSON.parse(run(cwd, ["actions", "--json"]).stdout).actions[0].error, 1);
    assert.equal(run(cwd, ["actions", "--since", "soon"]).status, 2);

    assert.equal(run(cwd, ["pin", "c1"]).stdout, "ok pin: c1 pinned\n");
    assert.equal(run(cwd, ["pin", "c1", "--unpin"]).stdout, "ok pin: c1 unpinned\n");
    const missing = run(cwd, ["pin", "nope"]);
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr, "case nope not found in project p\n");

    const taken = run(cwd, ["collector", "--port", new URL(url).port]);
    assert.equal(taken.status, 2);
    assert.equal(taken.stderr, `port ${new URL(url).port} is already in use: stop what holds it or pass --port <n>\n`);
  } finally {
    child.kill("SIGTERM");
  }
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(existsSync(join(cwd, "data", "cases.db")), true);
});

test("an unreachable collector is a setup error that says what to do", () => {
  for (const command of [["actions"], ["pin", "c1"]]) {
    const local = run(project("http://127.0.0.1:9"), command);
    assert.equal(local.status, 2);
    assert.equal(local.stderr, "collector at http://127.0.0.1:9 is not reachable: start it with `intersite collector`\n");
  }
  const remote = run(project("https://collector.invalid"), ["actions"]);
  assert.equal(remote.status, 2);
  assert.equal(remote.stderr, "collector at https://collector.invalid is not reachable: check collector.url in intersite.yml\n");
});
