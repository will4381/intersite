// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareSnapshots, describe, normalise } from "../../replay/snapshot.mjs";
import { listSession, replayCli, startCollector, startTarget } from "./helpers.mjs";

const adapterFile = fileURLToPath(new URL("./adapter.mjs", import.meta.url));
const SNAP = ".intersite/snapshot.json";

/** @type {Awaited<ReturnType<typeof startTarget>>} */
let target;
/** @type {Awaited<ReturnType<typeof startCollector>>} */
let collector;

/** A project folder whose config points at the toy target and fake collector. @param {Record<string, unknown>} [replay] */
function project(replay = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "intersite-snapshot-")));
  writeFileSync(join(dir, "intersite.json"), JSON.stringify({
    project: "demo", collector: { url: collector.url }, replay: { target: target.url, adapter: relative(dir, adapterFile), ...replay },
  }));
  return dir;
}

/** A project with a snapshot written by a healthy run with seed 7. */
async function withBase(replay = {}) {
  const dir = project(replay);
  const run = await replayCli(["--seed", "7", "--snapshot-out", SNAP], dir);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  return dir;
}

before(async () => {
  target = await startTarget();
  collector = await startCollector(listSession());
});
after(() => Promise.all([target.close(), collector.close()]));
// "fresh" stays on: every run creates new random IDs and timestamps, as a real server does.
beforeEach(() => {
  target.bugs.clear();
  target.bugs.add("fresh");
});

test("two runs with nothing changed write the same snapshot and report no difference, though created IDs and timestamps differ", async () => {
  const dir = await withBase();
  const first = readFileSync(join(dir, SNAP), "utf8");
  const reads = () => target.log.filter((entry) => entry.path.startsWith("/notes/")).map((entry) => entry.path);
  const before = reads();
  const run = await replayCli(["--snapshot-base", SNAP, "--snapshot-out", SNAP], dir);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(run.stdout, "ok replay: 1 sessions; steps: 6 passed, 0 failed, 0 skipped; seed 7; snapshot: 5 cases compared, 0 changed\n");
  assert.notEqual(reads().at(-1), before.at(-1), "the second run read a note with a new ID");
  const written = JSON.parse(first);
  const { _meta: { startedAt, ...meta }, ...bodies } = written;
  const { _meta: { startedAt: startedAgain, ...metaAgain }, ...bodiesAgain } = JSON.parse(readFileSync(join(dir, SNAP), "utf8"));
  assert.deepEqual([metaAgain, bodiesAgain], [meta, bodies], "only the start time differs");
  assert.deepEqual(meta, { seed: 7, sessions: ["s-list"] });
  assert.ok(startedAt < startedAgain && new Date(startedAt).toISOString() === startedAt, "_meta.startedAt is the run's start, as ISO");
  assert.deepEqual(written["s-list-4"], {
    status: 200,
    body: { notes: [{ id: "note_seed01", text: "seed", createdAt: "<now>" }, { id: "<id:1>", text: "t1", createdAt: "<now>" }, { id: "<id:2>", text: "t2", createdAt: "<now>" }], requestId: "<request-id>" },
  });
});

test("a value a migration changed is reported with its pointer and both values, and the rerun command reproduces it", async () => {
  const dir = await withBase();
  target.bugs.add("migration");
  const run = await replayCli(["--snapshot-base", SNAP], dir);
  assert.equal(run.code, 1, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines[0], "replay: 1 sessions; steps: 6 passed, 0 failed, 0 skipped; seed 7; snapshot: 5 cases compared, 4 changed");
  const fail = `FAIL snapshot s-list-1 POST /notes: /note/text "t1" → "T1" | rerun: intersite replay --id s-list-1 --snapshot-base ${SNAP}`;
  assert.equal(lines[1], fail);
  assert.equal(lines[4], `FAIL snapshot s-list-4 GET /notes: /notes/0/text "seed" → "SEED"; /notes/1/text "t1" → "T1"; /notes/2/text "t2" → "T2" | rerun: intersite replay --id s-list-4 --snapshot-base ${SNAP}`);

  const rerun = await replayCli(fail.split("rerun: intersite replay ")[1].split(" "), dir);
  assert.equal(rerun.code, 1, rerun.stderr);
  assert.deepEqual(rerun.stdout.trim().split("\n"), ["replay: 1 sessions; steps: 2 passed, 0 failed, 0 skipped; snapshot: 1 cases compared, 1 changed", fail]);
});

test("a changed status is reported", async () => {
  const dir = await withBase();
  target.bugs.add("status");
  const run = await replayCli(["--snapshot-base", SNAP], dir);
  assert.equal(run.code, 1);
  assert.ok(run.stdout.includes(`FAIL snapshot s-list-3 GET /notes/:id: status 200 → 410; /note {"id":"<id:1>","text":"t1","createdAt":… → (none); /error (none) → "gone" | rerun: intersite replay --id s-list-3 --snapshot-base ${SNAP}`), run.stdout);
});

test("a reordered list of rows with ids is one reorder, not every row changed", async () => {
  const dir = await withBase();
  target.bugs.add("reorder");
  const run = await replayCli(["--snapshot-base", SNAP], dir);
  assert.equal(run.code, 1);
  assert.deepEqual(run.stdout.trim().split("\n").slice(1), [
    `FAIL snapshot s-list-4 GET /notes: /notes reordered ["note_seed01","<id:1>","<id:2>"] → ["<id:2>","<id:1>","note_seed01"] | rerun: intersite replay --id s-list-4 --snapshot-base ${SNAP}`,
  ]);
});

test("a pointer in replay.snapshotIgnore is left out of the comparison", async () => {
  const dir = await withBase({ snapshotIgnore: ["/note/text", "/notes/*/text"] });
  target.bugs.add("migration");
  const run = await replayCli(["--snapshot-base", SNAP], dir);
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /snapshot: 5 cases compared, 0 changed\n$/);
});

test("--snapshot-base from a run of other sessions is a setup error", async () => {
  const dir = await withBase();
  const run = await replayCli(["--seed", "8", "--snapshot-base", SNAP], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, `intersite replay: --snapshot-base ${SNAP} was written by a run of other sessions (seed 7); replay the same ones: same --seed, --sample and filters, on the same local data\n`);
});

test("--json carries every difference in full, and leaves the snapshot bodies out of the session results", async () => {
  const dir = await withBase();
  target.bugs.add("migration");
  const run = await replayCli(["--snapshot-base", SNAP, "--json"], dir);
  assert.equal(run.code, 1);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.snapshot.length, 4);
  assert.deepEqual(parsed.snapshot[0], { caseId: "s-list-1", method: "POST", route: "/notes", differences: [{ pointer: "/note/text", before: "t1", after: "T1" }] });
  assert.equal(parsed.sessions[0].snapshot, undefined);
});

test("by position, an added or missing row and a long value are shown truncated, with a count of the rest", () => {
  const base = { c: { status: 200, body: { items: [1, 2], text: "x".repeat(60), a: 1, b: 2 } } };
  const now = { c: { status: 200, body: { items: [1, 3, 4], text: "y".repeat(60), a: 2, b: 3 } } };
  const [found] = compareSnapshots(base, now, []);
  assert.deepEqual(found.differences.map((d) => d.pointer), ["/items/1", "/items/2", "/text", "/a", "/b"]);
  assert.deepEqual(found.differences[1], { pointer: "/items/2", before: undefined, after: 4 });
  assert.equal(describe(found.differences), `/items/1 2 → 3; /items/2 (none) → 4; /text "${"x".repeat(38)}… → "${"y".repeat(38)}…; and 2 more`);
  assert.deepEqual(compareSnapshots(base, { gone: now.c }, []), [], "a case on one side only is not compared");
});

test("a secret or token in an answer is written as <secret>: new every run, and not for a file on disk", () => {
  const run = { created: new Set(), numbers: new Map(), from: Date.now() };
  const body = { id: "key_8fK2abQ9", secret: "lucra_test_50d73eb11a_m2FG3Y", setupIntentClientSecret: "seti_123_secret_456", accessToken: "eyJ.x.y", name: "Replay" };
  assert.deepEqual(normalise(body, run), { id: "key_8fK2abQ9", secret: "<secret>", setupIntentClientSecret: "<secret>", accessToken: "<secret>", name: "Replay" });
});

test("a timestamp set as now plus a fixed offset matches across runs by its offset from each run's start; a changed offset still shows", async () => {
  // The recorded answers have no expiresAt, so baseline fails those steps; only the snapshot lines matter here.
  target.bugs.add("expiry");
  const dir = project();
  await replayCli(["--seed", "7", "--snapshot-out", SNAP], dir);
  const same = await replayCli(["--snapshot-base", SNAP], dir);
  assert.match(same.stdout, /snapshot: 5 cases compared, 0 changed\n/);

  target.bugs.add("longer-expiry");
  const longer = await replayCli(["--snapshot-base", SNAP], dir);
  assert.match(longer.stdout, /snapshot: 5 cases compared, 4 changed\n/);
  assert.match(longer.stdout, /FAIL snapshot s-list-1 POST \/notes: \/note\/expiresAt "\d{4}-[^"]+" → "\d{4}-[^"]+" \|/);
  assert.ok(!longer.stdout.includes("createdAt"), "a timestamp near now is still <now>");

  // A file written before the start time was recorded still loads; its timestamps are compared as they were written.
  target.bugs.delete("longer-expiry");
  const file = join(dir, SNAP);
  const { _meta: { startedAt: _startedAt, ...meta }, ...bodies } = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ _meta: meta, ...bodies }));
  const old = await replayCli(["--snapshot-base", SNAP], dir);
  assert.equal(old.stderr, "");
  assert.match(old.stdout, /snapshot: 5 cases compared, 4 changed\n/);
  assert.match(old.stdout, /FAIL snapshot s-list-1 POST \/notes: \/note\/expiresAt "/);
});
