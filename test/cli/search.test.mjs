// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";

import search from "../../cli/search.mjs";
import { repo } from "../gates/repo.mjs";

/** Runs `intersite search` and collects what it prints. @param {string} cwd @param {string[]} args */
async function run(cwd, args) {
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const { log, error } = console;
  console.log = (/** @type {string} */ line) => out.push(line);
  console.error = (/** @type {string} */ line) => err.push(line);
  try {
    return { code: await search(args, { cwd }), out, err };
  } finally {
    Object.assign(console, { log, error });
  }
}

/** Writes code to a file outside any repository, as a query. @param {string} code */
function queryFile(code) {
  const path = join(mkdtempSync(join(tmpdir(), "intersite-search-")), "query.ts");
  writeFileSync(path, code);
  return path;
}

const groupBy = `export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === undefined) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
`;
const slugify = `export function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`;
const report = `import { formatMoney } from "./money";

export async function monthlyReport(db, month) {
  const rows = await db.orders.findMany({ where: { month } });
  const byCustomer = new Map();
  for (const row of rows) {
    const id = row.customerId;
    const bucket = byCustomer.get(id);
    if (bucket) bucket.push(row);
    else byCustomer.set(id, [row]);
  }
  const lines = [];
  for (const [customer, orders] of byCustomer) {
    const total = orders.reduce((sum, order) => sum + order.amount, 0);
    lines.push(\`\${customer}: \${formatMoney(total)}\`);
  }
  return lines.join("\\n");
}
`;

test("a renamed, partial snippet finds the function holding it, and the function it was pasted into", async () => {
  const r = repo({ "src/lib/collections.js": groupBy, "src/lib/text.js": slugify, "src/reports/monthly.js": report });
  const query = queryFile(`const buckets = new Map();
for (const entry of entries) {
  const k = pick(entry);
  const found = buckets.get(k);
  if (found) found.push(entry);
  else buckets.set(k, [entry]);
}
`);
  const { code, out } = await run(r.cwd, [query]);
  assert.equal(code, 0);
  assert.deepEqual(out.map((line) => line.replace(/\d+%/, "N%")).sort(), [
    "src/lib/collections.js:1 groupBy: N% of the query, at lines 2-8",
    "src/reports/monthly.js:3 monthlyReport: N% of the query, at lines 5-13",
  ]);
});

test("a line names the function around it, which is never its own match", async () => {
  const r = repo({ "src/lib/collections.js": groupBy, "src/reports/monthly.js": report, "src/lib/text.js": slugify });
  const { out } = await run(r.cwd, ["src/lib/collections.js:6", "--json"]);
  const result = JSON.parse(out[0]);
  assert.deepEqual([result.query.from, result.query.to], [1, 11]);
  assert.deepEqual(result.matches.map((/** @type {any} */ m) => `${m.file}:${m.name}`), ["src/reports/monthly.js:monthlyReport"]);
});

test("code nothing resembles gets one ok line, and an unreadable query is a setup error", async () => {
  const r = repo({ "src/lib/collections.js": groupBy });
  assert.deepEqual((await run(r.cwd, ["src/lib/collections.js:1-1"])).out, ["ok search: none of 1 functions holds 50% of the query"]);
  const missing = await run(r.cwd, ["src/nope.js:3"]);
  assert.equal(missing.code, 2);
  assert.match(missing.err[0], /^search: cannot read src\/nope\.js/);
});

test("half of a function's statements finds that function first, across Intersite's own source", async (t) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const files = ["gates", "cli", "replay"].flatMap((dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".mjs")).map((f) => `${dir}/${f}`));
  /** @type {{ file: string, line: number, code: string }[]} */
  const queries = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const visit = (/** @type {any} */ node) => {
      if (/Function/.test(node.type) && node.body?.type === "BlockStatement" && node.body.body.length >= 6) {
        const body = node.body.body;
        const half = body.slice(0, Math.ceil(body.length / 2));
        queries.push({ file, line: text.slice(0, node.start).split("\n").length, code: text.slice(half[0].start, half.at(-1).end) });
      }
      for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) if (typeof child?.type === "string") visit(child);
    };
    visit(parseSync(file, text).program);
  }
  // Every third, so the test stays a few seconds; the first run also writes the feature cache.
  const sample = queries.filter((_, i) => i % 3 === 0);
  let found = 0;
  for (const q of sample) {
    const { out } = await run(root, [queryFile(q.code), "--json", "--max", "1"]);
    const [top] = JSON.parse(out[0]).matches;
    // A callback has no name: the named function around it is the right answer.
    if (top?.file === q.file && top.line <= q.line && q.line <= top.endLine) found++;
  }
  t.diagnostic(`recall@1 ${found}/${sample.length}`);
  assert.ok(sample.length >= 30, `only ${sample.length} queries`);
  assert.ok(found / sample.length >= 0.9, `recall@1 ${found}/${sample.length}`);
});
