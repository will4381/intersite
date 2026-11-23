// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

// The registry is never asked unless a test serves one: tests do not reach the network.
process.env.INTERSITE_OFFLINE = "1";

const pkg = (/** @type {Record<string, unknown>} */ fields) => JSON.stringify({ name: "x", ...fields }, null, 2);
const files = {
  "package.json": pkg({ dependencies: { kept: "^1.0.0" } }),
  "packages/web/package.json": pkg({ devDependencies: { vite: "^5.0.0" } }),
};

test("a new dependency in the root and in a nested package.json is reported", async () => {
  const r = repo(files);
  r.write({
    "package.json": pkg({ dependencies: { kept: "^1.0.0", "left-pad-ultra": "^1.0.0" } }),
    "packages/web/package.json": pkg({ devDependencies: { vite: "^5.0.0" }, peerDependencies: { react: "^19.0.0" } }),
  });
  const { code, out } = await run(r.cwd, ["new-deps"]);
  assert.equal(code, 1);
  assert.equal(out.length, 2);
  assert.match(out[0], /^package\.json: new dependency "left-pad-ultra": .* \| to accept: add \{ "gate": "new-deps", "target": "left-pad-ultra", "why": "…" \}/);
  assert.match(out[1], /^packages\/web\/package\.json: new dependency "react"/);
});

test("a version bump is not reported", async () => {
  const r = repo(files);
  r.write({ "package.json": pkg({ dependencies: { kept: "^2.0.0" } }) });
  const { code, out } = await run(r.cwd, ["new-deps"]);
  assert.equal(code, 0);
  assert.deepEqual(out, ["ok gate new-deps: 1 changed package.json files checked"]);
});

test("an acknowledged name is not reported", async () => {
  const r = repo(files, { acknowledged: [{ gate: "new-deps", target: "react", why: "the web package renders with React" }] });
  r.write({ "packages/web/package.json": pkg({ devDependencies: { vite: "^5.0.0" }, dependencies: { react: "^19.0.0" } }) });
  assert.equal((await run(r.cwd, ["new-deps"])).code, 0);
});

/**
 * A fake npm registry in its own process (the engine's lookups block this one), answering from `packages`:
 * name → { versions, created } or absent for a 404. `asked()` lists the names it was asked about.
 * @param {Record<string, { versions: number, created: string }>} packages
 */
async function fakeRegistry(packages) {
  const code = `
    const packages = ${JSON.stringify(packages)};
    const asked = new Set();
    require("node:http").createServer((req, res) => {
      if (req.url === "/__asked") return res.end(JSON.stringify([...asked].sort()));
      const name = decodeURIComponent(req.url.slice(1));
      asked.add(name);
      const p = packages[name];
      if (!p) { res.writeHead(404); return res.end("{}"); }
      const versions = Object.fromEntries(Array.from({ length: p.versions }, (_, i) => ["1.0." + i, {}]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, versions, time: { created: p.created } }));
    }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((done) => child.stdout.once("data", (d) => done(String(d).trim())));
  const url = `http://127.0.0.1:${port}`;
  return { url, asked: async () => (await fetch(`${url}/__asked`)).json(), stop: () => child.kill() };
}

test("the registry is asked about each new npm package: an invented one and a days-old one are named as such", async () => {
  const days = (/** @type {number} */ n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const registry = await fakeRegistry({ react: { versions: 900, created: days(4000) }, "@acme/fresh": { versions: 1, created: days(5) }, real: { versions: 40, created: days(900) } });
  const before = { offline: process.env.INTERSITE_OFFLINE, registry: process.env.INTERSITE_NPM_REGISTRY };
  delete process.env.INTERSITE_OFFLINE;
  process.env.INTERSITE_NPM_REGISTRY = registry.url;
  try {
    const r = repo(files);
    r.write({ "package.json": pkg({ dependencies: { kept: "^1.0.0", react: "^19.0.0", "react-hooks-utils-pro": "^1.0.0", "@acme/fresh": "1.0.0", alias: "npm:real@^2", local: "workspace:*" } }) });
    const { code, out } = await run(r.cwd, ["new-deps"]);
    assert.equal(code, 1);
    const lines = out.map((l) => l.split(" | ")[0]);
    assert.deepEqual(lines, [
      'package.json: new dependency "react": check it exists and is needed, or use what is already installed',
      'package.json: "react-hooks-utils-pro" does not exist on npm: an invented package name that anyone can register later with malware; remove it, and find the real package or write the few lines yourself',
      'package.json: new dependency "@acme/fresh" (first published 5 days ago, 1 version): make sure it is the package you meant and that it is needed, or use what is already installed',
      'package.json: new dependency "alias": check it exists and is needed, or use what is already installed',
      'package.json: new dependency "local": check it exists and is needed, or use what is already installed',
    ]);
    assert.match(out[1], /"target": "npm-missing:react-hooks-utils-pro"/);
    assert.deepEqual(await registry.asked(), ["@acme/fresh", "react", "react-hooks-utils-pro", "real"], "workspace packages are never asked about");
  } finally {
    registry.stop();
    for (const [key, value] of [["INTERSITE_OFFLINE", before.offline], ["INTERSITE_NPM_REGISTRY", before.registry]]) {
      if (value === undefined) delete process.env[/** @type {string} */ (key)];
      else process.env[/** @type {string} */ (key)] = value;
    }
  }
});

test("an unreachable registry changes nothing: the finding is the plain new-dependency one", async () => {
  const before = { offline: process.env.INTERSITE_OFFLINE, registry: process.env.INTERSITE_NPM_REGISTRY };
  delete process.env.INTERSITE_OFFLINE;
  process.env.INTERSITE_NPM_REGISTRY = "http://127.0.0.1:9";
  try {
    const r = repo(files);
    r.write({ "package.json": pkg({ dependencies: { kept: "^1.0.0", "left-pad-ultra": "^1.0.0" } }) });
    const { code, out } = await run(r.cwd, ["new-deps"]);
    assert.equal(code, 1);
    assert.match(out[0], /^package\.json: new dependency "left-pad-ultra": check it exists and is needed/);
  } finally {
    for (const [key, value] of [["INTERSITE_OFFLINE", before.offline], ["INTERSITE_NPM_REGISTRY", before.registry]]) {
      if (value === undefined) delete process.env[/** @type {string} */ (key)];
      else process.env[/** @type {string} */ (key)] = value;
    }
  }
});
