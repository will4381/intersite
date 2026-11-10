// @ts-check
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { collectorTokens, loadConfig, useServedCollector } from "../shared/config.mjs";

const LOCAL = /^(?:localhost|127\.0\.0\.1)$/;

/**
 * Commands that read cases need a collector. When the configured one is on this machine and not running, this serves
 * the project's own `.intersite/cases.db` for the length of the command, so nobody has to start anything first.
 * Returns a function that stops it; it does nothing when nothing was started.
 * @param {string} cwd
 * @returns {Promise<() => Promise<void>>}
 */
export async function ensureLocalCollector(cwd) {
  const nothing = async () => {};
  let config;
  let url;
  try {
    config = loadConfig(cwd);
    url = new URL(config.collector.url);
  } catch {
    // A broken config is the command's to report, with its own message and exit code.
    return nothing;
  }
  if (!LOCAL.test(url.hostname) || !url.port) return nothing;
  // Any answer means something is already listening there; only a refused connection means nothing is.
  const up = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  if (up) return nothing;

  const { startNodeCollector } = await import("../collector/node.mjs");
  mkdirSync(join(cwd, ".intersite"), { recursive: true });
  const tokens = collectorTokens(config);
  // A free port of its own, not the configured one: two commands at once must not share a collector that the first to
  // finish would stop under the other. SQLite lets each open the same file.
  const options = { port: 0, dbPath: join(cwd, ".intersite/cases.db"), ingestToken: tokens.ingest, readToken: tokens.read, dailyCap: config.collector.dailyCap };
  const running = await startNodeCollector(options);
  useServedCollector(running.url);
  return running.stop;
}
