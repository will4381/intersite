// @ts-check
// intersite lint [paths...] [--write | --write=init | --json | --rules]
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadConfig } from "../shared/config.mjs";
import { builtinRules, customRules, packageRules } from "../lint/plugin.mjs";

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
 * @param {string[]} argv
 * @param {{ cwd: string }} options
 */
export default async function lint(argv, { cwd }) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const flag = flags[0];
  const paths = argv.filter((a) => !a.startsWith("--"));
  if (flags.length > 1 || (flag && !flagsAllowed.includes(flag))) {
    console.error(`usage: intersite lint [paths...] [${flagsAllowed.join(" | ")}]`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(cwd).lint;
  } catch (error) {
    console.error(`intersite lint: ${/** @type {Error} */ (error).message}`);
    return 2;
  }

  const { rules, bareOn } = ruleSet(config, cwd);
  if (flag === "--rules") {
    console.log(`slop no-bare-suppression ${bareOn ? "on" : "off"}`);
    printRules(cwd, rules);
    return 0;
  }

  const oxlint = join(cwd, "node_modules/.bin/oxlint");
  if (!existsSync(oxlint)) {
    console.error(`intersite lint: ${oxlint} not found; install oxlint as a dev dependency`);
    return 2;
  }

  const configFile = await writeOxlintConfig(cwd, join(cwd, config.extends), oxlint, rules);
  const result = await runOxlint(cwd, oxlint, configFile, paths);
  if (!result) return 2;
  const { report, listed } = result;
  /** @type {Finding[]} */
  const all = report.diagnostics.map((d) => ({
    file: d.filename,
    line: d.labels?.[0]?.span.line ?? 0,
    column: d.labels?.[0]?.span.column ?? 0,
    rule: d.code.replace(/^(.*)\((.*)\)$/, "$1/$2"),
    message: d.message,
  }));
  if (bareOn) all.push(...(await bareSuppressions(cwd, listed)));

  /** @type {Map<string, Finding[]>} "file\0rule" -> findings */
  const found = new Map();
  for (const f of all) {
    const key = `${f.file}\0${f.rule}`;
    found.set(key, [...(found.get(key) ?? []), f]);
  }

  const baselineFile = join(cwd, config.baseline);
  /** @type {Baseline} */
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : {};

  if (flag === "--write=init") {
    /** @type {Baseline} */
    const next = {};
    for (const [key, list] of found) {
      const [file, rule] = key.split("\0");
      (next[file] ??= {})[rule] = list.length;
    }
    writeFileSync(baselineFile, `${JSON.stringify(sorted(next), null, 2)}\n`);
    console.log(`ok lint: ${report.number_of_files} files, ${all.length} findings recorded in ${config.baseline}`);
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
  } else {
    console.log(`ok lint: ${report.number_of_files} files, 0 new findings${baselined ? `, ${baselined} baselined` : ""}`);
  }
  return failed.length ? 1 : 0;
}

/**
 * The oxlint rule levels the configured packs, custom rules and overrides switch on, and whether the bare-suppression check runs.
 * @param {ReturnType<typeof loadConfig>["lint"]} config
 * @param {string} cwd
 */
function ruleSet(config, cwd) {
  /** @type {Record<string, string>} */
  const rules = {};
  for (const r of packageRules) if (r.pack && config.packs.includes(r.pack)) rules[`intersite/${r.id}`] = "error";
  for (const r of customRules(cwd)) rules[`intersite/${r.id}`] = "error";
  for (const b of builtinRules) if (config.packs.includes(b.pack)) rules[b.rule] = "error";
  // An override names an intersite rule by its bare id, or a built-in rule by oxlint's full name.
  for (const [id, level] of Object.entries(config.rules)) rules[id.includes("/") ? id : `intersite/${id}`] = level;
  // Not an oxlint rule (see bareSuppressions), but switched on and off like one in the slop pack.
  const bareOn = (rules[BARE_RULE] ?? (config.packs.includes("slop") ? "error" : "off")) !== "off";
  delete rules[BARE_RULE];
  return { rules, bareOn };
}

/**
 * Prints every package, custom and built-in rule as `<pack> <rule> on|off` for `--rules`.
 * @param {string} cwd
 * @param {Record<string, string>} rules
 */
function printRules(cwd, rules) {
  for (const r of [...packageRules, ...customRules(cwd).map((c) => ({ ...c, pack: "custom" }))]) {
    console.log(`${r.pack} ${r.id} ${(rules[`intersite/${r.id}`] ?? "off") === "off" ? "off" : "on"}`);
  }
  for (const b of builtinRules) console.log(`${b.pack} ${b.rule} ${(rules[b.rule] ?? "off") === "off" ? "off" : "on"}`);
}

/**
 * Writes the generated oxlint config into node_modules/.cache/intersite and returns its path.
 * @param {string} cwd
 * @param {string} ownConfig the project's own oxlint config
 * @param {string} oxlint
 * @param {Record<string, string>} rules
 */
async function writeOxlintConfig(cwd, ownConfig, oxlint, rules) {
  const cacheDir = join(cwd, "node_modules/.cache/intersite");
  const configFile = join(cacheDir, "oxlintrc.json");
  mkdirSync(cacheDir, { recursive: true });
  // Naming plugins replaces oxlint's default set, so start from the project's own list, or the defaults.
  /** @type {string[]} */
  const ownPlugins = (existsSync(ownConfig) ? JSON.parse(readFileSync(ownConfig, "utf8")).plugins : undefined) ?? ["unicorn", "typescript", "oxc"];
  // Plugins this run adds for a pack's built-in rules. Turning a plugin on also turns on its whole "correctness"
  // set, which nobody chose, so every such rule not named by a pack is switched off again.
  const added = [...new Set(builtinRules.filter((b) => b.rule in rules).map((b) => b.rule.split("/")[0]))].filter((name) => name !== "eslint" && !ownPlugins.includes(name));
  if (added.length) {
    /** @type {{ scope: string, value: string, category: string }[]} */
    const shipped = JSON.parse((await exec(oxlint, ["--rules", "-f", "json"], { cwd: tmpdir(), maxBuffer: Infinity })).stdout);
    for (const r of shipped) {
      const name = `${r.scope.replaceAll("_", "-")}/${r.value}`;
      if (added.includes(name.split("/")[0]) && r.category === "correctness" && !(name in rules)) rules[name] = "off";
    }
  }
  writeFileSync(
    configFile,
    JSON.stringify({
      ...(existsSync(ownConfig) && { extends: [ownConfig] }),
      jsPlugins: [fileURLToPath(new URL("../lint/plugin.mjs", import.meta.url))],
      // A built-in rule only runs when its plugin is on; `eslint` rules need none.
      plugins: [...ownPlugins, ...added],
      rules,
    }),
  );
  return configFile;
}

/**
 * Runs oxlint for its JSON report and its file list; prints the error and returns undefined when the report is unusable.
 * @param {string} cwd
 * @param {string} oxlint
 * @param {string} configFile
 * @param {string[]} paths
 */
async function runOxlint(cwd, oxlint, configFile, paths) {
  // The JSON report has no file list, so a second oxlint run lists the files it lints (its own ignores applied).
  const args = ["-c", configFile, ...(paths.length ? paths : ["."])];
  /** @param {string[]} extra */
  const oxlintRun = (extra) => exec(oxlint, [...extra, ...args], { cwd, maxBuffer: Infinity }).catch((/** @type {any} */ e) => e);
  const [run, listed] = await Promise.all([oxlintRun(["-f", "json"]), oxlintRun(["--debug=files"])]);
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
    console.error(`intersite lint: a lint rule crashed on ${crashed.filename}: ${crashed.message.split("\n")[0]}`);
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
  for (let i = 0; i < files.length; i += 256) {
    const batch = files.slice(i, i + 256);
    const texts = await Promise.all(batch.map((f) => readFile(resolve(cwd, f), "utf8").catch(() => "")));
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
