// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import init from "../../cli/init.mjs";
import { loadConfig } from "../../shared/config.mjs";

/** Runs init in `cwd` and returns what it printed. @param {string} cwd */
async function run(cwd) {
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
    "ok init: wrote intersite.yml, intersite.adapter.mjs, AGENTS.md, .claude/skills/intersite/SKILL.md, .claude/skills/intersite-bug/SKILL.md, " +
      ".claude/skills/intersite-rule/SKILL.md, .claude/skills/intersite-setup/SKILL.md, .gitignore; install oxlint and @oxlint/plugins, then run `intersite lint --write=init`",
  );
  assert.match(readFileSync(join(cwd, ".claude/skills/intersite/SKILL.md"), "utf8"), /^---\nname: intersite\n/);
  assert.equal(loadConfig(cwd).project, "acme-web-app");
  assert.match(readFileSync(join(cwd, "intersite.adapter.mjs"), "utf8"), /export async function signIn/);
  assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "node_modules/\n.intersite/\n");
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

  assert.match(await run(cwd), /^ok init: wrote intersite\.adapter\.mjs, AGENTS\.md, \.claude\/skills\/intersite\/SKILL\.md, /);
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
  assert.deepEqual(config.gates.run, ["test-integrity", "duplicates", "new-deps", "artifacts", "unused"]);
  assert.equal(config.collector.url, "http://127.0.0.1:8790");
});
