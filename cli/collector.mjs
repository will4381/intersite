// @ts-check
// `intersite collector [--port 8790] [--db .intersite/cases.db]`: the collector on 127.0.0.1 over SQLite, until interrupted.
// The port defaults to the one in a local `collector.url`, so capture and the other commands find it.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { startNodeCollector } from "../collector/node.mjs";
import { LOCAL_HOST } from "../replay/collector.mjs";
import { collectorTokens, loadConfig } from "../shared/config.mjs";

const USAGE = "usage: intersite collector [--port 8790] [--db .intersite/cases.db]";

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function collector(argv, { cwd }) {
  /** @type {import("../shared/config.mjs").Config} */
  let config;
  try {
    config = loadConfig(cwd);
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    return 2;
  }
  const flags = { "--port": localPort(config.collector.url) ?? "8790", "--db": ".intersite/cases.db" };
  for (let i = 0; i < argv.length; i += 2) {
    if (!(argv[i] in flags) || argv[i + 1] === undefined) {
      console.error(USAGE);
      return 2;
    }
    flags[/** @type {keyof typeof flags} */ (argv[i])] = argv[i + 1];
  }
  const port = Number(flags["--port"]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(USAGE);
    return 2;
  }
  const db = flags["--db"];
  const dbPath = db === ":memory:" ? db : resolve(cwd, db);
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const tokens = collectorTokens(config);
  /** @type {Awaited<ReturnType<typeof startNodeCollector>>} */
  let running;
  try {
    running = await startNodeCollector({ port, dbPath, ingestToken: tokens.ingest, readToken: tokens.read, dailyCap: config.collector.dailyCap });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EADDRINUSE") throw error;
    console.error(`port ${port} is already in use: stop what holds it or pass --port <n>`);
    return 2;
  }
  console.log(`ok collector: ${running.url} (db ${db})`);
  await new Promise((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await running.stop();
  return 0;
}

/** The port of a local collector URL, or undefined for a remote or portless one. @param {string} url */
function localPort(url) {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return LOCAL_HOST.test(parsed.hostname) && parsed.port ? parsed.port : undefined;
}
