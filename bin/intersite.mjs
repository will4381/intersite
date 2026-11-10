#!/usr/bin/env node
// @ts-check
const commands = ["lint", "replay", "gate", "deploy"];
const [command, ...argv] = process.argv.slice(2);

if (!command || !commands.includes(command)) {
  console.error(`usage: intersite <${commands.join("|")}> [options]`);
  process.exit(2);
}

/** Each command module default-exports `async (argv, { cwd }) => exitCode`. */
const { default: run } = await import(`../cli/${command}.mjs`);
process.exit(await run(argv, { cwd: process.cwd() }));
