// @ts-check
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { swiftRules } from "../../lint/swift/swiftlint.mjs";
import { fixture, runLint, write } from "./fixture.mjs";

// The first two tests run the real SwiftLint (brew install swiftlint); without it they fail with the install hint.
/** @param {string} out @returns {{ findings: { file: string, line: number, column: number, rule: string, message: string }[], baselined: number }} */
const parse = (out) => JSON.parse(out);
const swiftOn = { project: "swift", lint: { packs: ["swift"] } };
const message = (/** @type {string} */ id) => swiftRules.find((r) => r.id === id)?.message;

/**
 * Runs fn with PATH holding only `node` (the linked oxlint is a node script) and, when given, a fake `swiftlint`
 * script, then restores PATH.
 * @param {string | undefined} fakeSwiftlint shell script body
 * @param {() => Promise<void>} fn
 */
async function withPath(fakeSwiftlint, fn) {
  const bin = mkdtempSync(join(tmpdir(), "intersite-bin-"));
  symlinkSync(process.execPath, join(bin, "node"));
  if (fakeSwiftlint) {
    writeFileSync(join(bin, "swiftlint"), `#!/bin/sh\n${fakeSwiftlint}\n`);
    chmodSync(join(bin, "swiftlint"), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    await fn();
  } finally {
    process.env.PATH = path;
  }
}

test("every Swift rule reports its bad examples and none of its good ones", async () => {
  /** @type {Record<string, string | object>} */
  const files = { "intersite.json": swiftOn };
  for (const r of swiftRules) {
    assert.ok(r.bad?.length, `${r.id} has no bad example`);
    assert.ok(r.good?.length, `${r.id} has no good example`);
    for (const code of [...r.bad, ...r.good]) assert.equal(typeof code, "string", `${r.id} has an example YAML did not read as a string`);
    r.bad.forEach((code, i) => (files[`${r.id}/bad-${i}.swift`] = `${code}\n`));
    r.good.forEach((code, i) => (files[`${r.id}/good-${i}.swift`] = `${code}\n`));
  }
  const { out } = await runLint(fixture(files), ["--json"]);
  const reported = new Set(parse(out).findings.map((f) => `${f.file} ${f.rule}`));
  const problems = [];
  for (const r of swiftRules) {
    r.bad.forEach((code, i) => reported.has(`${r.id}/bad-${i}.swift swift/${r.id}`) || problems.push(`${r.id} missed bad: ${code}`));
    r.good.forEach((code, i) => reported.has(`${r.id}/good-${i}.swift swift/${r.id}`) && problems.push(`${r.id} flagged good: ${code}`));
  }
  assert.deepEqual(problems, [], out);
});

test("Swift findings print as swift/<id> with file, line and message, and go through the baseline", async () => {
  const cwd = fixture({
    "intersite.json": swiftOn,
    "App/Profile.swift": "import SwiftUI\n\nfunc save() {\n    try? store.write(profile)\n}\n",
    "App/Build/ok.swift": "let ok = true\n",
    // A deliberate exception names the rule and says why; the project's own SwiftLint config does not change Intersite's run.
    "App/Kept.swift": "// swiftlint:disable:next no-discarded-try -- best effort, retried on next launch\ntry? cache.write(x)\n",
    ".swiftlint.yml": "only_rules: [force_cast]\n",
    "build/Generated.swift": "func f() { try? store.write(x) }\n",
  });
  let r = await runLint(cwd, ["--json"]);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(parse(r.out), {
    findings: [{ file: "App/Profile.swift", line: 4, column: 1, rule: "swift/no-discarded-try", message: message("no-discarded-try") }],
    baselined: 0,
  });
  r = await runLint(cwd);
  assert.equal(r.out, `App/Profile.swift:4:1 swift/no-discarded-try ${message("no-discarded-try")}`);

  assert.equal((await runLint(cwd, ["--write=init"])).code, 0);
  assert.deepEqual(await runLint(cwd), { code: 0, out: "ok lint: 3 files, 0 new findings, 1 baselined" });

  write(cwd, "App/Profile.swift", "import SwiftUI\n\nfunc save() {\n    try? store.write(profile)\n    print(\"saved\")\n}\n");
  r = await runLint(cwd);
  assert.equal(r.code, 1);
  assert.equal(r.out, `App/Profile.swift:5:5 swift/no-print-logging ${message("no-print-logging")}`);
});

test("a rule override turns one Swift rule off, and --rules lists every Swift rule", async () => {
  const cwd = fixture({ "intersite.json": { project: "swift", lint: { packs: ["swift"], rules: { "swift/no-print-logging": "off" } } } });
  const lines = (await runLint(cwd, ["--rules"])).out.split("\n");
  assert.ok(lines.includes("swift swift/no-print-logging off"));
  assert.ok(lines.includes("swift swift/no-discarded-try on"));
  assert.equal(lines.filter((line) => line.startsWith("swift ")).length, swiftRules.length);
});

test("SwiftLint never runs for a project with no Swift files, or with the swift pack off", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "intersite-marker-")), "ran");
  await withPath(`/usr/bin/touch '${marker}'; echo '[]'`, async () => {
    assert.deepEqual(await runLint(fixture({ "intersite.json": swiftOn, "src/a.ts": "export const a = 1;\n" })), { code: 0, out: "ok lint: 1 files, 0 new findings" });
    assert.equal((await runLint(fixture({ "intersite.json": { project: "swift", lint: { packs: ["slop"] } }, "App/A.swift": "let a = 1\n" }))).code, 0);
    assert.equal(existsSync(marker), false);
    // The same fake does run once there is Swift to lint, so the check above is not vacuous.
    assert.equal((await runLint(fixture({ "intersite.json": swiftOn, "App/A.swift": "let a = 1\n" }))).code, 0);
    assert.equal(existsSync(marker), true);
  });
});

test("Swift files with no swiftlint on PATH is a one-line setup error", async () => {
  await withPath(undefined, async () => {
    const r = await runLint(fixture({ "intersite.json": swiftOn, "App/A.swift": "let a = 1\n" }));
    assert.deepEqual(r, { code: 2, out: "intersite lint: this project has Swift files and swiftlint is not on PATH; install it with `brew install swiftlint`" });
  });
});
