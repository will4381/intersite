// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixture, runLint, write } from "./fixture.mjs";

const emptyCatch = "try { run(); } catch {}\n";

test("baseline ratchet: new findings fail, recorded ones pass, fixed ones demand --write, --write never raises", async () => {
  const cwd = fixture({
    "intersite.json": { project: "ratchet", lint: { packs: ["slop"] } },
    ".oxlintrc.json": { rules: { "no-debugger": "error" } },
    "src/a.ts": emptyCatch + "debugger;\n",
  });
  const baseline = () => JSON.parse(readFileSync(join(cwd, "intersite-baseline.json"), "utf8"));

  let r = await runLint(cwd);
  assert.equal(r.code, 1);
  assert.match(r.out, /^src\/a\.ts:1:\d+ intersite\/no-empty-catch An empty catch/m);

  assert.equal((await runLint(cwd, ["--write=init"])).code, 0);
  assert.deepEqual(baseline(), { "src/a.ts": { "eslint/no-debugger": 1, "intersite/no-empty-catch": 1 } });
  assert.equal((await runLint(cwd)).code, 0, "baseline'd findings pass");

  write(cwd, "src/a.ts", emptyCatch + emptyCatch + "debugger;\n");
  r = await runLint(cwd);
  assert.equal(r.code, 1, "a new finding fails");
  assert.match(r.out, /^src\/a\.ts:2:\d+ intersite\/no-empty-catch/m);

  write(cwd, "src/a.ts", "debugger;\n");
  r = await runLint(cwd);
  assert.equal(r.code, 1, "a fixed finding demands --write");
  assert.match(r.out, /src\/a\.ts intersite\/no-empty-catch: 0 findings, baseline allows 1; run intersite lint --write/);

  assert.equal((await runLint(cwd, ["--write"])).code, 0);
  assert.deepEqual(baseline(), { "src/a.ts": { "eslint/no-debugger": 1 } });

  write(cwd, "src/a.ts", emptyCatch + "debugger;\ndebugger;\n");
  assert.equal((await runLint(cwd, ["--write"])).code, 1, "--write still fails on new findings");
  assert.deepEqual(baseline(), { "src/a.ts": { "eslint/no-debugger": 1 } }, "--write never raises");
});

test("custom rules from intersite.yml are enforced within their files globs", async () => {
  const cwd = fixture({
    "intersite.json": {
      project: "custom",
      lint: {
        packs: [],
        custom: [
          {
            id: "no-fetch-in-ui",
            selector: "CallExpression[callee.name='fetch']",
            message: "UI code calls the API client, not fetch.",
            files: ["src/ui/**"],
          },
        ],
      },
    },
    "src/ui/page.ts": "fetch('/api');\n",
    "src/api/client.ts": "fetch('/api');\n",
  });
  const r = await runLint(cwd);
  assert.equal(r.code, 1);
  assert.equal(r.out, "src/ui/page.ts:1:1 intersite/no-fetch-in-ui UI code calls the API client, not fetch.");
});
