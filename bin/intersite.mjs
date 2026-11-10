#!/usr/bin/env node
// @ts-check
import { relative, resolve } from "node:path";

import { projectRoot } from "../shared/config.mjs";

const commands = ["init", "check", "lint", "gate", "replay", "actions", "audit", "pin", "collector", "deploy"];
const readsCases = ["check", "replay", "actions", "audit", "pin"];
const [command, ...argv] = process.argv.slice(2);

if (!command || !commands.includes(command)) {
  console.error(`usage: intersite <${commands.join("|")}> [options]`);
  process.exit(2);
}

// Every command but init runs where the project's intersite.yml is, so lint paths given from a subfolder are rebased.
const cwd = command === "init" ? process.cwd() : projectRoot(process.cwd());
const args = command === "lint" ? argv.map((arg) => (arg.startsWith("-") ? arg : relative(cwd, resolve(arg)) || ".")) : argv;
/** @type {(() => Promise<void>) | undefined} */
let stopCollector;
let code = 2;
try {
  stopCollector = readsCases.includes(command) ? await (await import("../cli/local.mjs")).ensureLocalCollector(cwd) : undefined;
  /** Each command module default-exports `async (argv, { cwd }) => exitCode`. */
  const { default: run } = await import(`../cli/${command}.mjs`);
  code = await run(args, { cwd });
} catch (error) {
  // Commands report what they expect on one line; anything else still gets one line, and the stack only on request.
  const message = error instanceof Error ? error.message : String(error);
  // A system error (EACCES, ENOSPC) is about this machine, not a bug, so it needs no stack trace.
  const hint = /** @type {NodeJS.ErrnoException} */ (error)?.syscall ? "" : " (set INTERSITE_DEBUG=1 for the stack trace)";
  console.error(process.env.INTERSITE_DEBUG ? error : `intersite ${command}: ${message.split("\n")[0]}${hint}`);
} finally {
  await stopCollector?.();
}
process.exit(code);
