// @ts-check
// The Rust engine in core/: built with cargo the first time a check needs it (and again when its source changes),
// then called with one JSON request per check. Paths in requests and answers are relative to the repository top.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GateError } from "./lib.mjs";

const crate = fileURLToPath(new URL("../core/", import.meta.url));
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
 * @param {Record<string, unknown>} request
 * @returns {{ findings: { file: string, line: number, target: string, message: string }[], summary: string, data?: any }}
 */
export function runCore(request) {
  const run = spawnSync(ensureCore(), [], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new GateError((run.stderr || `intersite-core exited with ${run.status}`).trim().replace(/^intersite-core: /, ""));
  return JSON.parse(run.stdout);
}
