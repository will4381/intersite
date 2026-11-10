// @ts-check
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_ID_PATTERN } from "./shape.mjs";

export const CONFIG_FILE = "intersite.json";

const defaults = {
  collector: { url: "", readTokenEnv: "INTERSITE_READ_TOKEN", ingestTokenEnv: "INTERSITE_INGEST_TOKEN", name: "intersite-collector", dailyCap: { ok: 5000, other: 5000 } },
  lint: { packs: ["tests", "slop"], rules: {}, custom: [], baseline: "lint-baseline.json", extends: ".oxlintrc.json" },
  capture: {
    sample: 0.05,
    maxBodyBytes: 32_768,
    include: ["/**"],
    exclude: [],
    redactKeys: [],
    idPattern: DEFAULT_ID_PATTERN,
    ttlDays: { ok: 14, warn: 90, rejected: 30, error: 90 },
  },
  replay: { target: "http://localhost:8787", adapter: "./intersite.adapter.mjs", modes: ["baseline"], sample: 20 },
};

/**
 * The project's intersite.json with defaults filled in. Sections merge one level deep.
 * @param {string} cwd
 */
export function loadConfig(cwd) {
  const file = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8"));
  if (typeof file.project !== "string" || !/^[a-z0-9-]{1,64}$/.test(file.project)) {
    throw new Error(`${CONFIG_FILE}: "project" must be lowercase letters, digits and dashes`);
  }
  return {
    project: /** @type {string} */ (file.project),
    collector: { ...defaults.collector, ...file.collector, dailyCap: { ...defaults.collector.dailyCap, ...file.collector?.dailyCap } },
    lint: { ...defaults.lint, ...file.lint },
    capture: { ...defaults.capture, ...file.capture, ttlDays: { ...defaults.capture.ttlDays, ...file.capture?.ttlDays } },
    replay: { ...defaults.replay, ...file.replay },
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
