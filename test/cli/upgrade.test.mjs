// @ts-check
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { installed, newer } from "../../cli/upgrade.mjs";
import { repo } from "../gates/repo.mjs";

const bin = fileURLToPath(new URL("../../bin/intersite.mjs", import.meta.url));

test("versions order by number, and a release comes after its release candidates", () => {
  assert.equal(newer("v1.0.0-rc.15", "1.0.0-rc.14"), true);
  assert.equal(newer("v1.0.0-rc.9", "1.0.0-rc.14"), false, "rc.9 is older than rc.14, though it sorts after as text");
  assert.equal(newer("v1.0.0", "1.0.0-rc.14"), true);
  assert.equal(newer("v1.0.0-rc.14", "1.0.0-rc.14"), false);
  assert.equal(newer("not-a-version", "1.0.0"), false);
});

test("check names a newer release, from the day's cached lookup, before its last line", async () => {
  const r = repo({ "src/a.mjs": "export const a = 1;\n" });
  const cache = join(r.cwd, "node_modules", ".cache", "intersite");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "latest-release.json"), JSON.stringify({ checked: Date.now(), tag: "v99.0.0" }));
  const lines = await new Promise((done) => execFile(process.execPath, [bin, "check", "--skip", "lint"], { cwd: r.cwd }, (_error, stdout) => done(stdout.trim().split("\n"))));
  assert.equal(lines.at(-2), `upgrade intersite: v99.0.0 is out and this is v${installed}; install github:will4381/intersite#v99.0.0 as a dev dependency (npm i -D, or the project's package manager), then run \`npx intersite init\``);
  assert.match(lines.at(-1), /^ok check: /);
});
