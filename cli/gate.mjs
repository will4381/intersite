// @ts-check
// intersite gate fails-on-base --base <ref> --cmd "<test command>" [--paths <glob>]... [--setup "<command>"]
import { parseArgs } from "node:util";

import { defaultPaths, failsOnBase } from "../gates/fails-on-base.mjs";

const usage = 'usage: intersite gate fails-on-base --base <ref> --cmd "<test command>" [--paths <glob>]... [--setup "<command>"]';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} options
 */
export default async function gate(argv, { cwd }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { base: { type: "string" }, cmd: { type: "string" }, paths: { type: "string", multiple: true }, setup: { type: "string" } },
    });
  } catch (error) {
    console.error(`${/** @type {Error} */ (error).message}\n${usage}`);
    return 2;
  }
  const { positionals, values } = parsed;
  if (positionals[0] !== "fails-on-base" || !values.base || !values.cmd) {
    console.error(usage);
    return 2;
  }
  const { code, message } = failsOnBase({ cwd, base: values.base, cmd: values.cmd, paths: values.paths ?? defaultPaths, setup: values.setup });
  (code === 0 ? console.log : console.error)(message);
  return code;
}
