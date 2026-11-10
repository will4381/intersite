// @ts-check
// A real collector on localhost: the Worker in workerd (via miniflare, which wrangler ships) with an in-memory D1.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const schema = readFileSync(new URL("schema.sql", import.meta.url), "utf8");
/** wrangler.jsonc holds the one compatibility date; cli/deploy.mjs reads it the same way. */
const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(readFileSync(new URL("wrangler.jsonc", import.meta.url), "utf8"))?.[1];

/**
 * Starts a collector with a fresh, empty database. `dailyCap` overrides the 5000-per-class default.
 * `GET /cdn-cgi/local/scheduled` runs the daily cleanup on demand (`?time=<epoch ms>` sets the run time).
 * @param {{ port?: number, dailyCap?: { ok?: number, other?: number } }} [options]
 */
export async function startLocalCollector({ port, dailyCap } = {}) {
  const ingestToken = randomBytes(24).toString("base64url");
  const readToken = randomBytes(24).toString("base64url");
  // Wrangler 4.159 ships miniflare 5, whose native options differ; wrangler itself builds them with this converter.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
    workers: [
      {
        // Listed by hand: miniflare 5 does not follow the imports. Entry first.
        modules: ["worker.mjs", "store.mjs", "../shared/case.mjs"].map((file) => ({
          type: /** @type {const} */ ("ESModule"),
          path: fileURLToPath(new URL(file, import.meta.url)),
        })),
        modulesRoot: fileURLToPath(new URL("..", import.meta.url)),
        compatibilityDate,
        d1Databases: { DB: "intersite-local" }, // no d1Persist: in memory, gone on stop
        bindings: {
          INGEST_TOKEN: ingestToken,
          READ_TOKEN: readToken,
          DAILY_CAP_OK: String(dailyCap?.ok ?? 5000),
          DAILY_CAP_OTHER: String(dailyCap?.other ?? 5000),
        },
      },
    ],
    host: "127.0.0.1",
    port: port ?? 0,
    unsafeTriggerHandlers: true,
    }),
  );
  try {
    const url = await mf.ready;
    const db = await mf.getD1Database("DB");
    const statements = schema
      .replace(/--.*$/gm, "")
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean);
    await db.batch(statements.map((sql) => db.prepare(sql)));
    return { url: url.origin, ingestToken, readToken, stop: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
