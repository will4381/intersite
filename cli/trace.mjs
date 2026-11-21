// @ts-check
// `intersite trace`: run something and see every project function it touched and where its time went, from V8's own
// coverage and CPU profiler, before shipping. Three ways to run it:
//   intersite trace [--runs <n>] [--base <ref>] -- <command>          a test, script or job, every Node process in it
//   intersite trace --server "<command>" --url <origin> (--request "<METHOD> <path>"... | --requests <file> | --replay)
//                                                                     each request to a server it starts, one by one
//   intersite trace --page <url> [--compare <url>]                    a page in Chrome: web vitals, JS run, CPU
// With --base the same run happens on the base commit (in a worktree) and functions that got clearly slower are
// reported, exiting 1. With INTERSITE_DATABASE_URL set, the queries the run sent (pg_stat_statements) are listed with
// their time and the planner's verdict. The numbers are crunched by the Rust engine (core/trace.rs).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runCore } from "../gates/core.mjs";
import { GateError, killGroup, projectPrefix, resolveBase, topLevel, withWorktree } from "../gates/lib.mjs";
import { collectorTokens, loadConfig } from "../shared/config.mjs";

const usage = 'usage: intersite trace [--runs <n>] [--base <ref>] [--touched] [--json] -- <command> | --server "<command>" --url <origin> (--request "<METHOD> <path>"... | --requests <file> | --replay [--sample <n>]) | --page <url> [--compare <url>]';
const options = /** @type {const} */ ({
  runs: { type: "string" }, base: { type: "string" }, touched: { type: "boolean" }, json: { type: "boolean" }, setup: { type: "string" },
  server: { type: "string" }, url: { type: "string" }, request: { type: "string", multiple: true }, requests: { type: "string" },
  replay: { type: "boolean" }, sample: { type: "string" }, seed: { type: "string" }, page: { type: "string" }, compare: { type: "string" },
  headed: { type: "boolean" }, "min-ms": { type: "string" }, verbose: { type: "boolean" },
});

/**
 * @typedef {{ coverageDir?: string, profileDir?: string, profiles?: unknown[], coverage?: unknown[], wallMs: number }} Run
 * @typedef {{ touched: { file: string, name: string, line: number, count: number }[], hot: { file: string, name: string, line: number, selfMs: number, totalMs: number }[], dependencies: { name: string, selfMs: number }[], slower: { file: string, name: string, line: number, baseMs: number, nowMs: number }[], inconclusive?: { file: string, name: string, line: number, baseMs: number, nowMs: number }[], wallMs: number, wallRange?: number[], baseWallMs: number, baseWallRange?: number[] }} Report
 */

/** @param {string[]} argv @param {{ cwd: string }} context @returns {Promise<number>} */
export default async function trace(argv, { cwd }) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    console.error(`${/** @type {Error} */ (error).message.split("\n")[0]}; ${usage}`);
    return 2;
  }
  const { values: flags, positionals } = parsed;
  const runs = Number(flags.runs ?? (flags.base ? 3 : 1));
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    console.error(`--runs must be 1 to 20; ${usage}`);
    return 2;
  }
  try {
    if (flags.page) return await pageMode(flags.page, { cwd, flags, runs });
    if (flags.server) return await serverMode(flags.server, { cwd, flags, runs });
    if (!positionals.length) throw new GateError(usage);
    return await commandMode(positionals.join(" "), { cwd, flags, runs });
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`trace: ${error.message}`);
    return 2;
  }
}

/**
 * Runs a shell command with every Node process in it writing coverage and a CPU profile.
 * @param {string} command @param {string} dir @param {boolean} verbose @returns {Run & { code: number, tail: string }}
 */
function profiled(command, dir, verbose) {
  const out = mkdtempSync(join(tmpdir(), "intersite-trace-"));
  const env = { ...process.env, NODE_V8_COVERAGE: join(out, "coverage"), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --cpu-prof --cpu-prof-dir=${join(out, "profiles")}`.trim() };
  delete env.NODE_TEST_CONTEXT;
  const started = performance.now();
  const run = spawnSync(command, { cwd: dir, env, shell: true, stdio: verbose ? "inherit" : "pipe", encoding: "utf8", maxBuffer: 1 << 28 });
  const wallMs = performance.now() - started;
  const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
  return { coverageDir: join(out, "coverage"), profileDir: join(out, "profiles"), wallMs, code: run.status ?? 1, tail };
}

/** @param {string} command @param {{ cwd: string, flags: Record<string, any>, runs: number }} options */
async function commandMode(command, { cwd, flags, runs }) {
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  /** @type {(Run & { code: number, tail: string })[]} */
  const now = [];
  /** @type {Run[]} */
  const baseRuns = [];
  let baseRoot = "";
  // The database is read around the first run only: later base runs would mix their queries in.
  const stats = await sqlSnapshot();
  now.push(profiled(command, cwd, flags.verbose));
  const queries = await sqlSince(stats);
  if (flags.base) {
    const config = loadConfig(cwd);
    const sha = resolveBase(cwd, flags.base);
    // Base and change alternate, so a machine that warms up, throttles or gets busy halfway weighs on both alike.
    await withWorktree({ cwd, ref: sha, setup: flags.setup ?? config.gates.setup, overlay: [] }, async (tree) => {
      baseRoot = tree;
      for (let i = 0; i < runs; i++) {
        baseRuns.push(profiled(command, join(tree, prefix), flags.verbose));
        if (i > 0) now.push(profiled(command, cwd, flags.verbose));
      }
    });
  } else {
    for (let i = 1; i < runs; i++) now.push(profiled(command, cwd, flags.verbose));
  }
  const failed = now.find((r) => r.code !== 0);
  if (failed) console.error(`note: \`${command}\` exited with ${failed.code}; the trace covers what ran\n${failed.tail}`);
  const report = crunch({ top, prefix, now, baseRuns, baseRoot, minMs: flags["min-ms"] });
  print({ title: `\`${command}\``, report: report.data, findings: report.findings, runs, queries, flags });
  for (const r of [...now, ...baseRuns]) rmSync(join(String(r.coverageDir), ".."), { recursive: true, force: true });
  return report.findings.length ? 1 : 0;
}

/**
 * The Rust engine's report for runs (and base runs), paths relative to the project.
 * @param {{ top: string, prefix: string, now: Run[], baseRuns: Run[], baseRoot: string, minMs?: string }} input
 * @returns {{ data: Report, findings: { target: string, message: string }[] }}
 */
function crunch({ top, prefix, now, baseRuns, baseRoot, minMs }) {
  const strip = (/** @type {Run} */ r) => ({ coverageDir: r.coverageDir, profileDir: r.profileDir, profiles: r.profiles ?? [], coverage: r.coverage ?? [], wallMs: r.wallMs });
  const answer = runCore({ command: "trace-report", root: top, prefix, options: { runs: now.map(strip), baseRuns: baseRuns.map(strip), baseRoot: baseRoot || undefined, ...(minMs && { minMs: Number(minMs) }) } });
  const rel = (/** @type {string} */ file) => (prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file);
  /** @type {Report} */
  const data = answer.data;
  for (const list of [data.touched, data.hot, data.slower, data.inconclusive ?? []]) for (const item of list) item.file = rel(item.file);
  return { data, findings: answer.findings.map((f) => ({ target: rel(f.target), message: rel(f.message) })) };
}

/** @param {number} ms */
const time = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

/**
 * @param {{ title: string, report: Report, findings: { message: string }[], runs: number, queries?: SqlLine[], flags: Record<string, any>, extra?: string[] }} input
 */
function print({ title, report, findings, runs, queries = [], flags, extra = [] }) {
  if (flags.json) {
    console.log(JSON.stringify({ ...report, findings, queries }));
    return;
  }
  const range = (/** @type {number[] | undefined} */ r) => (runs > 1 && r && r[1] > r[0] ? ` (${time(r[0])}–${time(r[1])})` : "");
  // Overlapping ranges: some base run was as slow as some run of the change, so the medians may differ by noise.
  const overlap = report.baseWallMs && runs > 1 && report.wallRange && report.baseWallRange && report.wallRange[0] <= report.baseWallRange[1] && report.baseWallRange[0] <= report.wallRange[1];
  const base = report.baseWallMs ? ` (base ${time(report.baseWallMs)}${range(report.baseWallRange)}, ${report.wallMs >= report.baseWallMs ? "+" : ""}${Math.round(((report.wallMs - report.baseWallMs) / report.baseWallMs) * 100)}%${overlap ? ", ranges overlap: within noise" : ""})` : "";
  console.log(`trace ${title}: ${runs > 1 ? `median of ${runs} runs ` : ""}${time(report.wallMs)}${range(report.wallRange)}${base}`);
  for (const line of extra) console.log(line);
  const files = new Set(report.touched.map((t) => t.file)).size;
  console.log(`touched ${report.touched.length} functions in ${files} project files${flags.touched ? ":" : " (--touched lists them)"}`);
  if (flags.touched) for (const t of report.touched) console.log(`  ${t.file}:${t.line} ${t.name} ×${t.count}`);
  const hot = report.hot.filter((h) => h.selfMs >= 1).slice(0, 15);
  if (hot.length) console.log("own time, slowest first:");
  for (const h of hot) console.log(`  ${time(h.selfMs).padStart(7)}  ${h.file}:${h.line} ${h.name}${h.totalMs > h.selfMs * 1.5 ? ` (${time(h.totalMs)} with what it calls)` : ""}`);
  const deps = report.dependencies.filter((d) => d.selfMs >= 5).slice(0, 6);
  if (deps.length) console.log(`in dependencies: ${deps.map((d) => `${d.name} ${time(d.selfMs)}`).join(", ")}`);
  if (queries.length) console.log("database, slowest first (pg_stat_statements):");
  for (const q of queries) console.log(`  ${time(q.totalMs).padStart(7)}  ${q.calls}× ${q.query.replace(/\s+/g, " ").slice(0, 110)}${q.advice ? `\n           ${q.advice}` : ""}`);
  for (const f of findings) console.log(f.message);
  const unsure = report.inconclusive ?? [];
  if (unsure.length) console.log(`inconclusive: ${unsure.slice(0, 3).map((u) => `${u.name} (${time(u.baseMs)} → ${time(u.nowMs)})`).join(", ")}${unsure.length > 3 ? ` and ${unsure.length - 3} more` : ""} slower by median, but a base run was as slow as the fastest run now; rerun with more --runs to tell`);
  if (report.baseWallMs && !findings.length) console.log("ok trace: nothing clearly slower than the base");
}

/** @typedef {{ query: string, calls: number, totalMs: number, advice?: string }} SqlLine */

/** pg_stat_statements before a run, when INTERSITE_DATABASE_URL is set and the extension is there. */
async function sqlSnapshot() {
  const url = process.env.INTERSITE_DATABASE_URL;
  if (!url) return undefined;
  try {
    return runCore({ command: "pg-stats", databaseUrl: url }).data;
  } catch (error) {
    console.error(`note: no database timings: ${/** @type {Error} */ (error).message}`);
    return undefined;
  }
}

/**
 * The queries a run sent: pg_stat_statements now minus before, slowest first, each planned for an index to add.
 * @param {any} before @returns {Promise<SqlLine[]>}
 */
async function sqlSince(before) {
  if (!before) return [];
  const url = process.env.INTERSITE_DATABASE_URL;
  const answer = runCore({ command: "pg-stats", databaseUrl: url, options: { before } });
  return answer.data.since ?? [];
}

/**
 * A minimal Chrome DevTools Protocol client over the global WebSocket, for a Node process's inspector.
 * @param {string} url
 */
async function devtools(url) {
  const socket = new WebSocket(url);
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", () => fail(new GateError(`cannot reach the inspector at ${url}`)), { once: true });
  });
  let id = 0;
  /** @type {Map<number, { ok: (v: any) => void, fail: (e: Error) => void }>} */
  const waiting = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const wait = waiting.get(message.id);
    if (!wait) return;
    waiting.delete(message.id);
    if (message.error) wait.fail(new GateError(`inspector: ${message.error.message}`));
    else wait.ok(message.result);
  });
  return {
    /** @param {string} method @param {Record<string, unknown>} [params] @returns {Promise<any>} */
    send(method, params = {}) {
      const call = ++id;
      socket.send(JSON.stringify({ id: call, method, params }));
      return new Promise((ok, fail) => waiting.set(call, { ok, fail }));
    },
    close: () => socket.close(),
  };
}

/**
 * Starts a server with the inspector on in every Node process it starts, and waits until `url` answers.
 * @param {string} command @param {string} dir @param {string} url
 */
async function startServer(command, dir, url) {
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --inspect=127.0.0.1:0`.trim() };
  const child = spawn(command, { cwd: dir, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  /** @type {string[]} */
  const sockets = [];
  let output = "";
  const read = (/** @type {Buffer} */ chunk) => {
    output = (output + chunk).slice(-4000);
    for (const m of String(chunk).matchAll(/Debugger listening on (ws:\/\/\S+)/g)) sockets.push(m[1]);
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  const stop = () => killGroup(/** @type {number} */ (child.pid));
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new GateError(`the server exited with ${child.exitCode} before answering:\n${output.trim().split("\n").slice(-8).join("\n")}`);
    const up = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (up && sockets.length) break;
    if (Date.now() > deadline) {
      stop();
      throw new GateError(`${url} did not answer within 2 minutes of starting \`${command}\``);
    }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  const inspectors = [];
  for (const socket of sockets) {
    let tool;
    try {
      tool = await devtools(socket);
    } catch {
      // A wrapper process (npm, a watcher) can exit once it has started the server; its inspector is gone, and the
      // server's own inspector is in the list too.
      continue;
    }
    await tool.send("Profiler.enable");
    await tool.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    inspectors.push(tool);
  }
  return {
    /**
     * Runs `act` with coverage reset before and a CPU profile around it, in every process.
     * @param {() => Promise<unknown>} act @returns {Promise<Run>}
     */
    async measure(act) {
      for (const tool of inspectors) {
        await tool.send("Profiler.takePreciseCoverage");
        await tool.send("Profiler.start");
      }
      const started = performance.now();
      await act();
      const wallMs = performance.now() - started;
      const profiles = [];
      const coverage = [];
      for (const tool of inspectors) {
        profiles.push((await tool.send("Profiler.stop")).profile);
        coverage.push((await tool.send("Profiler.takePreciseCoverage")).result);
      }
      return { profiles, coverage, wallMs };
    },
    stop() {
      for (const tool of inspectors) tool.close();
      stop();
    },
  };
}

/**
 * The requests to measure: --request lines, a --requests file of the same lines, as `{ label, send }`.
 * @param {Record<string, any>} flags @param {string} cwd @param {string} origin
 */
function plainRequests(flags, cwd, origin) {
  const lines = [...(flags.request ?? []), ...(flags.requests ? readFileSync(resolve(cwd, flags.requests), "utf8").split("\n") : [])].map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.map((line) => {
    const [method, path, ...rest] = line.split(/\s+/);
    const body = rest.join(" ") || undefined;
    if (!path?.startsWith("/")) throw new GateError(`a request is "<METHOD> /path [json body]", got "${line}"`);
    const init = { method: method.toUpperCase(), body, headers: body ? { "content-type": "application/json" } : undefined };
    return { label: `${init.method} ${path}`, send: () => fetch(origin + path, init).then((r) => r.arrayBuffer()) };
  });
}

/**
 * Measures each request `runs` times after one warm-up, against a server already started.
 * @param {Awaited<ReturnType<typeof startServer>>} server
 * @param {{ label: string, send: () => Promise<unknown> }[]} requests @param {number} runs
 */
async function measureRequests(server, requests, runs) {
  /** @type {Map<string, Run[]>} */
  const byLabel = new Map();
  for (const request of requests) {
    // One warm-up, so the first measured run does not pay for lazy loading and JIT compilation.
    await request.send();
    const list = byLabel.get(request.label) ?? [];
    for (let i = 0; i < runs; i++) list.push(await server.measure(request.send));
    byLabel.set(request.label, list);
  }
  return byLabel;
}

/**
 * Recorded production sessions, replayed through the project's adapter with every request measured on its own.
 * @param {Awaited<ReturnType<typeof startServer>>} server @param {string} cwd @param {string} origin @param {Record<string, any>} flags
 * @returns {Promise<Map<string, Run[]>>}
 */
async function measureReplay(server, cwd, origin, flags) {
  const { named, pickSessions } = await import("./replay.mjs");
  const { replaySessions } = await import("../replay/run.mjs");
  const config = loadConfig(cwd);
  const adapter = named(await import(pathToFileURL(resolve(cwd, config.replay.adapter)).href), config.replay.adapter);
  const collector = { url: config.collector.url, token: collectorTokens(config).read, project: config.project };
  const { sessions } = await pickSessions({ sample: flags.sample ?? "20", seed: flags.seed }, "20", collector, undefined);
  /** @type {Map<string, Run[]>} */
  const byLabel = new Map();
  /** @type {typeof fetch} */
  const measuredFetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    /** @type {Response | undefined} */
    let response;
    const run = await server.measure(async () => {
      response = await fetch(input, init);
      await response.clone().arrayBuffer();
    });
    if (url.origin === new URL(origin).origin) {
      const label = `${init?.method ?? "GET"} ${url.pathname.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id").replace(/\/\d+(?=\/|$)/g, "/:id")}`;
      byLabel.set(label, [...(byLabel.get(label) ?? []), run]);
    }
    return /** @type {Response} */ (response);
  };
  await replaySessions({ sessions, target: origin, adapter, modes: ["baseline"], idPattern: config.capture.idPattern, fetch: measuredFetch, cwd });
  return byLabel;
}

/** @param {string} command @param {{ cwd: string, flags: Record<string, any>, runs: number }} options */
async function serverMode(command, { cwd, flags, runs }) {
  if (!flags.url) throw new GateError("--server needs --url, the origin it serves (http://localhost:3000)");
  const origin = new URL(flags.url).origin;
  if (!flags.replay && !flags.request && !flags.requests) throw new GateError('--server needs requests to send: --request "GET /api/x", --requests <file>, or --replay');
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  const session = async (/** @type {string} */ dir) => {
    const server = await startServer(command, dir, flags.url);
    try {
      return flags.replay ? await measureReplay(server, cwd, origin, flags) : await measureRequests(server, plainRequests(flags, cwd, origin), runs);
    } finally {
      server.stop();
    }
  };
  const stats = await sqlSnapshot();
  const now = await session(cwd);
  const queries = await sqlSince(stats);
  /** @type {Map<string, Run[]>} */
  let base = new Map();
  let baseRoot = "";
  if (flags.base) {
    const config = loadConfig(cwd);
    await withWorktree({ cwd, ref: resolveBase(cwd, flags.base), setup: flags.setup ?? config.gates.setup, overlay: [] }, async (tree) => {
      baseRoot = tree;
      base = await session(join(tree, prefix));
    });
  }
  let slower = 0;
  const all = [...now.values()].flat();
  for (const [label, runsOf] of now) {
    const report = crunch({ top, prefix, now: runsOf, baseRuns: base.get(label) ?? [], baseRoot, minMs: flags["min-ms"] });
    slower += report.findings.length;
    print({ title: label, report: report.data, findings: report.findings, runs: runsOf.length, flags: { ...flags, touched: flags.touched } });
  }
  if (now.size > 1 && !flags.json) {
    const whole = crunch({ top, prefix, now: [{ profiles: all.flatMap((r) => r.profiles ?? []), coverage: all.flatMap((r) => r.coverage ?? []), wallMs: all.reduce((s, r) => s + r.wallMs, 0) }], baseRuns: [], baseRoot: "" });
    print({ title: `all ${now.size} requests`, report: whole.data, findings: [], runs: 1, queries, flags });
  }
  return slower ? 1 : 0;
}

/** Collects web vitals in the page as it loads: LCP, CLS, long tasks, paints. */
const VITALS = `(() => {
  const v = window.__intersiteVitals = { lcp: 0, cls: 0, tbt: 0, longTasks: 0, fcp: 0 };
  const watch = (type, f) => { try { new PerformanceObserver((l) => l.getEntries().forEach(f)).observe({ type, buffered: true }); } catch {} };
  watch("largest-contentful-paint", (e) => { v.lcp = e.startTime; });
  watch("layout-shift", (e) => { if (!e.hadRecentInput) v.cls += e.value; });
  watch("longtask", (e) => { v.longTasks++; v.tbt += Math.max(0, e.duration - 50); });
  watch("paint", (e) => { if (e.name === "first-contentful-paint") v.fcp = e.startTime; });
})()`;

/**
 * Loads a page once in a fresh context: vitals, the JS it ran (mapped to project files by URL path) and a CPU profile.
 * @param {import("playwright-core").Browser} browser @param {string} url @param {string} top
 */
async function loadPage(browser, url, top) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(VITALS);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    await cdp.send("Profiler.start");
    const started = performance.now();
    // networkidle: no request for half a second, so late scripts and images have run and painted.
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    const wallMs = performance.now() - started;
    const vitals = await page.evaluate(() => {
      const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType("navigation")[0]);
      const resources = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType("resource"));
      return { .../** @type {any} */ (window).__intersiteVitals, ttfb: nav?.responseStart ?? 0, load: nav?.loadEventEnd ?? 0, requests: resources.length, kb: Math.round(resources.reduce((s, r) => s + r.transferSize, 0) / 1024) };
    });
    const { profile } = await cdp.send("Profiler.stop");
    const { result } = await cdp.send("Profiler.takePreciseCoverage");
    // A dev server serves modules by their path in the project (/src/App.tsx); those become project files.
    const local = (/** @type {string} */ u) => {
      try {
        const path = decodeURIComponent(new URL(u).pathname).replace(/^\/@fs/, "");
        const file = [join(top, path), path].find((p) => existsSync(p) && !p.includes("node_modules"));
        return file ? pathToFileURL(file).href : u;
      } catch {
        return u;
      }
    };
    for (const node of profile.nodes) node.callFrame.url = local(node.callFrame.url);
    for (const script of result) script.url = local(script.url);
    return { run: { profiles: [profile], coverage: [result], wallMs }, vitals };
  } finally {
    await context.close();
  }
}

/** @param {string} url @param {{ cwd: string, flags: Record<string, any>, runs: number }} options */
async function pageMode(url, { cwd, flags, runs }) {
  /** @type {typeof import("playwright-core").chromium} */
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new GateError("--page needs playwright-core: npm install --save-dev playwright-core (it drives your installed Chrome)");
  }
  const { launchChrome } = await import("../replay/ui.mjs");
  const { browser, stop } = await launchChrome(chromium, flags.headed);
  const top = topLevel(cwd);
  const prefix = projectPrefix(cwd);
  try {
    const sample = async (/** @type {string} */ target) => {
      await loadPage(browser, target, top);
      const loads = [];
      for (let i = 0; i < runs; i++) loads.push(await loadPage(browser, target, top));
      return loads;
    };
    const now = await sample(url);
    const base = flags.compare ? await sample(flags.compare) : [];
    const report = crunch({ top, prefix, now: now.map((l) => l.run), baseRuns: base.map((l) => l.run), baseRoot: "", minMs: flags["min-ms"] });
    const mid = (/** @type {{ vitals: Record<string, number> }[]} */ loads, /** @type {string} */ key) => {
      const values = loads.map((l) => l.vitals[key]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)] ?? 0;
    };
    const row = (/** @type {typeof now} */ loads) => `TTFB ${time(mid(loads, "ttfb"))}, FCP ${time(mid(loads, "fcp"))}, LCP ${time(mid(loads, "lcp"))}, CLS ${mid(loads, "cls").toFixed(3)}, blocking ${time(mid(loads, "tbt"))} in ${mid(loads, "longTasks")} long tasks, ${mid(loads, "requests")} requests, ${mid(loads, "kb")} KB`;
    const extra = [`vitals: ${row(now)}`, ...(base.length ? [`compare: ${row(base)} (${flags.compare})`] : [])];
    print({ title: url, report: report.data, findings: report.findings, runs, flags, extra });
    return report.findings.length ? 1 : 0;
  } finally {
    await stop();
  }
}
