// @ts-check
// The skills this repository's own agents read (.claude/skills, as `intersite init` writes them) are the packaged ones.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("each .claude/skills copy matches the packaged skill", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = (/** @type {string} */ path) => readFileSync(`${root}${path}`, "utf8");
  const stale = readdirSync(`${root}skills`).filter((skill) => read(`.claude/skills/${skill}/SKILL.md`) !== read(`skills/${skill}/SKILL.md`));
  assert.deepEqual(stale, [], "copy each stale skills/<name>/SKILL.md over .claude/skills/<name>/SKILL.md");
});
