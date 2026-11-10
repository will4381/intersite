// @ts-check
// intersite lint [paths...] [--write | --write=init]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../shared/config.mjs";
import { customRules, packageRules } from "../lint/plugin.mjs";

/** @typedef {Record<string, Record<string, number>>} Baseline */

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} options
 */
export default async function lint(argv, { cwd }) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const write = flags[0];
  const paths = argv.filter((a) => !a.startsWith("--"));
  if (flags.length > 1 || (write && write !== "--write" && write !== "--write=init")) {
    console.error("usage: intersite lint [paths...] [--write | --write=init]");
    return 2;
  }

  let config;
  try {
    config = loadConfig(cwd).lint;
  } catch (error) {
    console.error(`intersite lint: ${/** @type {Error} */ (error).message}`);
    return 2;
  }
  const oxlint = join(cwd, "node_modules/.bin/oxlint");
  if (!existsSync(oxlint)) {
    console.error(`intersite lint: ${oxlint} not found; install oxlint as a dev dependency`);
    return 2;
  }

  /** @type {Record<string, string>} */
  const rules = {};
  for (const r of packageRules) if (r.pack && config.packs.includes(r.pack)) rules[`intersite/${r.id}`] = "error";
  for (const r of customRules(cwd)) rules[`intersite/${r.id}`] = "error";
  for (const [id, level] of Object.entries(config.rules)) rules[`intersite/${id}`] = level;

  const cacheDir = join(cwd, "node_modules/.cache/intersite");
  const configFile = join(cacheDir, "oxlintrc.json");
  const ownConfig = join(cwd, config.extends);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      ...(existsSync(ownConfig) && { extends: [ownConfig] }),
      jsPlugins: [fileURLToPath(new URL("../lint/plugin.mjs", import.meta.url))],
      rules,
    }),
  );

  const run = spawnSync(oxlint, ["-c", configFile, "-f", "json", ...(paths.length ? paths : ["."])], { cwd, encoding: "utf8" });
  /** @type {{ diagnostics: { message: string, code: string, filename: string, labels?: { span: { line: number, column: number } }[] }[] }} */
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error(`intersite lint: oxlint did not print JSON (exit ${run.status})\n${run.stderr}${run.stdout}`);
    return 2;
  }

  /** @type {Map<string, string[]>} "file\0rule" -> printed findings */
  const found = new Map();
  for (const d of report.diagnostics) {
    const rule = d.code.replace(/^(.*)\((.*)\)$/, "$1/$2");
    const span = d.labels?.[0]?.span;
    const key = `${d.filename}\0${rule}`;
    found.set(key, [...(found.get(key) ?? []), `${d.filename}:${span?.line ?? 0}:${span?.column ?? 0} ${rule} ${d.message}`]);
  }

  const baselineFile = join(cwd, config.baseline);
  /** @type {Baseline} */
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : {};

  if (write === "--write=init") {
    /** @type {Baseline} */
    const next = {};
    for (const [key, lines] of found) {
      const [file, rule] = key.split("\0");
      (next[file] ??= {})[rule] = lines.length;
    }
    writeFileSync(baselineFile, `${JSON.stringify(sorted(next), null, 2)}\n`);
    console.log(`intersite lint: recorded ${report.diagnostics.length} findings in ${config.baseline}`);
    return 0;
  }

  // Baseline entries outside the linted paths were not checked this run, so they are neither compared nor lowered.
  /** @param {string} file */
  const inScope = (file) => !paths.length || paths.some((p) => p === "." || file === p || file.startsWith(`${p.replace(/\/$/, "")}/`));
  /** @type {Baseline} */
  const next = {};
  const over = [];
  const under = [];
  const keys = new Set([...found.keys(), ...Object.entries(baseline).flatMap(([f, r]) => Object.keys(r).map((rule) => `${f}\0${rule}`))]);
  for (const key of keys) {
    const [file, rule] = key.split("\0");
    const allowed = baseline[file]?.[rule] ?? 0;
    const lines = found.get(key) ?? [];
    let keep = allowed;
    if (inScope(file)) {
      if (lines.length > allowed) over.push(...lines);
      else if (lines.length < allowed) {
        under.push(`${file} ${rule}: ${lines.length} findings, baseline allows ${allowed}; run intersite lint --write to lower it`);
        keep = lines.length;
      }
    }
    if (keep > 0) (next[file] ??= {})[rule] = keep;
  }

  for (const line of over) console.log(line);
  if (write === "--write") {
    writeFileSync(baselineFile, `${JSON.stringify(sorted(next), null, 2)}\n`);
  } else {
    for (const line of under) console.log(line);
  }
  return over.length || (under.length && !write) ? 1 : 0;
}

/** @param {Baseline} baseline */
function sorted(baseline) {
  return Object.fromEntries(
    Object.keys(baseline)
      .sort()
      .map((file) => [file, Object.fromEntries(Object.entries(baseline[file]).sort())]),
  );
}
