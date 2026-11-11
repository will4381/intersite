// @ts-check
// intersite lint [paths...] [--write | --write=init | --json | --rules]
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadConfig } from "../shared/config.mjs";
import { builtinRules, declaredRule, packageRules } from "../lint/catalog.mjs";
import { runSwiftlint, swiftFiles, swiftRules } from "../lint/swift/swiftlint.mjs";

/** @typedef {Record<string, Record<string, number>>} Baseline */
/** @typedef {{ file: string, line: number, column: number, rule: string, message: string }} Finding */

const flagsAllowed = ["--write", "--write=init", "--json", "--rules"];
const BARE_RULE = "intersite/no-bare-suppression";
const BARE_MESSAGE = "This suppression names no rule, so it turns off every rule, intersite's included. Fix the code, or for a deliberate exception use `// oxlint-disable-next-line <rule> -- <why>`.";
// A disable comment that names no rule. Line and block comments must start their line, and a trailing `-line` comment
// must end it, so the same text inside a string literal is not matched.
const directive = "(?:eslint|oxlint)-disable(?:-next-line|-line)?";
const bareSuppression = new RegExp(
  `^[ \\t]*//[ \\t]*${directive}(?=[ \\t]*(?:--|$))|^[ \\t]*/\\*[ \\t]*${directive}(?=[ \\t]*(?:--|\\*/))|//[ \\t]*(?:eslint|oxlint)-disable-line(?=[ \\t]*(?:--[^'"\`]*)?$)`,
  "gm",
);

const exec = promisify(execFile);

/**
 * Every rule this oxlint ships. Asking takes a while, so the answer is kept until the binary changes.
 * @param {string} oxlint @param {string} cacheDir
 * @returns {Promise<{ scope: string, value: string, category: string }[]>}
 */
async function shippedRules(oxlint, cacheDir) {
  const cacheFile = join(cacheDir, "oxlint-rules.json");
  const version = statSync(oxlint).mtimeMs;
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached.version === version) return cached.rules;
  }
  // An empty folder: oxlint reads the config of, and scans, whatever folder it is started in.
  const empty = mkdtempSync(join(tmpdir(), "intersite-oxlint-"));
  try {
    const rules = JSON.parse((await exec(oxlint, ["--rules", "-f", "json"], { cwd: empty, maxBuffer: Infinity })).stdout);
    writeFileSync(cacheFile, JSON.stringify({ version, rules }));
    return rules;
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd: string, quiet?: boolean }} options `quiet` leaves out the success line, for `check`
 */
export default async function lint(argv, { cwd, quiet = false }) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const flag = flags[0];
  const paths = argv.filter((a) => !a.startsWith("--"));
  if (flags.length > 1 || (flag && !flagsAllowed.includes(flag))) {
    console.error(`usage: intersite lint [paths...] [${flagsAllowed.join(" | ")}]`);
    return 2;
  }
  const missing = paths.find((p) => !existsSync(resolve(cwd, p)));
  if (missing) {
    console.error(`intersite lint: ${missing} does not exist`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(cwd).lint;
    // The plugin builds these again inside oxlint; a malformed one is reported here in one line instead.
    for (const r of config.custom) declaredRule(r);
  } catch (error) {
    console.error(`intersite lint: ${/** @type {Error} */ (error).message}`);
    return 2;
  }

  const { rules, bareOn, swift } = ruleSet(config);
  if (flag === "--rules") {
    console.log(`slop no-bare-suppression ${bareOn ? "on" : "off"}`);
    printRules(config.custom, rules);
    for (const r of swiftRules) console.log(`swift swift/${r.id} ${swift.includes(r) ? "on" : "off"}`);
    return 0;
  }

  // A Swift-only project has no oxlint and needs none: its Swift is linted and the JavaScript side is empty.
  const oxlint = findOxlint(cwd) ?? join(cwd, "node_modules/.bin/oxlint");
  const javascript = existsSync(oxlint)
    ? writeOxlintConfig(cwd, join(cwd, config.extends), oxlint, rules).then((configs) => runOxlint(cwd, oxlint, configs, paths), (/** @type {Error} */ error) => {
      console.error(`intersite lint: ${error.message}`);
      return undefined;
    })
    : { report: { number_of_files: 0, diagnostics: [] }, listed: [] };
  const [result, swiftResult] = await Promise.all([javascript, lintSwift(cwd, swift, paths)]);
  if (!result || !swiftResult) return 2;
  if (!existsSync(oxlint) && swiftResult.files === 0) {
    console.error(`intersite lint: ${oxlint} not found; install oxlint as a dev dependency`);
    return 2;
  }
  const { report, listed } = result;
  report.number_of_files += swiftResult.files;
  /** @type {Finding[]} */
  const all = report.diagnostics.map((d) => ({
    file: d.filename,
    line: d.labels?.[0]?.span.line ?? 0,
    column: d.labels?.[0]?.span.column ?? 0,
    rule: d.code.replace(/^(.*)\((.*)\)$/, "$1/$2"),
    message: d.message,
    // `ownRules: false`: the project's own lint command gates its own config's rules, so only the rules this run added count.
  })).filter((f) => config.ownRules || (rules[f.rule] ?? "off") !== "off");
  if (bareOn) all.push(...(await bareSuppressions(cwd, listed)));
  all.push(...swiftResult.findings);

  /** @type {Map<string, Finding[]>} "file\0rule" -> findings */
  const found = new Map();
  for (const f of all) {
    const key = `${f.file}\0${f.rule}`;
    found.set(key, [...(found.get(key) ?? []), f]);
  }

  const baselineFile = join(cwd, config.baseline);
  /** @type {Baseline} */
  let baseline = {};
  try {
    // --write=init replaces the file, so it is the way out of a corrupt one and need not read it.
    if (flag !== "--write=init" && existsSync(baselineFile)) baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  } catch {
    console.error(`intersite lint: ${config.baseline} is not valid JSON: restore it from git, or run \`intersite lint --write=init\` to record today's findings again`);
    return 2;
  }

  if (flag === "--write=init") {
    /** @type {Baseline} */
    const next = {};
    for (const [key, list] of found) {
      const [file, rule] = key.split("\0");
      (next[file] ??= {})[rule] = list.length;
    }
    writeFileSync(baselineFile, `${JSON.stringify(sorted(next), null, 2)}\n`);
    if (!quiet) console.log(`ok lint: ${report.number_of_files} files, ${all.length} findings recorded in ${config.baseline}`);
    return 0;
  }

  const { next, over, under, baselined } = compareBaseline(found, baseline, paths);
  if (flag === "--write") writeFileSync(baselineFile, `${JSON.stringify(sorted(next), null, 2)}\n`);
  const failed = flag === "--write" ? over : [...over, ...under];
  if (flag === "--json") {
    console.log(JSON.stringify({ findings: failed, baselined }));
  } else if (failed.length) {
    for (const f of over) console.log(`${f.file}:${f.line}:${f.column} ${f.rule} ${f.message}`);
    if (flag !== "--write") for (const f of under) console.log(`${f.file} ${f.rule}: ${f.message}`);
  } else if (!quiet) {
    console.log(`ok lint: ${report.number_of_files} files, 0 new findings${baselined ? `, ${baselined} baselined` : ""}`);
  }
  return failed.length ? 1 : 0;
}

/**
 * The oxlint rule levels the configured packs, custom rules and overrides switch on, and whether the bare-suppression check runs.
 * @param {ReturnType<typeof loadConfig>["lint"]} config
 */
function ruleSet(config) {
  /** @type {Record<string, string>} */
  const rules = {};
  for (const r of packageRules) if (r.pack && config.packs.includes(r.pack)) rules[`intersite/${r.id}`] = "error";
  for (const r of config.custom) rules[`intersite/${r.id}`] = "error";
  for (const b of builtinRules) if (config.packs.includes(b.pack)) rules[b.rule] = "error";
  // An override names an intersite rule by its bare id, or a built-in rule by oxlint's full name.
  for (const [id, level] of Object.entries(config.rules)) rules[id.includes("/") ? id : `intersite/${id}`] = level;
  // Not an oxlint rule (see bareSuppressions), but switched on and off like one in the slop pack.
  const bareOn = (rules[BARE_RULE] ?? (config.packs.includes("slop") ? "error" : "off")) !== "off";
  delete rules[BARE_RULE];
  // Swift rules run in SwiftLint (see lintSwift), and are switched on and off the same way, as `swift/<id>`.
  const swift = swiftRules.filter((r) => (rules[`swift/${r.id}`] ?? (config.packs.includes("swift") ? "error" : "off")) !== "off");
  for (const r of swiftRules) delete rules[`swift/${r.id}`];
  return { rules, bareOn, swift };
}

/**
 * Lints the Swift files under the paths with SwiftLint. SwiftLint never runs when no Swift rule is on or there are no
 * Swift files. Prints the setup error and returns undefined when SwiftLint is missing or fails.
 * @param {string} cwd
 * @param {typeof swiftRules} rules the Swift rules that are on
 * @param {string[]} paths
 * @returns {Promise<{ files: number, findings: Finding[] } | undefined>}
 */
async function lintSwift(cwd, rules, paths) {
  const files = rules.length ? swiftFiles(cwd, paths) : [];
  if (!files.length) return { files: 0, findings: [] };
  const findings = await runSwiftlint(cwd, files, rules, join(cwd, "node_modules/.cache/intersite")).catch((/** @type {Error} */ e) => e);
  if (Array.isArray(findings)) return { files: files.length, findings };
  const missing = "this project has Swift files and swiftlint is not on PATH; install it with `brew install swiftlint`";
  console.error(`intersite lint: ${findings instanceof Error ? findings.message : missing}`);
  return undefined;
}

/**
 * Prints every package, custom and built-in rule as `<pack> <rule> on|off` for `--rules`.
 * @param {{ id: string }[]} custom the project's `lint.custom` rules
 * @param {Record<string, string>} rules
 */
function printRules(custom, rules) {
  for (const r of [...packageRules, ...custom.map((c) => ({ ...c, pack: "custom" }))]) {
    console.log(`${r.pack} ${r.id} ${(rules[`intersite/${r.id}`] ?? "off") === "off" ? "off" : "on"}`);
  }
  for (const b of builtinRules) console.log(`${b.pack} ${b.rule} ${(rules[b.rule] ?? "off") === "off" ? "off" : "on"}`);
}

/**
 * The oxlint binary in the nearest node_modules at or above `cwd`: a workspace package's dependencies are often
 * installed once at the repository root.
 * @param {string} cwd
 */
export function findOxlint(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const bin = join(dir, "node_modules/.bin/oxlint");
    if (existsSync(bin)) return bin;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The project's own oxlint config. Plain JSON is read directly; oxlint also accepts comments and trailing commas, so
 * anything else is read back through oxlint itself, which reports a broken file in its own words.
 * @param {string} oxlint @param {string} file
 * @returns {Promise<{ plugins?: string[], ignorePatterns?: string[] }>}
 */
async function ownSettings(oxlint, file) {
  const text = readFileSync(file, "utf8");
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    const printed = await exec(oxlint, ["--print-config", "-c", file], { maxBuffer: Infinity }).catch((/** @type {any} */ error) => error);
    if (printed instanceof Error) {
      const output = `${/** @type {any} */ (printed).stdout ?? ""}${/** @type {any} */ (printed).stderr ?? ""}`;
      const reason = output.split("\n").map((line) => line.replace(/^\s*\|\s*/, "").trim()).filter(Boolean).at(-1);
      throw new Error(`${basename(file)} is not a valid oxlint config: ${reason ?? printed.message.split("\n")[0]}`);
    }
    settings = JSON.parse(printed.stdout);
  }
  return settings;
}

/**
 * Writes the generated oxlint config into node_modules/.cache/intersite and returns its path, with a second one for
 * listing files: the same minus intersite's plugin, which only lints and would be loaded for nothing, and the project's
 * own ignore patterns.
 * @param {string} cwd
 * @param {string} ownConfig the project's own oxlint config
 * @param {string} oxlint
 * @param {Record<string, string>} rules
 */
async function writeOxlintConfig(cwd, ownConfig, oxlint, rules) {
  const cacheDir = join(cwd, "node_modules/.cache/intersite");
  const configFile = join(cacheDir, "oxlintrc.json");
  const filesConfig = join(cacheDir, "oxlintrc-files.json");
  mkdirSync(cacheDir, { recursive: true });
  // Naming plugins replaces oxlint's default set, so start from the project's own list, or the defaults.
  /** @type {{ plugins?: string[], ignorePatterns?: string[] }} */
  const own = existsSync(ownConfig) ? await ownSettings(oxlint, ownConfig) : {};
  /** @type {string[]} */
  const ownPlugins = own.plugins ?? ["unicorn", "typescript", "oxc"];
  // Plugins this run adds for a pack's built-in rules. Turning a plugin on also turns on its whole "correctness"
  // set, which nobody chose, so every such rule not named by a pack is switched off again.
  const added = [...new Set(builtinRules.filter((b) => b.rule in rules).map((b) => b.rule.split("/")[0]))].filter((name) => name !== "eslint" && !ownPlugins.includes(name));
  if (added.length) {
    for (const r of await shippedRules(oxlint, cacheDir)) {
      const name = `${r.scope.replaceAll("_", "-")}/${r.value}`;
      if (added.includes(name.split("/")[0]) && r.category === "correctness" && !(name in rules)) rules[name] = "off";
    }
  }
  // A built-in rule only runs when its plugin is on; `eslint` rules need none.
  const settings = { ...(existsSync(ownConfig) && { extends: [ownConfig] }), plugins: [...ownPlugins, ...added] };
  writeFileSync(configFile, JSON.stringify({ ...settings, jsPlugins: [fileURLToPath(new URL("../lint/plugin.mjs", import.meta.url))], rules }));
  writeFileSync(filesConfig, JSON.stringify({ ...settings, rules: Object.fromEntries(Object.entries(rules).filter(([id]) => !id.startsWith("intersite/"))) }));
  // oxlint drops `ignorePatterns` from an extended config, so the project's own ignores are passed on the command line.
  // ponytail: read relative to the working directory, which is where the own config sits unless lint.extends moves it.
  return { configFile, filesConfig, ignores: own.ignorePatterns ?? [] };
}

/**
 * Runs oxlint for its JSON report and its file list; prints the error and returns undefined when the report is unusable.
 * @param {string} cwd
 * @param {string} oxlint
 * @param {{ configFile: string, filesConfig: string, ignores: string[] }} configs the config to lint with, the one to list
 * files with, and the project's own ignore patterns
 * @param {string[]} paths
 */
async function runOxlint(cwd, oxlint, { configFile, filesConfig, ignores }, paths) {
  // The JSON report has no file list, so a second oxlint run lists the files it lints (its own ignores applied).
  // A Swift-only project has nothing for oxlint, which is not an error.
  // oxlint lints node_modules unless a .gitignore says not to, and a fresh project may have no .gitignore.
  const args = ["--no-error-on-unmatched-pattern", "--ignore-pattern=**/node_modules/**", ...ignores.map((p) => `--ignore-pattern=${p}`), ...(paths.length ? paths : ["."])];
  /** @param {string[]} extra */
  const oxlintRun = (extra) => exec(oxlint, [...extra, ...args], { cwd, maxBuffer: Infinity }).catch((/** @type {any} */ e) => e);
  const [run, listed] = await Promise.all([oxlintRun(["-c", configFile, "-f", "json"]), oxlintRun(["-c", filesConfig, "--debug=files"])]);
  /** @type {{ number_of_files: number, diagnostics: { message: string, code: string, filename: string, labels?: { span: { line: number, column: number } }[] }[] }} */
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error(`intersite lint: oxlint did not print JSON (exit ${run.code})\n${run.stderr}${run.stdout}`);
    return undefined;
  }

  // A diagnostic with no rule code is a rule that threw: say which, instead of failing on it later.
  const crashed = report.diagnostics.find((d) => !d.code);
  if (crashed) {
    // The thrown error's own line says what broke (an invalid lint.custom selector reads "SyntaxError: Expected …").
    const reason = /^\w*Error: .*$/m.exec(crashed.message)?.[0] ?? crashed.message.split("\n")[0];
    console.error(`intersite lint: a lint rule crashed on ${crashed.filename}: ${reason}`);
    return undefined;
  }
  return { report, listed: String(listed.stdout).split("\n").filter(Boolean) };
}

/**
 * Compares findings with the baseline: findings over it, entries now too high, the lowered baseline, and the count it covers.
 * @param {Map<string, Finding[]>} found "file\0rule" -> findings
 * @param {Baseline} baseline
 * @param {string[]} paths
 */
function compareBaseline(found, baseline, paths) {
  // Baseline entries outside the linted paths were not checked this run, so they are neither compared nor lowered.
  /** @param {string} file */
  const inScope = (file) => !paths.length || paths.some((p) => p === "." || file === p || file.startsWith(`${p.replace(/\/$/, "")}/`));
  /** @type {Baseline} */
  const next = {};
  /** @type {Finding[]} */
  const over = [];
  /** @type {Finding[]} baseline entries that are now too high, as findings with no line */
  const under = [];
  let baselined = 0;
  const keys = new Set([...found.keys(), ...Object.entries(baseline).flatMap(([f, r]) => Object.keys(r).map((rule) => `${f}\0${rule}`))]);
  for (const key of keys) {
    const [file, rule] = key.split("\0");
    const allowed = baseline[file]?.[rule] ?? 0;
    const list = found.get(key) ?? [];
    let keep = allowed;
    if (inScope(file)) {
      if (list.length > allowed) over.push(...list);
      else {
        baselined += list.length;
        if (list.length < allowed) {
          const message = `${list.length} findings, baseline allows ${allowed}; run intersite lint --write to lower it`;
          under.push({ file, line: 0, column: 0, rule, message });
          keep = list.length;
        }
      }
    }
    if (keep > 0) (next[file] ??= {})[rule] = keep;
  }
  return { next, over, under, baselined };
}

/**
 * Bare disable comments in the given files. oxlint honors them before any rule runs, so no rule can report them.
 * @param {string} cwd
 * @param {string[]} files paths as oxlint prints them
 * @returns {Promise<Finding[]>}
 */
async function bareSuppressions(cwd, files) {
  /** @type {Finding[]} */
  const findings = [];
  // A file oxlint listed and that is gone or unreadable by now has no suppressions to report.
  const unreadable = () => "";
  for (let i = 0; i < files.length; i += 256) {
    const batch = files.slice(i, i + 256);
    const texts = await Promise.all(batch.map((f) => readFile(resolve(cwd, f), "utf8").catch(unreadable)));
    texts.forEach((text, j) => {
      if (!text.includes("-disable")) return;
      for (const m of text.matchAll(bareSuppression)) {
        const start = m.index + m[0].search(/\/[/*]/);
        const before = text.slice(0, start);
        const line = before.split("\n").length;
        findings.push({ file: batch[j], line, column: start - before.lastIndexOf("\n"), rule: BARE_RULE, message: BARE_MESSAGE });
      }
    });
  }
  return findings;
}

/** @param {Baseline} baseline */
function sorted(baseline) {
  return Object.fromEntries(
    Object.keys(baseline)
      .sort()
      .map((file) => [file, Object.fromEntries(Object.entries(baseline[file]).sort())]),
  );
}
