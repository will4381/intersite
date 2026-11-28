// @ts-check
// A worker thread of `intersite check`: runs the gates it is sent one at a time and answers with what each printed and
// found. Several run side by side, each gate's time being mostly git and the engine in other processes. The working
// tree does not change during a check, so each worker remembers what git answered for the gates after the first.
import { parentPort } from "node:worker_threads";

import { quietExperimentalWarnings, rememberGit } from "../gates/lib.mjs";
import gate from "./gate.mjs";

quietExperimentalWarnings();
rememberGit();
parentPort?.on("message", async (/** @type {{ argv: string[], cwd: string, silent: boolean }} */ { argv, cwd, silent }) => {
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  console.log = (line) => out.push(String(line));
  console.error = (line) => err.push(String(line));
  /** @type {{ findings: unknown[], accepted: unknown[], suggestions: unknown[] }} */
  let found = { findings: [], accepted: [], suggestions: [] };
  let code;
  try {
    code = await gate(argv, { cwd, quiet: true, silent, collect: (result) => (found = result) });
  } catch (error) {
    // The same one line and exit 2 the CLI gives an unexpected error.
    err.push(`gate ${argv[0]}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    code = 2;
  }
  parentPort?.postMessage({ code, out, err, ...found });
});
