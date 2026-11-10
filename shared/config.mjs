// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { parse } from "yaml";

import { DEFAULT_ID_PATTERN } from "./shape.mjs";

export const CONFIG_FILE = "intersite.yml";
/** JSON is valid YAML, so an older intersite.json loads the same way. */
const CONFIG_FILES = [CONFIG_FILE, "intersite.yaml", "intersite.json"];

/** The config file this project has, or undefined. @param {string} cwd */
export function configPath(cwd) {
  return CONFIG_FILES.map((name) => join(cwd, name)).find((path) => existsSync(path));
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
  lint: { packs: ["tests", "slop", "security", "state"], rules: {}, custom: [], baseline: "intersite-baseline.json", extends: ".oxlintrc.json" },
  gates: {
    base: "origin/main",
    run: ["test-integrity", "duplicates", "new-deps", "artifacts", "unused"],
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
    idPattern: DEFAULT_ID_PATTERN,
    ttlDays: { ok: 14, warn: 90, rejected: 30, error: 90 },
  },
  replay: {
    target: "http://localhost:8787",
    uiTarget: "",
    adapter: "./intersite.adapter.mjs",
    modes: ["baseline"],
    sample: 20,
    shiftDates: true,
  },
};

/** The name in package.json (or the folder's name), reduced to what a project name may contain. @param {string} cwd */
export function projectName(cwd) {
  const manifest = join(cwd, "package.json");
  const named = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).name : undefined;
  const slug = String(named ?? basename(cwd)).toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 64) || "project";
}

/**
 * The project's intersite.yml with defaults filled in. Sections merge one level deep. With no file at all every
 * default applies and the project is named after its package, so each command works in a fresh checkout.
 * @param {string} cwd
 */
export function loadConfig(cwd) {
  const path = configPath(cwd);
  const file = { project: projectName(cwd), ...(path && parse(readFileSync(path, "utf8"))) };
  if (typeof file.project !== "string" || !/^[a-z0-9-]{1,64}$/.test(file.project)) {
    throw new Error(`${CONFIG_FILE}: "project" must be lowercase letters, digits and dashes`);
  }
  return {
    project: /** @type {string} */ (file.project),
    collector: { ...defaults.collector, ...file.collector, dailyCap: { ...defaults.collector.dailyCap, ...file.collector?.dailyCap } },
    lint: { ...defaults.lint, ...file.lint },
    gates: { ...defaults.gates, ...file.gates },
    capture: { ...defaults.capture, ...file.capture, ttlDays: { ...defaults.capture.ttlDays, ...file.capture?.ttlDays } },
    replay: { ...defaults.replay, ...file.replay },
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */

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
