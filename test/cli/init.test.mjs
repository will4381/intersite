// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import init from "../../cli/init.mjs";
import { loadConfig } from "../../shared/config.mjs";
import { run as runGate } from "../gates/repo.mjs";
import { fixture } from "../lint/fixture.mjs";

/** Runs init in `cwd` and returns what it printed. @param {string} cwd */
async function run(cwd) {
  /** @type {string[]} */
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    assert.equal(await init([], { cwd }), 0);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("init writes the config, adapter and agent rules, and a second run changes nothing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "@Acme/Web App" }));
  writeFileSync(join(cwd, "AGENTS.md"), "# Rules\n\nBe kind.\n");
  writeFileSync(join(cwd, ".gitignore"), "node_modules/");

  assert.equal(
    await run(cwd),
    "ok init: wrote intersite.yml, .intersite/adapter.mjs, AGENTS.md, .claude/skills/intersite/SKILL.md, .claude/skills/intersite-bug/SKILL.md, " +
      ".claude/skills/intersite-rule/SKILL.md, .claude/skills/intersite-setup/SKILL.md, .claude/settings.json, .intersite/.gitignore; install oxlint and @oxlint/plugins, then run `intersite lint --write=init`",
  );
  assert.match(readFileSync(join(cwd, ".claude/skills/intersite/SKILL.md"), "utf8"), /^---\nname: intersite\n/);
  assert.equal(loadConfig(cwd).project, "acme-web-app");
  assert.match(readFileSync(join(cwd, ".intersite/adapter.mjs"), "utf8"), /export async function signIn/);
  assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "node_modules/", "the project's own .gitignore is left alone");
  const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# Rules\n\nBe kind.\n\n<!-- intersite:start -->\n## Testing with Intersite"));
  assert.ok(agents.endsWith("<!-- intersite:end -->\n"));

  assert.equal(await run(cwd), "ok init: already set up");
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), agents);
});

test("init refreshes only its own block in AGENTS.md and keeps the project's edits elsewhere", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-"));
  writeFileSync(join(cwd, "intersite.json"), JSON.stringify({ project: "kept" }));
  writeFileSync(join(cwd, "AGENTS.md"), "Top.\n\n<!-- intersite:start -->\nold rules\n<!-- intersite:end -->\n\nBottom.\n");

  assert.match(await run(cwd), /^ok init: wrote \.intersite\/adapter\.mjs, AGENTS\.md, \.claude\/skills\/intersite\/SKILL\.md, /);
  assert.equal(loadConfig(cwd).project, "kept");
  const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("Top.\n\n<!-- intersite:start -->\n## Testing with Intersite"));
  assert.ok(agents.endsWith("<!-- intersite:end -->\n\nBottom.\n"));
  assert.ok(!agents.includes("old rules"));
});

test("with no intersite.yml every default applies and the project is named after its package", () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-bare-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "slabs" }));
  const config = loadConfig(cwd);
  assert.equal(config.project, "slabs");
  assert.deepEqual(config.gates.run, ["test-integrity", "duplicates", "similar", "new-deps", "artifacts", "unused", "naming", "style-drift", "value-drift", "sql", "regex", "decisions", "renames", "schema-drift", "imports", "boundaries", "tamper", "special-case", "complexity","columns","routes","env","secrets","auth","structure"]);
  assert.equal(config.collector.url, "http://127.0.0.1:8790");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "Café Crème" }));
  assert.equal(loadConfig(cwd).project, "cafe-creme");
});

test("init leaves one file beside the project: .intersite keeps what is generated out of git and commits the baseline and adapter", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-git-"));
  execFileSync("git", ["init", "-q"], { cwd });
  await run(cwd);
  assert.equal(existsSync(join(cwd, ".gitignore")), false);
  const ignored = (/** @type {string} */ path) => { try { execFileSync("git", ["check-ignore", "-q", path], { cwd }); return true; } catch { return false; } };
  assert.deepEqual(["cases.db", "ledger.jsonl", "oxlintrc.json", "baseline.json", "adapter.mjs", ".gitignore"].map((f) => [f, ignored(`.intersite/${f}`)]), [
    ["cases.db", true], ["ledger.jsonl", true], ["oxlintrc.json", true], ["baseline.json", false], ["adapter.mjs", false], [".gitignore", false],
  ]);
  assert.equal(await run(cwd), "ok init: already set up");
});

test("init moves an older project's files into .intersite and takes out the .gitignore line that hid them", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-move-"));
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(cwd, "intersite.yml"), "project: old\n");
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n.intersite/\n");
  writeFileSync(join(cwd, "intersite-baseline.json"), JSON.stringify({ "src/a.ts": { "intersite/no-empty-catch": 1 } }));
  writeFileSync(join(cwd, "intersite-gates-baseline.json"), JSON.stringify({ unused: ["src/b.ts"] }));
  writeFileSync(join(cwd, "intersite.adapter.mjs"), "export async function signIn() { return { cookie: 'mine' }; }\n");
  assert.match(await run(cwd), /^ok init: wrote \.intersite\/baseline\.json \(from intersite-baseline\.json, intersite-gates-baseline\.json\), \.intersite\/adapter\.mjs \(from intersite\.adapter\.mjs\), /);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".intersite/baseline.json"), "utf8")), { lint: { "src/a.ts": { "intersite/no-empty-catch": 1 } }, gates: { unused: ["src/b.ts"] } });
  assert.match(readFileSync(join(cwd, ".intersite/adapter.mjs"), "utf8"), /mine/);
  assert.deepEqual(["intersite-baseline.json", "intersite-gates-baseline.json", "intersite.adapter.mjs"].filter((f) => existsSync(join(cwd, f))), []);
  assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "node_modules/\n");
  assert.equal(loadConfig(cwd).replay.adapter, "./.intersite/adapter.mjs");
});

test("installing intersite itself does not fail the first check: init acknowledges it for new-deps", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-deps-"));
  const git = (/** @type {string[]} */ ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app", devDependencies: { vite: "^5.0.0" } }));
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app", devDependencies: { vite: "^5.0.0", intersite: "github:will4381/intersite#v1" } }));
  await run(cwd);
  assert.equal((await runGate(cwd, ["new-deps"])).code, 0);
});

test("init says so when a parent .gitignore ignores .intersite as a whole, and leaves that file alone", async () => {
  const top = mkdtempSync(join(tmpdir(), "intersite-init-mono-"));
  execFileSync("git", ["init", "-q"], { cwd: top });
  writeFileSync(join(top, ".gitignore"), "**/.intersite/\n");
  const cwd = join(top, "apps/web");
  mkdirSync(cwd, { recursive: true });
  assert.match(await run(cwd), /; a \.gitignore ignores \.intersite\/ as a whole, which keeps \.intersite\/baseline\.json out of git: remove that line$/);
  assert.equal(readFileSync(join(top, ".gitignore"), "utf8"), "**/.intersite/\n");
});

test("in a package of a monorepo, init writes the agent rules and skills once at the repository top", async () => {
  const top = mkdtempSync(join(tmpdir(), "intersite-init-pkg-"));
  execFileSync("git", ["init", "-q"], { cwd: top });
  for (const pkg of ["apps/api", "apps/web"]) mkdirSync(join(top, pkg), { recursive: true });
  assert.match(await run(join(top, "apps/api")), /wrote intersite\.yml, \.intersite\/adapter\.mjs, \.\.\/\.\.\/AGENTS\.md, \.\.\/\.\.\/\.claude\/skills\/intersite\/SKILL\.md/);
  assert.doesNotMatch(await run(join(top, "apps/web")), /AGENTS|skills/);
  assert.equal(existsSync(join(top, "apps/api/AGENTS.md")) || existsSync(join(top, "apps/web/.claude")), false);
  assert.match(readFileSync(join(top, ".claude/skills/intersite/SKILL.md"), "utf8"), /^---\nname: intersite\n/);
  assert.equal(readFileSync(join(top, "AGENTS.md"), "utf8").split("<!-- intersite:start -->").length, 2);
});

test("init adds the edit hook to the project's Claude settings once, keeping the hooks already there", async () => {
  const top = mkdtempSync(join(tmpdir(), "intersite-init-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: top });
  mkdirSync(join(top, ".claude"));
  const own = { matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] };
  writeFileSync(join(top, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [own] } }));
  assert.match(await run(top), /\.claude\/settings\.json/);
  const settings = JSON.parse(readFileSync(join(top, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.deepEqual(settings.hooks.PreToolUse, [own, { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "npx intersite hook" }] }]);
  assert.doesNotMatch(await run(top), /settings/);
  assert.equal(JSON.parse(readFileSync(join(top, ".claude/settings.json"), "utf8")).hooks.PreToolUse.length, 2);
});

test("init takes no arguments: an unknown flag is a usage error, not silently ignored", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-flag-"));
  /** @type {string[]} */
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    assert.equal(await init(["--force"], { cwd }), 2);
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, ["intersite init: unexpected --force; usage: intersite init [--no-replay]"]);
  assert.equal(existsSync(join(cwd, "intersite.yml")), false);
});

test("with oxlint installed, init records the baseline and still prints one line", async () => {
  const cwd = fixture({ "package.json": { name: "linted" }, "src/a.ts": "try { run(); } catch {}\n" });
  assert.match(await run(cwd), /^ok init: wrote intersite\.yml, .*, \.intersite\/baseline\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".intersite/baseline.json"), "utf8")).lint, { "src/a.ts": { "intersite/no-empty-catch": 1 } });
});

test("a broken intersite.yml is one line naming the file and the problem", () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-broken-"));
  writeFileSync(join(cwd, "intersite.yml"), "project: x\ngates:\n  run: [a\n  bad: : :\n");
  assert.throws(() => loadConfig(cwd), (error) => error instanceof Error && /^intersite\.yml: [^\n]+$/.test(error.message));
  writeFileSync(join(cwd, "intersite.yml"), "project: x\ngates: main\n");
  assert.throws(() => loadConfig(cwd), { message: 'intersite.yml: "gates" must be a mapping, such as `gates:` followed by indented settings' });
  writeFileSync(join(cwd, "intersite.yml"), "");
  assert.equal(loadConfig(cwd).project, basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
});

// Runs the real SwiftLint (brew install swiftlint), as test/lint/swift.test.mjs does.
test("in a Swift-only project init records the baseline through SwiftLint and does not ask for oxlint", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-swift-"));
  mkdirSync(join(cwd, "App"));
  writeFileSync(join(cwd, "App/Settings.swift"), "import SwiftUI\n\nlet decoded = try! JSONDecoder().decode(Int.self, from: Data())\n");
  assert.match(await run(cwd), /^ok init: wrote .*, \.intersite\/baseline\.json$/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, ".intersite/baseline.json"), "utf8")).lint), ["App/Settings.swift"]);
});

test("init --no-replay writes replay: false and neither the adapter nor the replay skill", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-init-noreplay-"));
  assert.equal(await init(["--no-replay"], { cwd }), 0);
  assert.equal(loadConfig(cwd).replay.enabled, false);
  assert.ok(!existsSync(join(cwd, ".intersite/adapter.mjs")));
  assert.ok(!existsSync(join(cwd, ".claude/skills/intersite-bug/SKILL.md")));
  assert.ok(existsSync(join(cwd, ".claude/skills/intersite-rule/SKILL.md")));
});
