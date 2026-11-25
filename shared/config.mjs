// @ts-check
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parse } from "yaml";

import { DEFAULT_ID_PATTERN } from "./shape.mjs";

export const CONFIG_FILE = "intersite.yml";
/** JSON is valid YAML, so an older intersite.json loads the same way. */
const CONFIG_FILES = [CONFIG_FILE, "intersite.yaml", "intersite.json"];

/** The config file this project has, or undefined. @param {string} cwd */
export function configPath(cwd) {
  return CONFIG_FILES.map((name) => join(cwd, name)).find((path) => existsSync(path));
}

/**
 * Everything Intersite writes into a project lives in this folder beside intersite.yml. Its own .gitignore keeps what
 * is generated (the case database, the run ledger, oxlint's configs, caches) out of git and commits the rest: the
 * baseline and the replay adapter.
 */
export const INTERSITE_DIR = ".intersite";
export const DIR_GITIGNORE = "# Written by Intersite: everything here is generated except what is listed below.\n*\n!.gitignore\n!baseline.json\n!adapter.mjs\n";

/** The project's `.intersite` folder, made with its .gitignore when missing. @param {string} cwd */
export function intersiteDir(cwd) {
  const dir = join(cwd, INTERSITE_DIR);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), DIR_GITIGNORE);
  return dir;
}

/** Findings recorded so only new ones fail, committed with the code: `lint` (file -> rule -> count) and `gates` (gate -> targets). */
export const BASELINE = `${INTERSITE_DIR}/baseline.json`;
/** Where versions before 1.0.0-rc.24 kept each part, beside intersite.yml; read until the next write moves them. */
export const OLD_BASELINES = /** @type {const} */ ({ lint: "intersite-baseline.json", gates: "intersite-gates-baseline.json" });

/**
 * The project's baseline: `.intersite/baseline.json`, or the older per-part files. Throws an Error naming the
 * file when one is not valid JSON.
 * @param {string} cwd @returns {{ lint?: Record<string, Record<string, number>>, gates?: Record<string, string[]> }}
 */
export function readBaselines(cwd) {
  const read = (/** @type {string} */ file) => {
    try {
      return JSON.parse(readFileSync(join(cwd, file), "utf8"));
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
  };
  if (existsSync(join(cwd, BASELINE))) return read(BASELINE);
  return Object.fromEntries(Object.entries(OLD_BASELINES).filter(([, file]) => existsSync(join(cwd, file))).map(([part, file]) => [part, read(file)]));
}

/**
 * Records one part of the baseline, moving the older per-part files into `.intersite/baseline.json`. A baseline that
 * cannot be read is replaced, which is the way out of a corrupt one.
 * @param {string} cwd @param {"lint" | "gates"} part @param {unknown} data
 */
export function writeBaseline(cwd, part, data) {
  let all = {};
  try {
    all = readBaselines(cwd);
  } catch {
    all = {};
  }
  intersiteDir(cwd);
  writeFileSync(join(cwd, BASELINE), `${JSON.stringify({ ...all, [part]: data }, null, 2)}\n`);
  for (const file of Object.values(OLD_BASELINES)) rmSync(join(cwd, file), { force: true });
}

/** The branch a change is compared with when `gates.base` is not set; the gates fall back to the local main line. */
export const DEFAULT_BASE = "origin/main";

/**
 * The folder whose config applies here: the nearest one at or above `cwd` holding an intersite.yml, looking no
 * higher than the repository's top. A command run from inside a package of a monorepo configured at its root thus
 * uses the root's config and baseline. With no config found, `cwd` itself.
 * @param {string} cwd
 */
export function projectRoot(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (configPath(dir)) return dir;
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return cwd;
  }
}

/** Paths that count as tests, for the gates that treat tests differently from source. */
export const TEST_PATHS = ["**/*.test.*", "**/*.spec.*", "test/**", "tests/**", "**/__tests__/**", "e2e/**"];

/** Every default `loadConfig` fills in. */
export const defaults = {
  collector: {
    url: "http://127.0.0.1:8790",
    readTokenEnv: "INTERSITE_READ_TOKEN",
    ingestTokenEnv: "INTERSITE_INGEST_TOKEN",
    name: "intersite-collector",
    domain: "",
    dailyCap: { ok: 5000, other: 5000 },
  },
  lint: {
    packs: ["tests","slop","security","state","async","perf","react","react-native","next","design","types","validation","naming","globals","ui","orm","query","workers","supabase","server","start","effect","payments","auth","swift"],
    /** @type {Record<string, string | unknown[]>} */
    rules: {},
    /** @type {import("../lint/catalog.mjs").JsonRule[]} */
    custom: [],
    extends: ".oxlintrc.json",
    ownRules: true,
    typeAware: false,
  },
  gates: {
    base: DEFAULT_BASE,
    run: ["test-integrity","duplicates","similar","new-deps","artifacts","unused","naming","style-drift","value-drift","sql","regex","decisions","renames","schema-drift","imports","boundaries","tamper","special-case","complexity","columns","routes","env","secrets","auth","structure"],
    testPaths: TEST_PATHS,
    testCmd: "",
    setup: "",
    /** @type {string[]} */
    entryPaths: [],
    /** @type {string[]} */
    artifacts: [],
    duplicateLines: 6,
    mutants: 20,
    /** @type {{ gate: string, target: string, why: string }[]} */
    acknowledged: [],
    /** @type {{ paths: string[], needs?: string[], why?: string }[]} */
    protected: [],
    /** @type {{ name: string, paths: string[] }[]} */
    layers: [],
    features: "",
  },
  capture: {
    sample: 0.05,
    maxBodyBytes: 32_768,
    include: ["/**"],
    /** @type {string[]} */
    exclude: [],
    /** @type {string[]} */
    redactKeys: [],
    /** @type {string[]} */
    keepKeys: [],
    idPattern: DEFAULT_ID_PATTERN,
    ttlDays: { ok: 14, warn: 90, rejected: 30, error: 90 },
  },
  replay: {
    target: "http://localhost:8787",
    uiTarget: "",
    browser: "chrome",
    browserUrl: "",
    adapter: `./${INTERSITE_DIR}/adapter.mjs`,
    modes: ["baseline"],
    sample: 20,
    shiftDates: true,
    /** @type {string[]} */
    snapshotIgnore: [],
    /** @type {{ route: string, pointer?: string, check?: string, why: string }[]} */
    contractIgnore: [],
    /** @type {{ route: string, why: string }[]} */
    crossTenantIgnore: [],
  },
};

/** @type {string | undefined} */
let served;
/**
 * Points this process's config at a collector the CLI serves itself for the length of one command (cli/local.mjs).
 * Each command gets its own port, so commands run at once never depend on each other's collector.
 * @param {string} url
 */
export function useServedCollector(url) {
  served = url;
}

/** The name in package.json (or the folder's name), reduced to what a project name may contain. @param {string} cwd */
export function projectName(cwd) {
  const manifest = join(cwd, "package.json");
  const named = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).name : undefined;
  // Accents come off before the rest is dashed, so "Café" is "cafe", not "caf".
  const slug = String(named ?? basename(cwd)).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 64) || "project";
}

/**
 * The project's intersite.yml with defaults filled in. Sections merge one level deep. With no file at all every
 * default applies and the project is named after its package, so each command works in a fresh checkout.
 * @param {string} cwd
 * @returns {{ project: string, collector: typeof defaults.collector, lint: typeof defaults.lint, gates: typeof defaults.gates,
 *   capture: typeof defaults.capture, replay: typeof defaults.replay & { enabled: boolean }, checks: ReturnType<typeof projectChecks> }}
 */
export function loadConfig(cwd) {
  const path = configPath(cwd);
  /** @type {Record<string, any>} */
  const file = { project: projectName(cwd), ...(path ? readFile(path) : {}) };
  if (typeof file.project !== "string" || !/^[a-z0-9-]{1,64}$/.test(file.project)) {
    throw new Error(`${CONFIG_FILE}: "project" must be lowercase letters, digits and dashes`);
  }
  return {
    project: /** @type {string} */ (file.project),
    collector: { ...defaults.collector, ...file.collector, ...(served && { url: served }), dailyCap: { ...defaults.collector.dailyCap, ...file.collector?.dailyCap } },
    lint: { ...defaults.lint, ...file.lint },
    gates: { ...defaults.gates, ...file.gates },
    capture: { ...defaults.capture, ...file.capture, ttlDays: { ...defaults.capture.ttlDays, ...file.capture?.ttlDays } },
    // `replay: false` is a project that only lints and gates: no replay stage, adapter or replay skill.
    replay: { ...defaults.replay, ...(existsSync(join(cwd, OLD_ADAPTER)) && { adapter: `./${OLD_ADAPTER}` }), ...file.replay, enabled: file.replay !== false },
    checks: projectChecks(file.checks, path ? basename(path) : CONFIG_FILE),
  };
}

/** Where versions before 1.0.0-rc.24 wrote the replay adapter; `intersite init` moves it into `.intersite`. */
export const OLD_ADAPTER = "intersite.adapter.mjs";

/** Stage names `intersite check` already uses, which a project check may not take. */
const BUILT_IN = new Set(["lint", "replay", ...defaults.gates.run, "fails-on-base", "mutation", "protected", "coverage"]);

/**
 * The project's own checks: commands `intersite check` runs after the gates, each only when the change touches its
 * `when` paths. `slow` ones wait for `--full`.
 * @param {unknown} list @param {string} name the config file, for the error
 * @returns {{ name: string, run: string, cwd: string, when: string[], slow: boolean }[]}
 */
function projectChecks(list, name) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`${name}: "checks" must be a list of { name, run } entries`);
  const seen = new Set();
  return list.map((entry) => {
    const { name: id, run, cwd = ".", when = [], slow = false } = entry ?? {};
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id) || typeof run !== "string" || !run.trim()) {
      throw new Error(`${name}: each entry of "checks" needs a lowercase \`name\` (letters, digits, dashes) and a \`run\` command`);
    }
    if (BUILT_IN.has(id) || seen.has(id)) throw new Error(`${name}: check name "${id}" is already taken; pick another`);
    seen.add(id);
    if (typeof cwd !== "string" || !Array.isArray(when)) throw new Error(`${name}: check "${id}": \`cwd\` is a folder and \`when\` a list of globs`);
    return { name: id, run, cwd, when, slow: slow === true };
  });
}

/**
 * The config file's contents, failing with one line that names the file and the problem: a YAML error spans several
 * lines, and a section that is not a mapping (`gates: main`) would otherwise be silently ignored.
 * @param {string} path
 * @returns {Record<string, any>}
 */
function readFile(path) {
  const name = basename(path);
  let file;
  try {
    file = parse(readFileSync(path, "utf8")) ?? {};
  } catch (error) {
    throw new Error(`${name}: ${/** @type {Error} */ (error).message.split("\n")[0].replace(/:$/, "")}`, { cause: error });
  }
  if (typeof file !== "object" || Array.isArray(file)) throw new Error(`${name}: must be a mapping of settings, such as \`project: acme\``);
  for (const section of Object.keys(defaults)) {
    const value = file[section];
    if (section === "replay" && value === false) continue;
    if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`${name}: "${section}" must be a mapping, such as \`${section}:\` followed by indented settings`);
    }
  }
  return file;
}

/** @typedef {ReturnType<typeof loadConfig>} Config */

/**
 * The `capture` section of intersite.yml, with the project name, as `createCapture` options. Capture runs in the
 * project's server and never reads files itself, so a Node server passes these in to make the config apply:
 * `createCapture({ ...captureOptions(), url, token, release })`. A Worker has no file system and passes them inline.
 * @param {string} [cwd]
 */
export function captureOptions(cwd = process.cwd()) {
  const config = loadConfig(projectRoot(cwd));
  return { project: config.project, ...config.capture };
}

/**
 * The collector tokens for local use. A local collector (`intersite collector`) accepts these defaults, so a fresh
 * checkout works with no environment set; a deployed one needs the real tokens in the named variables.
 * @param {Config} config
 */
export function collectorTokens(config) {
  return {
    read: process.env[config.collector.readTokenEnv] ?? "local-read",
    ingest: process.env[config.collector.ingestTokenEnv] ?? "local-ingest",
  };
}
