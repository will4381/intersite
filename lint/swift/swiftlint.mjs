// @ts-check
// The `swift` pack: rules from lint/swift/rules.yml, run by SwiftLint because oxlint cannot read Swift.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

/**
 * A Swift rule: a SwiftLint built-in (`swiftlint` plus its `config`) or a `regex` custom rule. `kinds` limits a regex
 * to tokens of these SourceKit kinds, `skipKinds` drops a match touching any of them, and `files`/`skipFiles` are
 * regular expressions SwiftLint searches in the absolute file path.
 * @typedef {{ id: string, message: string, swiftlint?: string, config?: object, regex?: string, kinds?: string[], skipKinds?: string[], files?: string, skipFiles?: string, bad: string[], good: string[] }} SwiftRule
 */

/** @type {SwiftRule[]} */
export const swiftRules = parse(readFileSync(new URL("./rules.yml", import.meta.url), "utf8")).rules;

const exec = promisify(execFile);
/** Folders that hold dependencies, build output or tool state, never the project's own Swift. */
const skipDirs = new Set(["node_modules", "build", "Pods", "Carthage", "DerivedData", "SourcePackages"]);

/**
 * The Swift files under the given paths, relative to cwd, skipping dot folders and dependency and build folders.
 * @param {string} cwd
 * @param {string[]} paths
 */
export function swiftFiles(cwd, paths) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} path relative to cwd */
  const walk = (path) => {
    const full = join(cwd, path);
    if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
      if (path.endsWith(".swift")) found.push(path);
      return;
    }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const skip = entry.isDirectory() && (entry.name.startsWith(".") || skipDirs.has(entry.name));
      if (!skip) walk(path === "." ? entry.name : join(path, entry.name));
    }
  };
  for (const p of paths.length ? paths : ["."]) walk(p.replace(/\/$/, "") || ".");
  return found;
}

/**
 * The SwiftLint config that runs exactly these rules. JSON is valid YAML, so it is written as JSON. The project's own
 * .swiftlint.yml is not read: an explicit --config makes SwiftLint ignore it, so every finding is one of these rules.
 * @param {SwiftRule[]} rules
 */
export function swiftlintConfig(rules) {
  const builtin = rules.filter((r) => r.swiftlint);
  const custom = rules.filter((r) => r.regex);
  return {
    only_rules: [...builtin.map((r) => r.swiftlint), ...(custom.length ? ["custom_rules"] : [])],
    ...Object.fromEntries(builtin.filter((r) => r.config).map((r) => [r.swiftlint, r.config])),
    custom_rules: Object.fromEntries(
      custom.map((r) => [
        r.id,
        {
          regex: r.regex,
          message: r.message,
          severity: "error",
          ...(r.kinds && { match_kinds: r.kinds }),
          ...(r.skipKinds && { excluded_match_kinds: r.skipKinds }),
          ...(r.files && { included: r.files }),
          ...(r.skipFiles && { excluded: r.skipFiles }),
        },
      ]),
    ),
  };
}

/**
 * Runs SwiftLint over the files with these rules and returns its findings as `swift/<id>` with Intersite's messages.
 * Returns undefined when swiftlint is not on PATH; throws with SwiftLint's own output when it fails.
 * @param {string} cwd
 * @param {string[]} files relative to cwd
 * @param {SwiftRule[]} rules
 * @param {string} cacheDir where the config and SwiftLint's cache go
 */
export async function runSwiftlint(cwd, files, rules, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const configFile = join(cacheDir, "swiftlint.yml");
  writeFileSync(configFile, JSON.stringify(swiftlintConfig(rules)));
  const byName = new Map(rules.map((r) => [r.swiftlint ?? r.id, r]));
  const root = realpathSync(cwd);
  /** @type {{ file: string, line: number, column: number, rule: string, message: string }[]} */
  const findings = [];
  // Batches keep the command line under the OS limit on big projects.
  for (let i = 0; i < files.length; i += 500) {
    const args = ["lint", "--quiet", "--reporter", "json", "--config", configFile, "--cache-path", join(cacheDir, "swiftlint-cache"), ...files.slice(i, i + 500)];
    // SwiftLint exits 2 when it finds an error-level violation, so its exit code is not a failure by itself.
    const run = await exec("swiftlint", args, { cwd, maxBuffer: Infinity }).catch((/** @type {any} */ e) => e);
    if (run.code === "ENOENT") return undefined;
    /** @type {{ file: string, line: number, character: number | null, rule_id: string, reason: string }[]} */
    let violations;
    try {
      violations = JSON.parse(run.stdout);
    } catch {
      throw new Error(`swiftlint did not print JSON (exit ${run.code})\n${run.stderr}${run.stdout}`);
    }
    for (const v of violations) {
      const rule = byName.get(v.rule_id);
      const file = relative(root, v.file);
      findings.push({ file, line: v.line, column: v.character ?? 1, rule: `swift/${rule?.id ?? v.rule_id}`, message: rule?.message ?? v.reason });
    }
  }
  return findings;
}
