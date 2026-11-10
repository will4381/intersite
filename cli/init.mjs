// @ts-check
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILE, configPath, loadConfig, projectName } from "../shared/config.mjs";

const START = "<!-- intersite:start -->";
const END = "<!-- intersite:end -->";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** @param {string} path */
const packaged = (path) => readFileSync(join(packageRoot, path), "utf8");

/**
 * `intersite init`: the one setup step. Writes the config, the replay adapter, the agent rules and skills, and
 * records today's lint findings so only new ones fail. It never overwrites the project's own edits; a second run
 * only refreshes what the package owns (the skills and the marked block in AGENTS.md).
 * @param {string[]} _argv @param {{ cwd: string }} context
 */
export default async function init(_argv, { cwd }) {
  /** @type {string[]} */
  const wrote = [];
  /** Writes when the content differs; `keep` leaves an existing file alone. @param {string} name @param {string} text @param {boolean} [keep] */
  const write = (name, text, keep = false) => {
    const path = join(cwd, name);
    if (existsSync(path) && (keep || readFileSync(path, "utf8") === text)) return;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    wrote.push(name);
  };

  const fresh = !configPath(cwd);
  if (fresh) write(CONFIG_FILE, packaged("templates/intersite.yml").replace("PROJECT", projectName(cwd)));
  write("intersite.adapter.mjs", packaged("templates/adapter.mjs"), true);

  const block = `${START}\n${packaged("templates/agents.md").trimEnd()}\n${END}`;
  const agents = existsSync(join(cwd, "AGENTS.md")) ? readFileSync(join(cwd, "AGENTS.md"), "utf8") : "";
  const from = agents.indexOf(START);
  const to = agents.indexOf(END);
  write("AGENTS.md", from >= 0 && to > from
    ? agents.slice(0, from) + block + agents.slice(to + END.length)
    : `${agents.trimEnd()}${agents.trim() ? "\n\n" : ""}${block}\n`);

  for (const skill of readdirSync(join(packageRoot, "skills"))) {
    write(`.claude/skills/${skill}/SKILL.md`, packaged(`skills/${skill}/SKILL.md`));
  }

  if (existsSync(join(cwd, ".gitignore"))) {
    const ignore = readFileSync(join(cwd, ".gitignore"), "utf8");
    if (!/^\.intersite\/?$/m.test(ignore)) write(".gitignore", `${ignore}${ignore.endsWith("\n") ? "" : "\n"}.intersite/\n`);
  }

  // Start green: findings that already exist go in the baseline, so only new ones fail from here on.
  let baseline = "";
  if (fresh && !existsSync(join(cwd, loadConfig(cwd).lint.baseline))) {
    if (existsSync(join(cwd, "node_modules/.bin/oxlint"))) {
      const { default: lint } = await import("./lint.mjs");
      await lint(["--write=init"], { cwd });
    } else {
      baseline = "; install oxlint and @oxlint/plugins, then run `intersite lint --write=init`";
    }
  }

  console.log(wrote.length > 0 ? `ok init: wrote ${wrote.join(", ")}${baseline}` : "ok init: already set up");
  return 0;
}
