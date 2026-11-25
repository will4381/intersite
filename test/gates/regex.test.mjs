// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { gates } from "../../cli/gate.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await gates.regex({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [], protected: [] })).findings.map((f) => f.message);

test("a pattern whose backtracking doubles with each character is reported, and safe ones are not", async () => {
  const r = repo({ "src/a.ts": "export const ok = 1;\n" });
  r.write({
    "src/words.ts": "export const WORDS = /^(\\w+\\s?)+$/;\nexport const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;\nexport const TRIM = /\\s+$/;\nexport const tag = new RegExp(\"^(a|aa)+$\");\n",
  });
  const fix = "make the inside of the repeat unable to match what follows it (e.g. [^\\s]+ instead of .+), or bound the input length before matching";
  assert.deepEqual(await check(r.cwd), [
    `src/words.ts:1 /^(\\w+\\s?)+$/ has a repeated group whose inside repeats too, matching the same characters, so on a crafted input that almost matches its time doubles with each extra character and can hang the process: ${fix}`,
    `src/words.ts:4 /^(a|aa)+$/ has a repeated choice whose alternatives can match the same characters, so on a crafted input that almost matches its time doubles with each extra character and can hang the process: ${fix}`,
  ]);
});

test("one validation written two ways in two files is reported; patterns equal in meaning are one", async () => {
  const r = repo({ "server/validate.ts": "export const EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;\nexport const PHONE = /^\\+[1-9]\\d{7,14}$/;\n" });
  r.write({ "web/form.ts": "export const emailPattern = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;\nexport const phoneSchema = /^\\+[1-9][0-9]{7,14}$/;\nexport const creatorEmail = /^x$/;\n" });
  assert.deepEqual(await check(r.cwd), [
    "web/form.ts:1 emailPattern validates email as /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/ but EMAIL_RE at server/validate.ts:1 uses /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/, so the two disagree on what is a valid email: keep one pattern in a module both import",
  ]);
});
