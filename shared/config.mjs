// @ts-check
import { existsSync, readFileSync } from "node:fs";
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

const defaults = {
  collector: {
    url: "http://127.0.0.1:8790",
    readTokenEnv: "INTERSITE_READ_TOKEN",
    ingestTokenEnv: "INTERSITE_INGEST_TOKEN",
    name: "intersite-collector",
    dailyCap: { ok: 5000, other: 5000 },
  },
  lint: { packs: ["tests","slop","security","state","async","react","next","design","types","validation","naming","globals","ui","orm","query","workers","supabase","server","start","payments","auth","swift"], rules: {}, custom: [], baseline: "intersite-baseline.json", extends: ".oxlintrc.json" },
  gates: {
    base: DEFAULT_BASE,
    run: ["test-integrity","duplicates","similar","new-deps","artifacts","unused","naming","style-drift"],
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
  },
  capture: {
    sample: 0.05,
    maxBodyBytes: 32_768,
    include: ["/**"],
    exclude: [],
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
    adapter: "./intersite.adapter.mjs",
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
 */
export function loadConfig(cwd) {
  const path = configPath(cwd);
  const file = { project: projectName(cwd), ...(path && readFile(path)) };
  if (typeof file.project !== "string" || !/^[a-z0-9-]{1,64}$/.test(file.project)) {
    throw new Error(`${CONFIG_FILE}: "project" must be lowercase letters, digits and dashes`);
  }
  return {
    project: /** @type {string} */ (file.project),
    collector: { ...defaults.collector, ...file.collector, ...(served && { url: served }), dailyCap: { ...defaults.collector.dailyCap, ...file.collector?.dailyCap } },
    lint: { ...defaults.lint, ...file.lint },
    gates: { ...defaults.gates, ...file.gates },
    capture: { ...defaults.capture, ...file.capture, ttlDays: { ...defaults.capture.ttlDays, ...file.capture?.ttlDays } },
    replay: { ...defaults.replay, ...file.replay },
  };
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
