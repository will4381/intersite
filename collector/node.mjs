// @ts-check
// The same collector Worker in plain Node: node:sqlite behind the slice of the D1 API that store.mjs uses.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

import worker from "./worker.mjs";

const schema = readFileSync(new URL("schema.sql", import.meta.url), "utf8");
const DAY_MS = 86_400_000;

/**
 * D1's prepare/bind/first/all/run/batch/exec over a synchronous SQLite handle. Compiled statements are reused by SQL
 * text; `batch` runs in one transaction, as D1's does.
 * @param {DatabaseSync} sqlite
 */
function d1(sqlite) {
  /** @type {Map<string, import("node:sqlite").StatementSync>} */
  const compiled = new Map();
  // ponytail: unbounded cache keyed by SQL text; the store's IN-lists keep distinct texts to a few hundred, add an LRU if that changes.
  /** @param {string} sql */
  const compile = (sql) => {
    let statement = compiled.get(sql);
    if (!statement) compiled.set(sql, (statement = sqlite.prepare(sql)));
    return statement;
  };
  /** @typedef {import("node:sqlite").SQLInputValue} Value */
  /** @param {string} sql @param {Value[]} params */
  const statement = (sql, params) => ({
    sql,
    params,
    /** @param {Value[]} values */
    bind: (...values) => statement(sql, values),
    // D1 answers null for no row; node:sqlite answers undefined.
    first: async () => compile(sql).get(...params) ?? null,
    all: async () => ({ success: true, results: compile(sql).all(...params), meta: {} }),
    run: async () => ({ success: true, results: [], meta: { changes: Number(compile(sql).run(...params).changes) } }),
  });
  return {
    /** @param {string} sql */
    prepare: (sql) => statement(sql, []),
    /** @param {string} sql */
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    /** Synchronous inside, so no other request can interleave with the open transaction. @param {ReturnType<typeof statement>[]} statements */
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, params }) => ({ success: true, results: compile(sql).all(...params), meta: {} }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/**
 * Serves worker.mjs on 127.0.0.1 over a SQLite file (or `:memory:`). Cleanup runs on start and then daily.
 * `cleanup(time)` runs it on demand, like miniflare's `/cdn-cgi/local/scheduled`.
 * @param {{ port?: number, dbPath?: string, ingestToken: string, readToken: string, dailyCap?: { ok?: number, other?: number } }} options
 */
export async function startNodeCollector({ port = 0, dbPath = ":memory:", ingestToken, readToken, dailyCap }) {
  const sqlite = new DatabaseSync(dbPath);
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      // ponytail: body buffered whole with no size limit; the server only listens on 127.0.0.1.
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: /** @type {Record<string, string>} */ (req.headers),
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(/** @type {Error} */ (error).message) }));
    }
  });
  const db = d1(sqlite);
  const env = {
    DB: db,
    INGEST_TOKEN: ingestToken,
    READ_TOKEN: readToken,
    DAILY_CAP_OK: String(dailyCap?.ok ?? 5000),
    DAILY_CAP_OTHER: String(dailyCap?.other ?? 5000),
  };
  const cleanup = (time = Date.now()) => worker.scheduled({ scheduledTime: time }, env);
  try {
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    await db.exec(schema);
    await cleanup();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(undefined));
    });
  } catch (error) {
    sqlite.close();
    throw error;
  }
  // oxlint-disable-next-line intersite/no-log-and-continue -- a timer has no caller; the next day's run retries, and throwing would kill the server.
  const timer = setInterval(() => cleanup().catch((error) => console.error(`collector cleanup failed: ${error.message}`)), DAY_MS);
  timer.unref();
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    cleanup,
    /** Finishes in-flight requests, then closes the database. */
    stop: async () => {
      clearInterval(timer);
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
      sqlite.close();
    },
  };
}
