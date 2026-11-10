// @ts-check
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { inGit } from "../gates/lib.mjs";
import { answers } from "../replay/run.mjs";
import { loadConfig } from "../shared/config.mjs";

/** Whether a collector answers at this URL. @param {string} url */
function reachable(url) {
  return fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok, () => false);
}

/**
 * `intersite check [--base <ref>] [--skip <stage>]...`: every check that applies to this project, in order of cost.
 * Each stage prints its own findings; this adds one line saying which stages failed. All stages run even after a
 * failure, so one run shows everything there is to fix.
 * @param {string[]} argv @param {{ cwd: string }} context
 */
export default async function check(argv, { cwd }) {
  let config;
  /** @type {{ base?: string, skip?: string[] }} */
  let flags;
  try {
    flags = parseArgs({ args: argv, options: { base: { type: "string" }, skip: { type: "string", multiple: true } } }).values;
  } catch (error) {
    console.error(`check: ${/** @type {Error} */ (error).message}; usage: intersite check [--base <ref>] [--skip <stage>]...`);
    return 2;
  }
  try {
    config = loadConfig(cwd);
  } catch (error) {
    console.error(`check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const skip = new Set(flags.skip ?? []);
  const base = flags.base ? ["--base", flags.base] : [];

  const git = inGit(cwd);
  if (!git) console.log("skip gates: not a git repository (run `git init` to check changes)");
  /** @type {{ name: string, command: string, argv: string[] }[]} */
  const stages = [
    { name: "lint", command: "lint", argv: [] },
    ...(git ? config.gates.run : []).map((/** @type {string} */ gate) => ({ name: gate, command: "gate", argv: [gate, ...base] })),
  ];
  if (!skip.has("replay")) {
    if (!existsSync(resolve(cwd, config.replay.adapter))) console.log(`skip replay: no adapter at ${config.replay.adapter}`);
    else if (!(await reachable(config.collector.url))) console.log(`skip replay: no collector at ${config.collector.url} (start one with \`intersite collector\`)`);
    else if (!(await answers(config.replay.target))) console.log(`skip replay: nothing answers at ${config.replay.target} (start the server to replay recorded sessions)`);
    else stages.push({ name: "replay", command: "replay", argv: [] });
  }

  /** @type {string[]} */
  const failed = [];
  let worst = 0;
  /** @param {typeof stages[number]} stage */
  const runStage = async (stage) => {
    const { default: run } = await import(`./${stage.command}.mjs`);
    // Each stage prints only its findings; this command's own line is the one success line.
    const code = await run(stage.argv, { cwd, quiet: true });
    if (code !== 0) failed.push(stage.name);
    worst = Math.max(worst, code);
  };
  const [lint, ...rest] = stages.filter((stage) => !skip.has(stage.name));
  // Lint waits on oxlint in another process, so the gates run meanwhile; its line prints when it finishes.
  const linting = lint ? runStage(lint) : undefined;
  for (const stage of rest) await runStage(stage);
  await linting;
  const ran = stages.filter((stage) => !skip.has(stage.name)).map((stage) => stage.name);
  console.log(failed.length > 0 ? `FAIL check: ${failed.join(", ")}` : `ok check: ${ran.join(", ") || "no stages ran"}`);
  return worst;
}
