// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { compilerOptions } from "../../lint/tsconfig.mjs";
import { fixture, runLint } from "./fixture.mjs";

test("compiler options follow extends, relative and from a package, with comments and trailing commas", () => {
  const cwd = fixture({
    "node_modules/@acme/tsconfig/strict.json": '{ "compilerOptions": { "strict": true, "target": "es2020" } }',
    "node_modules/@acme/tsconfig/package.json": '{ "name": "@acme/tsconfig" }',
    "base.json": '{\n  // indexes may be missing\n  "extends": "@acme/tsconfig/strict.json",\n  "compilerOptions": { "noUncheckedIndexedAccess": true, /* yes */ },\n}\n',
    "tsconfig.json": '{ "extends": "./base.json", "compilerOptions": { "target": "es2022", "paths": { "@/*": ["./src/*"] } } }',
  });
  const options = compilerOptions(`${cwd}/tsconfig.json`);
  assert.deepEqual([options?.strict, options?.noUncheckedIndexedAccess, options?.target], [true, true, "es2022"]);
  assert.equal(compilerOptions(`${cwd}/missing.json`), undefined);
});

test("no-unnecessary-condition runs only when every tsconfig makes missing indexes visible", async () => {
  const rule = async (/** @type {Record<string, string>} */ tsconfigs) => {
    const cwd = fixture({ "intersite.json": JSON.stringify({ project: "t", lint: { typeAware: true } }), ...tsconfigs });
    // A repository, so every tsconfig.json in it is found, not only the one at the top.
    execFileSync("git", ["init", "-q"], { cwd });
    return (await runLint(cwd, ["--rules"])).out.split("\n").find((line) => line.includes("no-unnecessary-condition"));
  };
  const strict = '{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }';
  assert.equal(await rule({ "tsconfig.json": strict }), "typeAware typescript/no-unnecessary-condition on");
  assert.equal(await rule({ "tsconfig.json": '{ "compilerOptions": { "strict": true } }' }), "typeAware typescript/no-unnecessary-condition off");
  assert.equal(await rule({ "api/tsconfig.json": strict, "web/tsconfig.json": strict }), "typeAware typescript/no-unnecessary-condition on", "packages with no tsconfig at the top");
  assert.equal(await rule({ "api/tsconfig.json": strict, "web/tsconfig.json": '{ "compilerOptions": { "strict": true } }' }), "typeAware typescript/no-unnecessary-condition off");
  assert.equal(await rule({}), "typeAware typescript/no-unnecessary-condition off");
});
