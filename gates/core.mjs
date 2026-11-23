// @ts-check
// The Rust engine in core/: built with cargo the first time a check needs it (and again when its source changes),
// then called with one JSON request per check. Paths in requests and answers are relative to the repository top.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { GateError, JS_FILE, NOT_PRODUCT, SKIP, changeOf, listFiles, matches, withStdin } from "./lib.mjs";

const crate = fileURLToPath(new URL("../core/", import.meta.url));
const STALLED = 5 * 60_000;
const binary = join(crate, "target", "release", process.platform === "win32" ? "intersite-core.exe" : "intersite-core");

/** The newest modification time among the crate's sources. */
function sourceTime() {
  const times = [statSync(join(crate, "Cargo.toml")).mtimeMs];
  for (const name of readdirSync(join(crate, "src"))) times.push(statSync(join(crate, "src", name)).mtimeMs);
  return Math.max(...times);
}

/** The engine's path, building it first when it is missing or older than its source. Throws GateError without cargo. */
export function ensureCore() {
  if (existsSync(binary) && statSync(binary).mtimeMs >= sourceTime()) return binary;
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  if (cargo.status !== 0) throw new GateError("this check runs on Intersite's Rust engine: install Rust (https://rustup.rs), then run it again and it builds itself once");
  process.stderr.write("building intersite-core, Intersite's Rust engine (once; a minute or two)\n");
  const build = spawnSync("cargo", ["build", "--release", "--quiet", "--manifest-path", join(crate, "Cargo.toml")], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (build.status !== 0) throw new GateError(`building intersite-core failed: ${build.stderr.trim().split("\n").slice(-5).join(" ")}`);
  return binary;
}

/**
 * Sends one request to the engine and returns its answer.
 * @param {Record<string, unknown>} request @param {{ build?: boolean }} [options]
 * @returns {{ findings: { file: string, line: number, target: string, message: string }[], summary: string, data?: any }}
 */
export function runCore(request, { build = true } = {}) {
  // A check takes seconds; one that stalls is stopped and named instead of hanging `intersite check` with it.
  // Without `build` (the edit hook, which must answer at once) an engine that was never built is an error, not a build.
  const core = build ? ensureCore() : existsSync(binary) ? binary : undefined;
  if (!core) throw new GateError("intersite-core is not built yet");
  const run = withStdin(JSON.stringify(request), (fd) => spawnSync(core, [], { stdio: [fd, "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 30, timeout: build ? STALLED : 10_000 }));
  if (/** @type {NodeJS.ErrnoException | undefined} */ (run.error)?.code === "ETIMEDOUT") throw new GateError(`intersite-core gave no answer to \`${request.command}\` in ${STALLED / 60_000} minutes and was stopped: run it again, and if it stalls again, report it`);
  if (run.status !== 0) throw new GateError((run.stderr || `intersite-core exited with ${run.status}`).trim().replace(/^intersite-core: /, ""));
  return JSON.parse(run.stdout);
}

/**
 * A gate the engine answers by reading every product source file in the repository, reporting only on the lines the
 * change added (or on everything without a base): `regex`, `decisions`. Paths come back relative to the project.
 * With `everyFile`, the engine also gets every other file's path (route files, env templates, configs) and the product
 * code as `options.product`: `routes`, `env`.
 * @param {string} command @param {import("./lib.mjs").GateOptions} options @param {boolean} [everyFile]
 * @returns {import("./lib.mjs").GateResult}
 */
export function productCodeGate(command, { cwd, base, testPaths }, everyFile = false) {
  const { whole, top, prefix, added } = changeOf(cwd, base);
  if (!whole && ![...added.keys()].some((f) => JS_FILE.test(f))) return { findings: [], summary: "no added code" };
  const listed = listFiles(top).filter((f) => !SKIP.test(f));
  const product = listed.filter((f) => JS_FILE.test(f) && !NOT_PRODUCT.test(f) && !matches(f, testPaths));
  const files = everyFile ? listed : product;
  const answer = runCore({ command, root: top, files, added: whole ? undefined : Object.fromEntries(added), prefix, ...(everyFile && { options: { product } }) });
  const name = (/** @type {string} */ file) => posix.relative(prefix || ".", file);
  return { findings: answer.findings.map((f) => ({ ...located(f, name), target: f.target.replace(f.file, name(f.file)), message: f.message.replaceAll(f.file, name(f.file)) })), summary: answer.summary };
}

/**
 * Where an engine finding is, for `--json` and CI annotations: its file as the project names it, and its line.
 * @param {{ file: string, line: number }} finding @param {(file: string) => string} [name] from the engine's path
 * @returns {{ file?: string, line?: number }}
 */
export const located = ({ file, line }, name = (file) => file) => ({ ...(file && { file: name(file) }), ...(line > 0 && { line }) });
