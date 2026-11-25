// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BASELINE, CONFIG_FILE, DIR_GITIGNORE, INTERSITE_DIR, OLD_ADAPTER, OLD_BASELINES, configPath, intersiteDir, loadConfig, projectName, readBaselines, writeBaseline } from "../shared/config.mjs";

const START = "<!-- intersite:start -->";
const END = "<!-- intersite:end -->";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** @param {string} path */
const packaged = (path) => readFileSync(join(packageRoot, path), "utf8");

/**
 * `intersite init`: the one setup step. Writes the config, the replay adapter, the agent rules and skills, and
 * records today's lint findings so only new ones fail. It never overwrites the project's own edits; a second run
 * only refreshes what the package owns (the skills and the marked block in AGENTS.md).
 * @param {string[]} argv @param {{ cwd: string }} context
 */
export default async function init(argv, { cwd }) {
  const noReplay = argv[0] === "--no-replay";
  if (argv.length > (noReplay ? 1 : 0)) {
    console.error(`intersite init: unexpected ${argv[noReplay ? 1 : 0]}; usage: intersite init [--no-replay]`);
    return 2;
  }
  /** @type {string[]} */
  const wrote = [];
  /** Writes when the content differs; `keep` leaves an existing file alone. @param {string} name @param {string} text @param {boolean} [keep] */
  const write = (name, text, keep = false, dir = cwd) => {
    const path = join(dir, name);
    if (existsSync(path) && (keep || readFileSync(path, "utf8") === text)) return;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    wrote.push(relative(cwd, path));
  };
  // The agent rules and skills belong to the repository, not each package: agents read them from the top, and a
  // monorepo with a config per package would otherwise get a copy of each in every package.
  // `--show-cdup` is relative, so it keeps cwd's own spelling where a symlink would make `--show-toplevel` differ.
  const top = join(cwd, spawnSync("git", ["rev-parse", "--show-cdup"], { cwd, encoding: "utf8" }).stdout?.trim() ?? "");

  const fresh = !configPath(cwd);
  if (fresh) {
    const template = packaged("templates/intersite.yml").replace("PROJECT", projectName(cwd));
    write(CONFIG_FILE, noReplay ? `${template.slice(0, template.indexOf("# replay:"))}# Lint and gates only: no replay stage, adapter or replay skill.\nreplay: false\n` : template);
  }
  moveOldFiles(cwd, wrote);
  const { replay } = loadConfig(cwd);
  if (replay.enabled) write(replay.adapter, packaged("templates/adapter.mjs"), true);

  writeAgentRules(write, top, replay.enabled);
  installHook(write, top);
  ignoreGenerated(write, cwd);
  const baseline = fresh ? await recordBaseline(cwd, wrote) : "";
  // A .gitignore above that ignores the whole folder (as older versions wrote) would keep the baseline out of git.
  const hidden = spawnSync("git", ["check-ignore", "-q", BASELINE], { cwd }).status === 0
    ? `; a .gitignore ignores ${INTERSITE_DIR}/ as a whole, which keeps ${BASELINE} out of git: remove that line`
    : "";

  console.log(wrote.length > 0 ? `ok init: wrote ${wrote.join(", ")}${baseline}${hidden}` : `ok init: already set up${hidden}`);
  return 0;
}

/** @typedef {(name: string, text: string, keep?: boolean, dir?: string) => void} Write */

/**
 * The marked block in AGENTS.md and the skills, both the package's to refresh.
 * @param {Write} write @param {string} top @param {boolean} replays
 */
function writeAgentRules(write, top, replays) {
  const block = `${START}\n${packaged("templates/agents.md").trimEnd()}\n${END}`;
  const agents = existsSync(join(top, "AGENTS.md")) ? readFileSync(join(top, "AGENTS.md"), "utf8") : "";
  const from = agents.indexOf(START);
  const to = agents.indexOf(END);
  write("AGENTS.md", from >= 0 && to > from
    ? agents.slice(0, from) + block + agents.slice(to + END.length)
    : `${agents.trimEnd()}${agents.trim() ? "\n\n" : ""}${block}\n`, false, top);

  for (const skill of readdirSync(join(packageRoot, "skills"))) {
    // intersite-bug reproduces a bug from a recorded request, which a project without replay never has.
    if (!replays && skill === "intersite-bug") continue;
    write(`.claude/skills/${skill}/SKILL.md`, packaged(`skills/${skill}/SKILL.md`), false, top);
  }
}

/**
 * The edit hook: Claude Code runs it before every Edit or Write, and it blocks one that weakens a check or a test
 * before it lands. Merged into the project's settings, keeping its own hooks; an unreadable file is left alone.
 * @param {Write} write @param {string} top
 */
function installHook(write, top) {
  const settingsFile = join(top, ".claude", "settings.json");
  let settings;
  try {
    settings = JSON.parse(existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "{}");
  } catch {
    return;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
  const pre = ((settings.hooks ??= {}).PreToolUse ??= []);
  if (!Array.isArray(pre)) return;
  const installed = pre.some((/** @type {any} */ entry) => entry?.hooks?.some?.((/** @type {any} */ h) => /\bintersite(?:\.mjs)?\s+hook\b/.test(h?.command ?? "")));
  if (installed) return;
  pre.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "npx intersite hook" }] });
  write(".claude/settings.json", `${JSON.stringify(settings, null, 2)}\n`, false, top);
}

/**
 * `.intersite` keeps its generated files out of git with its own .gitignore, committing only the baseline and the
 * adapter. Versions before 1.0.0-rc.24 ignored the whole folder in the project's .gitignore, which would hide those
 * two, so that line comes out.
 * @param {Write} write @param {string} cwd
 */
function ignoreGenerated(write, cwd) {
  write(`${INTERSITE_DIR}/.gitignore`, DIR_GITIGNORE, true);
  const file = join(cwd, ".gitignore");
  const ignore = existsSync(file) ? readFileSync(file, "utf8") : "";
  const kept = ignore.split("\n").filter((line) => !/^\/?\.intersite\/?$/.test(line.trim())).join("\n");
  if (kept !== ignore) write(".gitignore", kept);
}

/**
 * Moves what versions before 1.0.0-rc.24 wrote beside intersite.yml into `.intersite`: the two baselines, now one
 * file, and the replay adapter, unless intersite.yml names that path itself.
 * @param {string} cwd @param {string[]} moved
 */
function moveOldFiles(cwd, moved) {
  const old = Object.values(OLD_BASELINES).filter((file) => existsSync(join(cwd, file)));
  if (old.length) {
    const { lint, gates } = readBaselines(cwd);
    if (lint) writeBaseline(cwd, "lint", lint);
    if (gates) writeBaseline(cwd, "gates", gates);
    moved.push(`${BASELINE} (from ${old.join(", ")})`);
  }
  const named = configPath(cwd) && /^\s+adapter:/m.test(readFileSync(/** @type {string} */ (configPath(cwd)), "utf8"));
  if (existsSync(join(cwd, OLD_ADAPTER)) && !named) {
    intersiteDir(cwd);
    renameSync(join(cwd, OLD_ADAPTER), join(cwd, INTERSITE_DIR, "adapter.mjs"));
    moved.push(`${INTERSITE_DIR}/adapter.mjs (from ${OLD_ADAPTER})`);
  }
}

/**
 * Start green: findings that already exist go in the baseline, so only new ones fail from here on. Adds the baseline
 * to `wrote`, or returns what to do when none could be recorded.
 * @param {string} cwd @param {string[]} wrote
 */
async function recordBaseline(cwd, wrote) {
  if (readBaselines(cwd).lint) return "";
  const { default: lint, findOxlint } = await import("./lint.mjs");
  const { swiftFiles } = await import("../lint/swift/swiftlint.mjs");
  // A Swift-only project needs no oxlint: its lint runs through SwiftLint.
  if (!findOxlint(cwd) && !swiftFiles(cwd, []).length) return "; install oxlint and @oxlint/plugins, then run `intersite lint --write=init`";
  if ((await lint(["--write=init"], { cwd, quiet: true })) !== 0) return "; no lint baseline recorded: fix the lint error above, then run `intersite lint --write=init`";
  wrote.push(BASELINE);
  return "";
}
