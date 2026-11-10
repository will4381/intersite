#!/usr/bin/env node
// @ts-check
const commands = ["init", "check", "lint", "gate", "replay", "actions", "pin", "collector", "deploy"];
const readsCases = ["check", "replay", "actions", "pin"];
const [command, ...argv] = process.argv.slice(2);

if (!command || !commands.includes(command)) {
  console.error(`usage: intersite <${commands.join("|")}> [options]`);
  process.exit(2);
}

const cwd = process.cwd();
const stopCollector = readsCases.includes(command) ? await (await import("../cli/local.mjs")).ensureLocalCollector(cwd) : undefined;
/** Each command module default-exports `async (argv, { cwd }) => exitCode`. */
const { default: run } = await import(`../cli/${command}.mjs`);
const code = await run(argv, { cwd });
await stopCollector?.();
process.exit(code);
