// @ts-check
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import lint from "../../cli/lint.mjs";

const oxlint = fileURLToPath(new URL("../../node_modules/.bin/oxlint", import.meta.url));

/**
 * A temp project with this repo's oxlint linked in and the given files written.
 * @param {Record<string, string | object>} files
 */
export function fixture(files) {
  const cwd = mkdtempSync(join(tmpdir(), "intersite-lint-"));
  mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
  symlinkSync(oxlint, join(cwd, "node_modules/.bin/oxlint"));
  for (const [name, content] of Object.entries(files)) write(cwd, name, content);
  return cwd;
}

/** @param {string} cwd @param {string} name @param {string | object} content */
export function write(cwd, name, content) {
  mkdirSync(dirname(join(cwd, name)), { recursive: true });
  writeFileSync(join(cwd, name), typeof content === "string" ? content : JSON.stringify(content));
}

/**
 * Runs `intersite lint` in cwd and captures what it prints.
 * @param {string} cwd
 * @param {string[]} [argv]
 */
export async function runLint(cwd, argv = []) {
  const lines = [];
  const { log, error } = console;
  console.log = console.error = (/** @type {string} */ line) => lines.push(line);
  try {
    const code = await lint(argv, { cwd });
    return { code, out: lines.join("\n") };
  } finally {
    Object.assign(console, { log, error });
  }
}
