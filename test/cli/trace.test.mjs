// @ts-check
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import trace from "../../cli/trace.mjs";
import { repo } from "../gates/repo.mjs";
import { tempPostgres } from "../gates/postgres.mjs";

/** @param {string} cwd @param {string[]} args */
async function run(cwd, args) {
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const { log, error } = console;
  console.log = (/** @type {string} */ line) => out.push(...String(line).split("\n"));
  console.error = (/** @type {string} */ line) => err.push(String(line));
  try {
    return { code: await trace(args, { cwd }), out, err };
  } finally {
    Object.assign(console, { log, error });
  }
}

/** A free port, by listening on 0 and closing. */
async function freePort() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
  const address = server.address();
  await new Promise((ok) => server.close(ok));
  return typeof address === "object" && address ? address.port : 0;
}

const work = (/** @type {number} */ n) => `function work(n) {\n  let total = 0;\n  for (let i = 0; i < n; i++) total += Math.sqrt(i);\n  return total;\n}\nfunction idle() { return 1; }\nconsole.log(work(${n}));\n`;

test("a command's run lists the project functions it touched and its slowest, and against the base names what got slower", async () => {
  const r = repo({ "slow.js": work(100_000) });
  r.write({ "slow.js": work(30_000_000) });
  const { code, out } = await run(r.cwd, ["--runs", "1", "--base", "base", "--touched", "--", "node", "slow.js"]);
  assert.equal(code, 1);
  assert.match(out[0], /^trace `node slow\.js`: \S+ \(base \S+, \+\d+%\)$/);
  assert.ok(out.includes("touched 1 functions in 1 project files:"), out.join("\n"));
  assert.ok(out.includes("  slow.js:1 work ×1"), out.join("\n"));
  assert.ok(out.some((line) => /^\s+\S+ {2}slow\.js:1 work$/.test(line)), out.join("\n"));
  assert.ok(out.some((line) => /^slow\.js:1 work takes \d+ms of its own time, (?:\d+ms on the base \(\+\d+%\)|under 1ms on the base): profile it/.test(line)), out.join("\n"));
});

test("a server's requests are each measured on their own, with the handler that served them", async () => {
  const port = await freePort();
  const server = `import { createServer } from "node:http";\nfunction handleSlow(res) {\n  let s = 0;\n  for (let i = 0; i < 20000000; i++) s += i % 7;\n  res.end(String(s));\n}\nfunction handleFast(res) { res.end("ok"); }\ncreateServer((req, res) => (req.url === "/slow" ? handleSlow(res) : handleFast(res))).listen(${port}, "127.0.0.1");\n`;
  const r = repo({ "server.mjs": server });
  const { code, out } = await run(r.cwd, ["--server", "node server.mjs", "--url", `http://127.0.0.1:${port}`, "--request", "GET /slow", "--request", "GET /", "--runs", "2", "--touched"]);
  assert.equal(code, 0, out.join("\n"));
  const slow = out.indexOf(out.find((l) => l.startsWith("trace GET /slow: median of 2 runs")) ?? "");
  const fast = out.indexOf(out.find((l) => l.startsWith("trace GET /: median of 2 runs")) ?? "");
  assert.ok(slow >= 0 && fast > slow, out.join("\n"));
  assert.ok(out.slice(slow, fast).includes("  server.mjs:2 handleSlow ×1"), out.join("\n"));
  assert.ok(!out.slice(slow, fast).some((l) => l.includes("handleFast")), "a request's trace holds only what it ran");
  assert.ok(out.slice(fast).includes("  server.mjs:7 handleFast ×1"), out.join("\n"));
});

test("a page's load gives its web vitals and the project scripts it ran", async (t) => {
  const r = repo({
    "index.html": '<!doctype html><title>t</title><h1>Hello</h1><script src="/app.js"></script>\n',
    "app.js": "function paintList() {\n  let s = 0;\n  for (let i = 0; i < 5000000; i++) s += i % 3;\n  document.body.append(String(s));\n}\npaintList();\n",
  });
  const server = createServer((req, res) => {
    const file = req.url === "/app.js" ? "app.js" : "index.html";
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(readFileSync(join(r.cwd, file)));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
  t.after(() => server.close());
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const result = await run(r.cwd, ["--page", `http://127.0.0.1:${address.port}/`, "--touched"]).catch((error) => ({ code: -1, out: [], err: [String(error)] }));
  if (result.err.some((e) => /Chrome|playwright/.test(e))) return t.skip(`no Chrome to drive: ${result.err.join(" ")}`);
  assert.equal(result.code, 0, [...result.out, ...result.err].join("\n"));
  assert.ok(result.out.some((l) => /^vitals: TTFB \S+, FCP \S+, LCP \S+, CLS [\d.]+, blocking \S+ in \d+ long tasks, \d+ requests, \d+ KB$/.test(l)), result.out.join("\n"));
  assert.ok(result.out.includes("  app.js:1 paintList ×1"), result.out.join("\n"));
});

test("with INTERSITE_DATABASE_URL, the queries a run sent are listed slowest first with the index to add", async (t) => {
  const pg = await tempPostgres();
  if (!pg) return t.skip("Postgres (initdb) is not installed");
  t.after(pg.stop);
  pg.psql("CREATE EXTENSION pg_stat_statements; CREATE TABLE orders (id serial PRIMARY KEY, customer_id int, total int); INSERT INTO orders (customer_id, total) SELECT g % 500, g FROM generate_series(1, 20000) g; ANALYZE orders;");
  const r = repo({ "q.sql": "SELECT sum(total) FROM orders WHERE customer_id = 7;\n" });
  process.env.INTERSITE_DATABASE_URL = pg.url;
  t.after(() => delete process.env.INTERSITE_DATABASE_URL);
  const { code, out } = await run(r.cwd, ["--", `psql "${pg.url}" -qAt -f q.sql -f q.sql -f q.sql`]);
  assert.equal(code, 0, out.join("\n"));
  const at = out.indexOf("database, slowest first (pg_stat_statements):");
  assert.ok(at > 0, out.join("\n"));
  const line = out.slice(at + 1).find((l) => l.includes("FROM orders WHERE customer_id = $1"));
  assert.match(line ?? "", /^\s+\S+ {2}3× SELECT sum\(total\) FROM orders WHERE customer_id = \$1$/);
  assert.match(out[out.indexOf(line ?? "") + 1] ?? "", /^\s+Seq Scan on orders \(~20000 rows\): CREATE INDEX CONCURRENTLY ON orders \(customer_id\)$/);
});
