// @ts-check
// The `swift` pack: rules from lint/swift/rules.yml, run by SwiftLint because oxlint cannot read Swift, plus the
// checks in checks.mjs for what SwiftLint cannot express.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

import { checks, project, regions, scan } from "./checks.mjs";

/**
 * A Swift rule: a SwiftLint built-in (`swiftlint` plus its `config`), a `regex` custom rule, or a `check` from
 * checks.mjs (with its `config`). `skipKinds` drops a regex match touching these SourceKit token kinds; `files` and
 * `skipFiles` are regular expressions searched in the file's path relative to the project; `skipIn` names the regions
 * (preview, debug, cli) where the rule does not apply.
 * @typedef {{ id: string, message: string, swiftlint?: string, check?: string, config?: any, regex?: string, skipKinds?: string[], files?: string, skipFiles?: string, skipIn?: string[], bad: string[], good: string[] }} SwiftRule
 */
/** @typedef {{ file: string, line: number, column: number, rule: string, message: string }} SwiftFinding */

/** @type {SwiftRule[]} */
export const swiftRules = parse(readFileSync(new URL("./rules.yml", import.meta.url), "utf8")).rules;

const exec = promisify(execFile);
/** Folders that hold dependencies, build output or tool state, never the project's own Swift. */
const skipDirs = new Set(["node_modules", "build", "Pods", "Carthage", "DerivedData", "SourcePackages"]);
/** @param {string} path */
const wanted = (path) => path.endsWith(".swift") && !path.split("/").some((part) => part.startsWith(".") || skipDirs.has(part));

/**
 * The Swift files under the given paths, relative to cwd, skipping dot folders, dependency and build folders, and (in
 * a git work tree) what .gitignore ignores. Symlinked folders are not followed. Paths are NFC, so a baseline key does
 * not depend on how git or the file system spelled an accented name.
 * @param {string} cwd
 * @param {string[]} paths
 */
export function swiftFiles(cwd, paths) {
  const roots = (paths.length ? paths : ["."]).map((p) => normalize(p).replace(/\/$/, ""));
  /** @param {string} p */
  const isFile = (p) => statSync(join(cwd, p), { throwIfNoEntry: false })?.isFile();
  /** @type {string[] | undefined} */
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: Infinity })
      .normalize("NFC").split("\0").filter((p) => p && !p.startsWith("../"));
  } catch {
    // Not a git work tree (or no git): walk the folders instead.
  }
  if (listed) {
    // git lists a repository nested inside this one (not a submodule) as a folder: lint it with its own .gitignore.
    const nested = listed.filter((p) => p.endsWith("/") && wanted(`${p}x.swift`)).flatMap((dir) => swiftFiles(join(cwd, dir), []).map((p) => join(dir, p)));
    return [...new Set([...listed.filter((p) => wanted(p) && isFile(p)), ...nested])];
  }
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir relative to cwd */
  const walk = (dir) => {
    for (const entry of readdirSync(join(cwd, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && !skipDirs.has(entry.name)) walk(path);
      else if (!entry.isDirectory() && entry.name.endsWith(".swift")) found.push(path);
    }
  };
  for (const root of roots) {
    if (statSync(join(cwd, root), { throwIfNoEntry: false })?.isDirectory()) walk(root);
    else if (root.endsWith(".swift")) found.push(root);
  }
  return found.filter(isFile).map((p) => p.normalize("NFC"));
}

/**
 * The SwiftLint config that runs exactly these rules (the `check` rules run in checks.mjs). JSON is valid YAML, so it
 * is written as JSON. The project's own .swiftlint.yml is not read: an explicit --config makes SwiftLint ignore it, so
 * every finding is one of these rules.
 * @param {SwiftRule[]} rules
 */
export function swiftlintConfig(rules) {
  const builtin = rules.filter((r) => r.swiftlint);
  const custom = rules.filter((r) => r.regex);
  return {
    only_rules: [...builtin.map((r) => r.swiftlint), ...(custom.length ? ["custom_rules"] : [])],
    ...Object.fromEntries(builtin.filter((r) => r.config).map((r) => [r.swiftlint, r.config])),
    custom_rules: Object.fromEntries(
      custom.map((r) => [r.id, { regex: r.regex, message: r.message, severity: "error", ...(r.skipKinds && { excluded_match_kinds: r.skipKinds }) }]),
    ),
  };
}

/**
 * Runs SwiftLint and the scanner checks over the files and returns their findings as `swift/<id>` with Intersite's
 * messages, sorted by file and line. Returns undefined when swiftlint is not on PATH; throws with SwiftLint's own
 * output when it fails.
 * @param {string} cwd
 * @param {string[]} files relative to cwd
 * @param {SwiftRule[]} rules
 * @param {string} cacheDir where the config and SwiftLint's cache go
 * @returns {Promise<SwiftFinding[] | undefined>}
 */
export async function runSwiftlint(cwd, files, rules, cacheDir) {
  const texts = new Map(files.map((file) => [file, readFileSync(join(cwd, file), "utf8")]));
  files = files.filter((file) => !generated(/** @type {string} */ (texts.get(file))));
  const linted = rules.filter((r) => !r.check);
  const found = linted.length && files.length ? await swiftlint(cwd, files, linted, cacheDir) : [];
  if (!found) return undefined;
  /** @type {Map<string, import("./checks.mjs").Scanned>} */
  const scanned = new Map();
  /** @param {string} file */
  const read = (file) => {
    if (!scanned.has(file)) scanned.set(file, scan(/** @type {string} */ (texts.get(file))));
    return /** @type {import("./checks.mjs").Scanned} */ (scanned.get(file));
  };
  const checked = rules.filter((r) => r.check);
  const info = checked.length ? project(files.map(read)) : project([]);
  for (const r of checked) {
    for (const file of files) {
      const f = read(file);
      const hits = checks[/** @type {string} */ (r.check)](f, info, r.config).filter((hit) => !disabledInline(f, hit.line, r.id));
      found.push(...hits.map((hit) => ({ file, ...hit, rule: r.id, message: r.message })));
    }
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  /** @type {Map<string, Record<string, number[][]>>} */
  const regionsOf = new Map();
  const kept = found.filter((f) => {
    const r = byId.get(f.rule);
    if (!r) return true;
    if ((r.files && !new RegExp(r.files).test(f.file)) || (r.skipFiles && new RegExp(r.skipFiles).test(f.file))) return false;
    if (!r.skipIn) return true;
    if (!regionsOf.has(f.file)) regionsOf.set(f.file, regions(read(f.file)));
    const all = /** @type {Record<string, number[][]>} */ (regionsOf.get(f.file));
    return !r.skipIn.some((name) => all[name].some(([from, to]) => f.line >= from && f.line <= to));
  });
  return kept
    .map((f) => ({ ...f, rule: `swift/${f.rule}` }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));
}

/**
 * Whether a file says in its opening comment that a tool generated it ("Generated by …", "Do not edit", "@generated"):
 * its code is fixed by changing the generator, not the file.
 * @param {string} text
 */
function generated(text) {
  const head = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))+/.exec(text.slice(0, 2000))?.[0] ?? "";
  return /\b(?:generated by|do not edit|@generated|auto-?generated)\b/i.test(head);
}

/**
 * Whether a `check` finding is switched off the way SwiftLint's own are: `// swiftlint:disable:next <id>` on the line
 * before, or `// swiftlint:disable:this <id>` on the line itself.
 * @param {import("./checks.mjs").Scanned} f
 * @param {number} line
 * @param {string} id
 */
function disabledInline(f, line, id) {
  /** @param {number} n */
  const text = (n) => (n < 1 ? "" : f.text.slice(f.starts[n - 1], f.starts[n] ?? f.text.length));
  /** @param {string} mode */
  const names = (mode) => new RegExp(`swiftlint:disable:${mode}\\s[^\\n]*(?<![\\w-])${id}(?![\\w-])`);
  return names("next").test(text(line - 1)) || names("this").test(text(line));
}

/**
 * Runs SwiftLint over the files with the non-`check` rules and returns its findings by rule id.
 * @param {string} cwd
 * @param {string[]} files
 * @param {SwiftRule[]} rules
 * @param {string} cacheDir
 * @returns {Promise<SwiftFinding[] | undefined>}
 */
async function swiftlint(cwd, files, rules, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const configFile = join(cacheDir, "swiftlint.yml");
  writeFileSync(configFile, JSON.stringify(swiftlintConfig(rules)));
  const byName = new Map(rules.map((r) => [r.swiftlint ?? r.id, r]));
  const root = realpathSync(cwd);
  /** @type {SwiftFinding[]} */
  const findings = [];
  // Batches keep the command line under the OS limit on big projects.
  for (let i = 0; i < files.length; i += 500) {
    const args = ["lint", "--quiet", "--reporter", "json", "--config", configFile, "--cache-path", join(cacheDir, "swiftlint-cache"), ...files.slice(i, i + 500)];
    // SwiftLint exits 2 when it finds an error-level violation; any other non-zero exit is a failure.
    const run = await exec("swiftlint", args, { cwd, maxBuffer: Infinity }).catch((/** @type {any} */ e) => e);
    if (run.code === "ENOENT") return undefined;
    /** @type {{ file: string, line: number, character: number | null, rule_id: string, reason: string }[]} */
    let violations;
    try {
      violations = JSON.parse(run.stdout);
      if (run.code && run.code !== 2) throw new Error();
    } catch {
      throw new Error(`swiftlint failed (exit ${run.code ?? run.signal})\n${run.stderr}${run.stdout}`.trim());
    }
    for (const v of violations) {
      const rule = byName.get(v.rule_id);
      findings.push({ file: relative(root, v.file).normalize("NFC"), line: v.line, column: v.character ?? 1, rule: rule?.id ?? v.rule_id, message: rule?.message ?? v.reason });
    }
  }
  return findings;
}

