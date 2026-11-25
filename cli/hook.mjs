// @ts-check
// `intersite hook`: a Claude Code PreToolUse hook for Edit, Write and MultiEdit. It reads the proposed edit on stdin,
// builds the file as it would be after it, and blocks (exit 2, the reason on stderr for the model) an edit that weakens
// an evaluator (core/tamper.rs) or takes tests, assertions or skips the wrong way in a test file. Anything else, an
// internal error included, exits 0 without a word: a hook must never wedge the agent.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { loadConfig, projectRoot } from "../shared/config.mjs";
import { runCore } from "../gates/core.mjs";
import { matches } from "../gates/lib.mjs";
import { EVALUATOR, PRAGMA, TAMPER_CONTEXT } from "../gates/tamper.mjs";

/**
 * The file's text after the tool call, or undefined when the call would fail anyway (an old string not found).
 * @param {string} before @param {string} tool @param {any} input
 */
function after(before, tool, input) {
  if (tool === "Write") return typeof input.content === "string" ? input.content : undefined;
  const edits = tool === "MultiEdit" ? input.edits : tool === "Edit" ? [input] : undefined;
  if (!Array.isArray(edits)) return undefined;
  let text = before;
  for (const { old_string: from, new_string: to, replace_all: all } of edits) {
    if (typeof from !== "string" || typeof to !== "string" || !text.includes(from)) return undefined;
    // Split and join, not String#replace, so a `$&` in the new text stays literal.
    text = all ? text.split(from).join(to) : text.slice(0, text.indexOf(from)) + to + text.slice(text.indexOf(from) + from.length);
  }
  return text;
}

/** @param {string[]} _argv @param {{ cwd: string }} _context */
export default async function hook(_argv, _context) {
  try {
    const { tool_name: tool, tool_input: input } = JSON.parse(readFileSync(0, "utf8"));
    const file = input?.file_path;
    if (typeof file !== "string" || !["Edit", "Write", "MultiEdit"].includes(tool)) return 0;
    const root = projectRoot(dirname(file));
    const path = relative(root, file);
    const config = loadConfig(root);
    const context = TAMPER_CONTEXT;
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const now = after(before, tool, input);
    if (now === undefined) return 0;
    const test = matches(path, config.gates.testPaths);
    if (!test && !EVALUATOR.test(path) && !context.baselines.includes(path) && !PRAGMA.test(now)) return 0;
    const { findings } = runCore({ command: "hook", root, options: { path, before, now, test, context } }, { build: false });
    const open = findings.filter((f) => !config.gates.acknowledged.some((a) => `${a.gate}:${a.target}` === f.target));
    if (!open.length) return 0;
    const [gate] = open[0].target.split(":");
    const target = open[0].target.slice(gate.length + 1);
    const what = open.map((f) => f.message).join("; ");
    const instead = gate === "tamper" ? "Fix the code so the check passes instead of loosening the check" : "Fix the code so the tests pass instead of removing or skipping tests";
    console.error(`intersite: blocked this edit to ${path}: ${what}. ${instead}. If this change really is right (an obsolete test, a deliberate config change), stop and tell the user why: they can make the edit themselves, or acknowledge it in intersite.yml under gates.acknowledged with { gate: "${gate}", target: "${target}", why: "…" }.`);
    return 2;
  } catch {
    // A hook that fails must not block the agent's edit: the gates still judge the change in `check`.
    return 0;
  }
}
