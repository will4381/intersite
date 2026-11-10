// @ts-check
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { READ_TOKEN, notesSession, preexistingSession, startCollector, startTarget } from "./helpers.mjs";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));
const adapterFile = fileURLToPath(new URL("./adapter.mjs", import.meta.url));

/** @type {Awaited<ReturnType<typeof startTarget>>} */
let target;
/** @type {Awaited<ReturnType<typeof startCollector>>} */
let collector;
let cwd = "";

before(async () => {
  target = await startTarget();
  collector = await startCollector([...notesSession("s-a", 1000), ...notesSession("s-b", 2000), ...preexistingSession("note_gone77", "s-gone")]);
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "intersite-replay-")));
  writeFileSync(join(cwd, "intersite.json"), JSON.stringify({
    project: "demo",
    collector: { url: collector.url },
    replay: { target: target.url, adapter: relative(cwd, adapterFile) },
  }));
});
after(() => Promise.all([target.close(), collector.close()]));
beforeEach(() => {
  target.bugs.clear();
  collector.results.length = 0;
  collector.requests.length = 0;
});

/** Runs the real CLI. @param {string[]} args @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
function cli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [bin, "replay", ...args], { cwd, env: { ...process.env, INTERSITE_READ_TOKEN: READ_TOKEN } }, (error, stdout, stderr) =>
      done({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

test("a healthy run exits 0, prints counts and the seed it picked, and marks passing sessions", async () => {
  const run = await cli(["--mark", "--release", "abc123"]);
  assert.equal(run.code, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.match(lines[0], /^replay: 3 sessions; steps: 10 passed, 0 failed, 1 skipped; seed \d+$/);
  assert.deepEqual(lines.slice(1), ["SKIP s-gone: resolveId gave nothing for note_gone77"]);
  const seed = lines[0].split("seed ")[1];
  assert.ok(collector.requests.some((r) => r.includes(`seed=${seed}`)), "the printed seed is the one sent");
  assert.deepEqual(collector.results, [{ project: "demo", release: "abc123", results: [{ session: "s-a", pass: true }, { session: "s-b", pass: true }] }]);
});

test("a failing run exits 1 with one FAIL line, marks the failure, and its rerun command reproduces it", async () => {
  target.bugs.add("twice");
  const run = await cli(["--mode", "twice", "--seed", "7", "--mark", "--release", "abc123"]);
  assert.equal(run.code, 1, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines[0], "replay: 3 sessions; steps: 4 passed, 2 failed, 0 skipped; seed 7");
  const fail = "FAIL twice s-a-4 POST /notes/:id/archive: second send got 500, first got 200 | rerun: intersite replay --id s-a-4 --mode twice";
  assert.equal(lines[1], fail);
  assert.deepEqual(collector.results[0].results, [{ session: "s-a", pass: false }, { session: "s-b", pass: false }]);

  const rerun = await cli(fail.split("rerun: intersite replay ")[1].split(" "));
  assert.equal(rerun.code, 1, rerun.stderr);
  assert.deepEqual(rerun.stdout.trim().split("\n"), ["replay: 1 sessions; steps: 2 passed, 1 failed, 0 skipped", fail]);
});

test("--id replays the case together with the earlier cases of its session", async () => {
  const run = await cli(["--id", "s-b-3"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), "replay: 1 sessions; steps: 4 passed, 0 failed, 0 skipped");
  assert.deepEqual(collector.requests, ["GET /v1/cases/s-b-3?project=demo"]);
});

test("--json prints the structured results only", async () => {
  target.bugs.add("ledger");
  const run = await cli(["--id", "s-a-1", "--json"]);
  assert.equal(run.code, 1);
  const parsed = JSON.parse(run.stdout);
  assert.deepEqual(parsed.sessions[0].steps.at(-1), { mode: "baseline", caseId: "s-a-1", method: "INVARIANT", route: "ledger balances", result: "failed", reason: "ledger is off by 1" });
});

test("a remote target is refused with exit 2 and nothing is sent", async () => {
  const run = await cli(["--target", "https://api.example.com"]);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr.trim(), "intersite replay: refusing to send replayed writes to api.example.com, which is not a local host; pass --allow-remote if that is intended");
  assert.deepEqual(collector.requests, []);
});

test("usage errors exit 2 with one line", async () => {
  for (const args of [["--bogus"], ["--mode", "chaos"], ["--mark"], ["--sample", "0"]]) {
    const run = await cli(args);
    assert.equal(run.code, 2, args.join(" "));
    assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
  }
});
