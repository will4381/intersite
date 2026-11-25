// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { references } from "../../gates/references.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { repo, run } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await references({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [], protected: [] })).findings.map((f) => f.message);

/** What `intersite gate references --all` prints, without the advice on how to accept a finding. @param {string} cwd */
const whole = async (cwd) => (await run(cwd, ["references", "--all"])).out.map((line) => line.split(" | to accept")[0]);

const BASE = {
  "package.json": JSON.stringify({ name: "t", scripts: { build: "tsc", "db:generate": "prisma generate" } }),
  ".github/workflows/ci.yml": "name: CI\non: push\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Run the checks\n        run: npm test\n",
  "src/lib/errors.ts": "export class AppError extends Error {}\nexport function fetchOrders(id) { return id; }\n",
  "src/lib/orders/list.ts": "import { fetchOrders } from '../errors';\nexport const listOrders = (id) => fetchOrders(id);\n",
  "docs/guide.md": "# Guide\n\n## Install\n\nRun it.\n",
};

const NEVER = "nothing at that path was ever in this repository (a typo, or a path from another project); point it at the real file, or drop it";
const NAME = "a name that was removed or renamed, a typo, or another project's; name what the code calls it now, or drop it";

test("a line the change adds is reported for the path, link, anchor, script and job that are not there", async () => {
  const r = repo(BASE);
  r.write({
    "docs/new.md": [
      "# New",
      "Errors live in `src/lib/errors.ts` and orders in `lib/orders/list.ts`.",
      "The list is in `src/orders/list.ts`.",
      "See `docs/setup.md` and [the guide](guide.md#install), [setup](setup.md) and [usage](guide.md#usage).",
      "Run `npm run build`, then `npm run biuld`.",
      "In CI the `gate` job runs it and the `deploy` job in ci.yml ships it.",
      "Call `fetchOrders()` or `fetchOrdres()` and throw `AppError`.",
      "",
    ].join("\n"),
  });
  assert.deepEqual(await check(r.cwd), [
    `docs/new.md:3 names \`src/orders/list.ts\`, which is not in the repository (a file of that name is at \`src/lib/orders/list.ts\`): ${NEVER}`,
    `docs/new.md:4 names \`docs/setup.md\`, which is not in the repository: ${NEVER}`,
    "docs/new.md:4 links to `guide.md#usage`, but docs/guide.md has no heading for `#usage`: link a heading that is there",
    `docs/new.md:4 links to \`setup.md\`, which is not in the repository: ${NEVER}`,
    "docs/new.md:5 says to run the `biuld` npm script, but no package.json in the repository has one (did you mean `build`?): name a script that exists",
    "docs/new.md:6 names the `deploy` job, but no workflow in .github/workflows has a job, step or workflow by that name",
  ]);
  // A name the code lacks is not judged on a change that did not remove it; judging everything lists it.
  r.commit("docs");
  assert.deepEqual((await whole(r.cwd)).filter((line) => line.includes("fetchOrdres")), [
    `docs/new.md:7 names \`fetchOrdres()\`, which no code or config file in the repository contains (did you mean \`fetchOrders\`?): ${NAME}`,
  ]);
});

test("what the prose does not assert of this repository is left alone", async () => {
  const r = repo(BASE);
  r.write({
    "docs/new.md": [
      "# New",
      "For example `src/lib/made-up.ts`, `<your-file>.ts`, https://example.com/x.md and `path/to/file.ts`.",
      "We will add `src/lib/retry.ts` and a `retryOrders()` helper next.",
      "The backend's `src/services/billing.ts` and its `user_id` column and `MAX_RETRIES` are another checkout's.",
      "Imports read `fs/promises`, `node_modules/left-pad/index.js`, `@scope/pkg/x.ts` and `dist/`.",
      "`npx tsx scripts/check.ts`, `ls docs/` and `git log -- src/` are commands, and `POST orders/create` a route.",
      "The parser was in `src/lib/parser.ts` before the rewrite.",
      "",
    ].join("\n"),
    "src/lib/errors.test.ts": "// Writes tmp/cases/errors.json for the fixture repository.\nexport const t = 1;\n",
  });
  assert.deepEqual(await check(r.cwd), []);
});

test("an agent's standing instructions are held to this repository: another project's path in them is reported", async () => {
  const r = repo(BASE);
  r.write({ "CLAUDE.md": "# Rules\n\nErrors go through `backend/src/lib/errors.ts`.\nA route file, for example `backend/src/routes/made-up.ts`, stays thin.\n", ".cursor/rules/api.mdc": "Routes live in `backend/src/routes/`.\n" });
  assert.deepEqual(await check(r.cwd), [
    `.cursor/rules/api.mdc:1 names \`backend/src/routes/\`, which is not in the repository: ${NEVER}`,
    `CLAUDE.md:3 names \`backend/src/lib/errors.ts\`, which is not in the repository (a file of that name is at \`src/lib/errors.ts\`): ${NEVER}`,
  ]);
});

test("deleting or moving a file, or removing a name, reports the unchanged docs and comments that still name it", async () => {
  const r = repo({
    ...BASE,
    "src/lib/parser.ts": "export const parse = 1;\n",
    "src/lib/tokens.ts": "export const tokens = 1;\n",
    "docs/api.md": "# API\n\nSee `src/lib/parser.ts` and `src/lib/tokens.ts`.\nCall `fetchOrders()` to list orders.\n`fetchOrders` was the first helper here.\n",
    "src/lib/note.ts": "// The lexer is in src/lib/tokens.ts.\nexport const note = 1;\n",
    "CHANGELOG.md": "# Changelog\n\n- `src/lib/tokens.ts` holds the lexer\n",
  });
  r.git("mv", "src/lib/parser.ts", "src/lib/reader.ts");
  r.rm("src/lib/tokens.ts");
  r.write({ "src/lib/errors.ts": "export class AppError extends Error {}\n", "src/lib/orders/list.ts": "export const listOrders = (id) => id;\n" });
  assert.deepEqual(await check(r.cwd), [
    "docs/api.md:3 names `src/lib/parser.ts`, which this change moves to `src/lib/reader.ts`: name `src/lib/reader.ts`",
    "docs/api.md:3 names `src/lib/tokens.ts`, which this change deletes: point it at where that code lives now, or drop the mention",
    "docs/api.md:4 names `fetchOrders()`, which this change removes from the code: name what replaced it, or drop the mention",
    "src/lib/note.ts:1 names `src/lib/tokens.ts`, which this change deletes: point it at where that code lives now, or drop the mention",
  ]);
});

test("judging everything, history tells a deleted file from one that never was, and git's ignored paths are left alone", async () => {
  const r = repo({ ...BASE, "src/lib/parser.ts": "export const parse = 1;\n", ".gitignore": ".env.local\n" });
  r.rm("src/lib/parser.ts");
  r.commit("drop the parser");
  const sha = r.git("rev-parse", "--short", "HEAD").trim();
  const day = r.git("log", "-1", "--format=%as").trim();
  r.write({
    "docs/api.md": "# API\n\nThe parser is in `src/lib/parser.ts`. Settings are in `.env.local`.\nSee `docs/missing.md`, and `src/services/billing.ts` on the backend.\n",
    "src/lib/note.ts": "// See src/lib/parser.ts for the grammar.\nexport const note = 1;\n",
    "docs/decisions/001-queue.md": "# 1. Queue\n\nStatus: accepted\n\nWe keep `src/lib/parser.ts`.\n",
    "CHANGELOG.md": "# Changelog\n\n- `src/lib/parser.ts` reads the grammar\n",
  });
  r.commit("docs");
  const gone = `src/lib/parser.ts was deleted in ${sha} (${day}); point it at where that lives now, or drop it`;
  assert.deepEqual(await whole(r.cwd), [
    `docs/api.md:3 names \`src/lib/parser.ts\`, which is not in the repository: ${gone}`,
    `docs/api.md:4 names \`docs/missing.md\`, which is not in the repository: ${NEVER}`,
    `src/lib/note.ts:1 names \`src/lib/parser.ts\`, which is not in the repository: ${gone}`,
  ]);
});

test("judging everything, a plan or record whose work is over is reported once, whole", async () => {
  const r = repo({ ...BASE, "src/alpha.ts": "export const a = 1;\n", "src/beta.ts": "export const b = 1;\n", "src/gamma.ts": "export const c = 1;\n" });
  r.rm("src/alpha.ts");
  r.rm("src/beta.ts");
  r.rm("src/gamma.ts");
  r.commit("drop three files");
  const sha = r.git("rev-parse", "--short", "HEAD").trim();
  r.write({
    "docs/decisions/001-queue.md": "# 1. Queue\n\nStatus: accepted\n\nSee `src/lib/errors.ts`.\n",
    "docs/decisions/002-cache.md": "# 2. Cache\n\nStatus: superseded by 003\n\nSee `src/lib/errors.ts`.\n",
    "docs/plans/import-plan.md": "# Import plan\n\n**Status:** shipped\n\n- [x] build `src/import.ts`\n",
    "docs/plans/next-plan.md": "# Next plan\n\nStatus: implemented; not deployed\n\nBuild `src/next.ts`.\n",
    "docs/plans/done-plan.md": "# Done plan\n\n- [x] one\n- [x] two\n- [x] three\n",
    "docs/audits/cleanup-audit.md": "# Cleanup audit\n\nIt read `src/alpha.ts`, `src/beta.ts` and `src/gamma.ts`; `src/lib/errors.ts` stays.\n",
    "docs/audits/README.md": "# Audits\n\nStatus: complete\n",
    "CHANGELOG.md": "# Changelog\n\nStatus: done\n\n- `src/alpha.ts`, `src/beta.ts`, `src/gamma.ts`\n",
  });
  r.commit("docs");
  const day = r.git("log", "-1", "--format=%as").trim();
  const tail = `last edited ${day}. If nothing still needs it, delete it (git keeps it) or move it to an archive folder; if it still guides work, update it`;
  assert.deepEqual(await whole(r.cwd), [
    `docs/audits/cleanup-audit.md is an audit or report whose work looks over: 3 of the 4 files and folders it names are gone from this checkout (\`src/alpha.ts\` was deleted in ${sha}, ${day}); ${tail}`,
    `docs/decisions/002-cache.md is a decision record whose work looks over: its status is superseded; ${tail}`,
    `docs/plans/done-plan.md is a plan whose work looks over: all 3 of its checkboxes are ticked; ${tail}`,
    `docs/plans/import-plan.md is a plan whose work looks over: its status is shipped; ${tail}`,
  ]);
});

test("a shallow clone has no history to ask: only what the prose asserts is reported, and no date is claimed", async () => {
  const r = repo({ ...BASE, "src/lib/parser.ts": "export const parse = 1;\n" });
  r.rm("src/lib/parser.ts");
  r.write({ "docs/api.md": "# API\n\nThe parser is in `src/lib/parser.ts`; see `docs/missing.md`.\n" });
  r.commit("drop the parser");
  const shallow = join(mkdtempSync(join(tmpdir(), "intersite-gate-shallow-")), "clone");
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${r.root}`, shallow]);
  assert.deepEqual(await whole(shallow), ["docs/api.md:3 names `docs/missing.md`, which is not in the repository: point it at the real file, or drop it"]);
});
