// @ts-check
// The Rust engine's own unit tests (core/src/**), run with the rest so `npm test` covers both languages.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the Rust engine's unit tests pass", (t) => {
  if (spawnSync("cargo", ["--version"]).status !== 0) return t.skip("Rust (cargo) is not installed");
  const manifest = fileURLToPath(new URL("../core/Cargo.toml", import.meta.url));
  const run = spawnSync("cargo", ["test", "--release", "--quiet", "--manifest-path", manifest], { encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.trim().split("\n").slice(-30).join("\n"));
  assert.match(run.stdout, /test result: ok\. \d+ passed; 0 failed/);
});
