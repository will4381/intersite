// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { notesSession, preexistingSession, recorded, replayCli, startCollector, startTarget } from "./helpers.mjs";

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

/**
 * Runs the real CLI. @param {string[]} args @param {string} [dir] @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function cli(args, dir = cwd, env = {}) {
  return replayCli(args, dir, env);
}

test("a healthy run prints one ok line with counts and the seed it picked, and marks passing sessions", async () => {
  const run = await cli(["--mark", "--release", "abc123"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^ok replay: 3 sessions; steps: 10 passed, 0 failed, 1 skipped; seed \d+\n$/);
  const seed = run.stdout.trim().split("seed ")[1];
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
  assert.equal(run.stdout, "ok replay: 1 sessions; steps: 4 passed, 0 failed, 0 skipped\n");
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

test("--action reaches the collector query", async () => {
  const run = await cli(["--action", "note.save", "--seed", "3"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(collector.requests, ["GET /v1/sessions?project=demo&sample=20&seed=3&action=note.save"]);
});

test("--verbose adds what was sent and what came back under each FAIL line, and nothing to a pass", async () => {
  const pass = await cli(["--id", "s-a-2", "--verbose"]);
  assert.equal(pass.stdout, "ok replay: 1 sessions; steps: 3 passed, 0 failed, 0 skipped\n");

  target.bugs.add("status");
  const run = await cli(["--id", "s-a-3", "--verbose"]);
  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "replay: 1 sessions; steps: 3 passed, 1 failed, 0 skipped",
    "FAIL baseline s-a-2 GET /notes/:id: status recorded 200, got 410 | rerun: intersite replay --id s-a-2 --mode baseline",
    "  sent: GET /notes/note_000001",
    '  got: 410 {"error":"gone"}',
  ]);
});

test("--concurrency is ignored with a note when the adapter resets shared state", async () => {
  const run = await cli(["--concurrency", "4", "--seed", "1"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, "note: --concurrency 4 ignored; sessions run one at a time because the adapter resets shared state\n");
  assert.match(run.stdout, /^ok replay: 3 sessions/);
});

test("with no local collector running, the command serves the project's own case database itself", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-replay-")));
  const closed = await startTarget();
  await closed.close();
  writeFileSync(join(dir, "intersite.json"), JSON.stringify({
    project: "demo",
    collector: { url: closed.url },
    replay: { target: target.url, adapter: relative(dir, adapterFile) },
  }));
  const run = await cli(["--seed", "1"], dir);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, "ok replay: 0 sessions; steps: 0 passed, 0 failed, 0 skipped; seed 1\n");
  assert.equal(run.code, 0);
  assert.ok(existsSync(join(dir, ".intersite/cases.db")));
});

test("an unreachable remote collector is a setup error that says what to check", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-replay-")));
  writeFileSync(join(dir, "intersite.json"), JSON.stringify({
    project: "demo",
    collector: { url: "http://collector.invalid" },
    replay: { target: target.url, adapter: relative(dir, adapterFile) },
  }));
  const run = await cli([], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "intersite replay: cannot reach the collector at http://collector.invalid; check collector.url in intersite.yml\n");
});

test("--metrics-out writes each baseline case's Server-Timing counters, with the seed and sessions, creating the folder", async () => {
  const run = await cli(["--seed", "7", "--metrics-out", "out/metrics/main.json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^ok replay: 3 sessions; steps: 10 passed, 0 failed, 1 skipped; seed 7\n$/);
  const written = JSON.parse(readFileSync(join(cwd, "out/metrics/main.json"), "utf8"));
  assert.deepEqual(written._meta, { seed: 7, sessions: ["s-a", "s-b", "s-gone"] });
  assert.deepEqual(written["s-a-3"], { queries: 2 });
  assert.equal(Object.keys(written).length, 9, "_meta and the 8 cases that ran");
});

test("--metrics-base fails each case whose counters went up, and its rerun command reproduces it", async () => {
  assert.equal((await cli(["--seed", "7", "--metrics-out", "base.json"])).code, 0);
  target.bugs.add("n+1");
  const run = await cli(["--metrics-base", "base.json"]);
  assert.equal(run.code, 1, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines[0], "replay: 3 sessions; steps: 10 passed, 0 failed, 1 skipped; seed 7; metrics: 8 cases compared, 8 higher");
  const fail = "FAIL metrics s-a-3 POST /notes/:id/comments: queries 2 → 9 | rerun: intersite replay --id s-a-3 --metrics-base base.json";
  assert.ok(lines.includes(fail), run.stdout);

  const rerun = await cli(fail.split("rerun: intersite replay ")[1].split(" "));
  assert.equal(rerun.code, 1, rerun.stderr);
  assert.ok(rerun.stdout.trim().split("\n").includes(fail), rerun.stdout);
});

test("--metrics-base passes when counters are equal or lower, and reuses the base run's seed", async () => {
  target.bugs.add("n+1");
  assert.equal((await cli(["--seed", "7", "--metrics-out", "heavy.json"])).code, 0);
  target.bugs.clear();
  const lower = await cli(["--metrics-base", "heavy.json"]);
  assert.equal(lower.code, 0, lower.stderr);
  assert.equal(lower.stdout, "ok replay: 3 sessions; steps: 10 passed, 0 failed, 1 skipped; seed 7; metrics: 8 cases compared, 0 higher\n");
  assert.ok(collector.requests.every((request) => request.includes("seed=7")), collector.requests.join("\n"));

  assert.equal((await cli(["--seed", "7", "--metrics-out", "light.json"])).code, 0);
  const equal = await cli(["--metrics-base", "light.json", "--metrics-out", "light.json"]);
  assert.equal(equal.code, 0, equal.stdout);
});

test("--metrics-base from a run of other sessions is a setup error", async () => {
  assert.equal((await cli(["--seed", "7", "--metrics-out", "seven.json"])).code, 0);
  const run = await cli(["--seed", "8", "--metrics-base", "seven.json"]);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "intersite replay: --metrics-base seven.json was written by a run of other sessions (seed 7); replay the same ones: same --seed, --sample and filters, on the same local data\n");
});

test("--mode ui drives the app in replay.uiTarget: ok when healthy; a broken page exits 1 and its rerun command reproduces it", async () => {
  let broken = false;
  const app = createServer(async (req, res) => {
    const path = req.url ?? "/";
    if (!path.startsWith("/api/")) {
      return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><link rel="icon" href="data:,">
<button id="read" data-intersite="note.open">Open</button>
<script>${broken ? 'throw new Error("boom on load");' : ""}
document.getElementById("read").onclick = () => fetch("/api" + location.pathname);</script>`);
    }
    const tenant = req.headers["x-tenant"];
    const answer = await fetch(target.url + path.slice(4), { headers: typeof tenant === "string" ? { "x-tenant": tenant } : {} });
    res.writeHead(answer.status, { "content-type": "application/json" }).end(await answer.text());
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", () => done(undefined)));
  const page = "/notes/note_prod99";
  const uiCollector = await startCollector([{
    ...recorded({ id: "u-1", session: "u", seq: 1, method: "GET", route: "/notes/:id", path: page, status: 200, json: { note: { id: "note_prod99", text: "seed" } } }),
    action: { name: "note.open", page },
  }]);
  try {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-replay-ui-")));
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(fileURLToPath(new URL("../../node_modules/playwright-core", import.meta.url)), join(dir, "node_modules/playwright-core"));
    writeFileSync(join(dir, "intersite.json"), JSON.stringify({
      project: "demo",
      collector: { url: uiCollector.url },
      replay: { target: target.url, adapter: relative(dir, adapterFile), uiTarget: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.address()).port}` },
    }));

    const healthy = await cli(["--mode", "ui", "--seed", "1"], dir);
    assert.equal(healthy.code, 0, healthy.stderr + healthy.stdout);
    assert.equal(healthy.stdout, "ok replay: 1 sessions; steps: 1 passed, 0 failed, 0 skipped; seed 1\n");
    assert.ok(target.log.some((entry) => entry.path === "/notes/note_seed01" && entry.headers["x-tenant"] === "a"), "the click read the note signed in");

    broken = true;
    const run = await cli(["--mode", "ui", "--seed", "1"], dir);
    assert.equal(run.code, 1, run.stderr);
    const fail = "FAIL ui u-1 note.open /notes/note_prod99: page error: boom on load | rerun: intersite replay --id u-1 --mode ui";
    assert.deepEqual(run.stdout.trim().split("\n"), ["replay: 1 sessions; steps: 0 passed, 1 failed, 0 skipped; seed 1", fail]);

    const rerun = await cli(fail.split("rerun: intersite replay ")[1].split(" "), dir);
    assert.equal(rerun.code, 1, rerun.stderr);
    assert.deepEqual(rerun.stdout.trim().split("\n"), ["replay: 1 sessions; steps: 0 passed, 1 failed, 0 skipped", fail]);
  } finally {
    await Promise.all([uiCollector.close(), new Promise((done) => app.close(done))]);
  }
});

test("--mode ui without replay.uiTarget exits 2 with one line", async () => {
  const run = await cli(["--mode", "ui", "--seed", "1"]);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "intersite replay: ui mode needs replay.uiTarget in intersite.yml\n");
});

test("--mode ui with replay.browser lightpanda and no lightpanda on PATH exits 2 with one line saying how to install it", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-replay-lightpanda-")));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(fileURLToPath(new URL("../../node_modules/playwright-core", import.meta.url)), join(dir, "node_modules/playwright-core"));
  writeFileSync(join(dir, "intersite.json"), JSON.stringify({
    project: "demo",
    collector: { url: collector.url },
    replay: { target: target.url, adapter: relative(dir, adapterFile), uiTarget: "http://127.0.0.1:9", browser: "lightpanda" },
  }));
  const run = await cli(["--mode", "ui", "--seed", "1"], dir, { PATH: dir });
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "intersite replay: replay.browser lightpanda needs the lightpanda binary on PATH; install it with "
    + "curl -fsSL https://pkg.lightpanda.io/install.sh | bash (it goes to ~/.local/bin), or set replay.browserUrl to a running one\n");
});

test("with recorded sessions and nothing answering at the target, replay exits 2 with one line saying what to start", async () => {
  const closed = createServer();
  await new Promise((done) => closed.listen(0, "127.0.0.1", () => done(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (closed.address()).port;
  await new Promise((done) => closed.close(done));
  const run = await cli(["--target", `http://127.0.0.1:${port}`]);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, `intersite replay: nothing answers at http://127.0.0.1:${port}: start the project's server there, or point replay.target in intersite.yml (or --target) at it\n`);
});

test("an error thrown inside the adapter names the adapter file and function", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-adapter-error-")));
  writeFileSync(join(dir, "intersite.adapter.mjs"), 'export async function signIn() { return {}; }\nexport async function reset() { throw new Error("db down"); }\n');
  writeFileSync(join(dir, "intersite.json"), JSON.stringify({ project: "demo", collector: { url: collector.url }, replay: { target: target.url } }));
  const run = await cli(["--seed", "1"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stderr, "intersite replay: ./intersite.adapter.mjs reset: db down\n");
});

test("--json --verbose adds the recorded cases, so a bug can be reproduced from the request production saw", async () => {
  const run = await cli(["--id", "s-b-3", "--json", "--verbose"]);
  assert.equal(run.code, 0, run.stderr);
  const { recorded: sessions } = JSON.parse(run.stdout);
  assert.deepEqual(sessions[0].cases.map((/** @type {{ id: string }} */ item) => item.id), ["s-b-1", "s-b-2", "s-b-3"]);
  assert.deepEqual(sessions[0].cases[2].request.body, { noteId: "note_prodA1", text: "c" });
  assert.equal(JSON.parse((await cli(["--id", "s-b-3", "--json"])).stdout).recorded, undefined, "without --verbose the output stays small");
});
