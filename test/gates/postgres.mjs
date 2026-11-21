// @ts-check
// A throwaway Postgres cluster for tests that need a real planner: initdb into a temporary folder, start it on a free
// port with pg_stat_statements loaded, and remove it afterwards. Undefined when Postgres is not installed.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A free TCP port on 127.0.0.1. */
async function freePort() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
  const address = server.address();
  await new Promise((ok) => server.close(ok));
  return typeof address === "object" && address ? address.port : 0;
}

/** @returns {Promise<{ url: string, psql: (sql: string) => string, stop: () => void } | undefined>} */
export async function tempPostgres() {
  if (spawnSync("initdb", ["--version"]).status !== 0) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "intersite-pg-"));
  const data = join(dir, "data");
  const init = spawnSync("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  const port = await freePort();
  appendFileSync(join(data, "postgresql.conf"), `\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${dir}'\nshared_preload_libraries = 'pg_stat_statements'\nfsync = off\n`);
  const start = spawnSync("pg_ctl", ["-D", data, "-l", join(dir, "log"), "-w", "start"], { encoding: "utf8" });
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr}`);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  return {
    url,
    psql: (sql) => {
      const run = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qAtc", sql], { encoding: "utf8" });
      if (run.status !== 0) throw new Error(`psql failed: ${run.stderr}`);
      return run.stdout.trim();
    },
    stop: () => {
      spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
