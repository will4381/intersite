// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const files = { "src/handler.ts": "export const h = 1;\n", "PLAN.md": "# plan\n", "docs/intro.md": "# intro\n", "src/utils.ts": "" };

test("backups, copies, scratch files, logs and working notes added by the change are reported, untracked included", async () => {
  const r = repo({ "src/handler.ts": "export const h = 1;\n", "src/utils.ts": "" });
  r.write({ "src/handler.ts": "export const h = 2;\n", "src/handler_old.ts": "export const h = 1;\n", "src/utils.bak": "", "scratch.mjs": "", "debug.log": "", "PLAN.md": "" });
  const { code, out } = await run(r.cwd, ["artifacts"]);
  assert.equal(code, 1);
  assert.deepEqual(out.map((line) => line.split(" | ")[0]).sort(), [
    "PLAN.md looks like a working note: delete it, or move what should last into the README",
    "debug.log is a log or output dump: delete it",
    "scratch.mjs is a scratch or debug file: delete it, or turn it into a real script or test",
    "src/handler_old.ts is a copy of src/handler.ts: delete it, git keeps the history",
    "src/utils.bak is a backup file: delete it, git keeps the history",
  ]);
  assert.match(out[0], / \| to accept: add \{ "gate": "artifacts", "target": ".+", "why": "…" \} to gates\.acknowledged in intersite\.yml$/);
});

test("modified notes, notes in an existing docs folder, standard files and names that are not copies are not reported", async () => {
  const r = repo(files);
  r.write({
    "PLAN.md": "# plan, revised\n",
    "docs/plan.md": "",
    "docs/SUMMARY.md": "",
    "README.md": "",
    "CHANGELOG.md": "",
    "src/api-v2.ts": "",
    "src/handler-copy.ts": "export const headline = 'Save 20%';\n",
  });
  const { code, out } = await run(r.cwd, ["artifacts"]);
  assert.equal(code, 0, out.join("\n"));
  assert.deepEqual(out, ["ok gate artifacts: 6 added files checked"]);
});

test("a gates.artifacts glob is reported, an acknowledged target is not, and --json lists targets", async () => {
  const r = repo(files, { artifacts: ["**/*.snapshot.html"], acknowledged: [{ gate: "artifacts", target: "NOTES.md", why: "kept for the release" }] });
  r.write({ "src/page.snapshot.html": "", "NOTES.md": "" });
  const { code, out } = await run(r.cwd, ["artifacts", "--json"]);
  assert.equal(code, 1);
  const result = JSON.parse(out[0]);
  assert.equal(result.gate, "artifacts");
  assert.deepEqual(result.findings.map((/** @type {{ target: string }} */ f) => f.target), ["src/page.snapshot.html"]);
});

test("a working note outside docs points at the docs folder, and code split out of a file is not a copy", async () => {
  const r = repo({ ...files, "src/media.ts": "const a = 1;\nconst b = 2;\nexport { a, b };\n" });
  r.write({ "src/IMPLEMENTATION_SUMMARY.md": "", "src/media.ts": `import { a, b } from "./media-copy";\nexport { a, b };\n`, "src/media-copy.ts": "const a = 1;\nconst b = 2;\nexport { a, b };\n" });
  const { out } = await run(r.cwd, ["artifacts"]);
  assert.equal(out.length, 1);
  assert.match(out[0], /^src\/IMPLEMENTATION_SUMMARY\.md looks like a working note: delete it, or move what should last into docs\//);
});
