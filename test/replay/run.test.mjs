// @ts-check
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { replaySessions } from "../../replay/run.mjs";
import { DEFAULT_ID_PATTERN } from "../../shared/shape.mjs";
import * as adapter from "./adapter.mjs";
import { notesSession, preexistingSession, startTarget } from "./helpers.mjs";

/** @type {Awaited<ReturnType<typeof startTarget>>} */
let target;
beforeEach(async () => { target = await startTarget(); });
afterEach(() => target.close());

/**
 * @param {import("../../shared/case.mjs").Case[]} cases
 * @param {import("../../replay/run.mjs").Mode[]} [modes]
 * @param {import("../../replay/run.mjs").Adapter} [use]
 */
async function replay(cases, modes = ["baseline"], use = adapter) {
  const [result] = await replaySessions({ sessions: [{ session: "s", cases }], target: target.url, adapter: use, modes, idPattern: DEFAULT_ID_PATTERN });
  return result;
}
/** @param {import("../../replay/run.mjs").SessionResult} result */
const failures = (result) => result.steps.filter((step) => step.result === "failed").map((step) => `${step.mode} ${step.caseId} ${step.reason}`);

test("a healthy session passes every step and the invariant", async () => {
  const result = await replay(notesSession());
  assert.deepEqual(result.steps.map((step) => `${step.method} ${step.route} ${step.result}`), [
    "POST /notes passed",
    "GET /notes/:id passed",
    "POST /notes/:id/comments passed",
    "POST /notes/:id/archive passed",
    "INVARIANT ledger balances passed",
  ]);
  assert.equal(result.skipped, undefined);
});

test("a changed status is reported with both statuses", async () => {
  target.bugs.add("status");
  assert.deepEqual(failures(await replay(notesSession())), ["baseline s-notes-2 status recorded 200, got 410"]);
});

test("a changed response shape is reported with the pointer", async () => {
  target.bugs.add("shape");
  assert.deepEqual(failures(await replay(notesSession())), ["baseline s-notes-2 /note/text: missing"]);
});

test("an ID created in step 1 is remapped into later paths and bodies, with the replay header", async () => {
  await replay(notesSession());
  const comment = target.log.find((entry) => entry.path.endsWith("/comments"));
  assert.equal(comment?.path, "/notes/note_000001/comments");
  assert.deepEqual(comment?.body, { noteId: "note_000001", text: "c" });
  assert.equal(comment?.headers["x-intersite-replay"], "s-notes-3");
});

test("an ID the session did not create is skipped without resolveId and runs with it", async () => {
  const { resolveId: _resolveId, ...withoutResolve } = adapter;
  const skipped = await replay([...preexistingSession(), ...notesSession("s-notes", 6000)], ["baseline"], withoutResolve);
  assert.equal(skipped.skipped, "note_prod99 was not created by this session and the adapter has no resolveId");
  assert.deepEqual(skipped.steps.filter((s) => s.method !== "INVARIANT").map((s) => s.result), ["skipped", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal(failures(skipped).length, 0);

  const resolved = await replay(preexistingSession());
  assert.deepEqual(resolved.steps.map((s) => s.result), ["passed", "passed"]);
  assert.equal(target.log.at(-1)?.path, "/notes/note_seed01");

  const unknown = await replay(preexistingSession("note_gone77"));
  assert.equal(unknown.skipped, "resolveId gave nothing for note_gone77");
});

test("twice catches a write that fails when repeated", async () => {
  assert.deepEqual(failures(await replay(notesSession(), ["twice"])), []);
  target.bugs.add("twice");
  assert.deepEqual(failures(await replay(notesSession(), ["twice"])), ["twice s-notes-4 second send got 500, first got 200"]);
});

test("cross-tenant catches a read of another tenant's record", async () => {
  const healthy = await replay(notesSession(), ["cross-tenant"]);
  assert.deepEqual(healthy.steps.map((s) => `${s.caseId} ${s.result}`), ["s-notes-2 passed", "s-notes-3 passed", "s-notes-4 passed"]);
  target.bugs.add("leak");
  const leaky = failures(await replay(notesSession(), ["cross-tenant"]));
  assert.ok(leaky.includes("cross-tenant s-notes-2 another account got 200, expected 401, 403 or 404"), leaky.join("\n"));
});

test("a failing invariant is reported", async () => {
  target.bugs.add("ledger");
  assert.deepEqual(failures(await replay(notesSession())), ["baseline s-notes-4 ledger is off by 1"]);
});
