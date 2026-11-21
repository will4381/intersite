// @ts-check
// Whether a newer Intersite release is tagged than the one installed, so `check` can say to upgrade. The tags are read
// with `git ls-remote` at most once a day per project (cached in node_modules/.cache/intersite), never prompting for
// credentials, and any failure (offline, no access) means nothing is said. INTERSITE_NO_UPDATE_CHECK=1 turns it off.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://github.com/will4381/intersite";
const DAY = 24 * 60 * 60 * 1000;

/** The installed version, from Intersite's own package.json. */
export const installed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * A version as numbers to compare: `1.0.0-rc.14` is [1, 0, 0, 14], and a release without a prerelease sorts after
 * every release candidate of it.
 * @param {string} version
 */
function rank(version) {
  const [, major, minor, patch, rc] = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(version) ?? [];
  return major === undefined ? undefined : [Number(major), Number(minor), Number(patch), rc === undefined ? Infinity : Number(rc)];
}

/** Whether version `a` is newer than `b`. @param {string} a @param {string} b */
export function newer(a, b) {
  const [x, y] = [rank(a), rank(b)];
  if (!x || !y) return false;
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
}

/** The newest version tag in `git ls-remote --tags` output. @param {string} out */
function newestTag(out) {
  return out.split("\n").map((line) => line.split("refs/tags/")[1]?.trim()).filter((tag) => tag && rank(tag)).reduce((best, tag) => (!best || newer(tag, best) ? tag : best), "");
}

/** The newest tag on the remote, or undefined after `timeoutMs` or on any failure. @param {number} timeoutMs */
function fetchNewest(timeoutMs) {
  return new Promise((done) => {
    execFile("git", ["ls-remote", "--tags", "--refs", REPO], { timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => done(error ? undefined : newestTag(stdout) || undefined));
  });
}

/**
 * The newest release tag when it is newer than the installed version, else undefined. Reads the day-old cache first;
 * otherwise asks the remote, except in CI or under the test runner, where a network call would only add flakiness.
 * @param {string} cwd @param {number} [timeoutMs]
 * @returns {Promise<string | undefined>}
 */
export async function upgradeAvailable(cwd, timeoutMs = 3000) {
  if (process.env.INTERSITE_NO_UPDATE_CHECK) return undefined;
  const dir = join(cwd, "node_modules", ".cache", "intersite");
  const cache = join(dir, "latest-release.json");
  /** @type {{ checked?: number, tag?: string }} */
  let cached = {};
  try {
    cached = JSON.parse(readFileSync(cache, "utf8"));
  } catch {
    // No cache yet, or a broken one: ask the remote below.
  }
  let tag = cached.checked && Date.now() - cached.checked < DAY ? cached.tag : undefined;
  if (tag === undefined && !process.env.CI && !process.env.NODE_TEST_CONTEXT) {
    tag = await fetchNewest(timeoutMs);
    if (tag && existsSync(join(cwd, "node_modules"))) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cache, JSON.stringify({ checked: Date.now(), tag }));
    }
  }
  return tag && newer(tag, installed) ? tag : undefined;
}
