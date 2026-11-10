// @ts-check
// Fails when a test file was deleted, lost tests or assertions, or gained a skip: the cheapest ways to get green.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EMPTY_TREE, baseName, changes, matches, resolveBase, showMany, stripCode, topLevel } from "./lib.mjs";

// ponytail: counts call sites by regular expression, an AST walk if helpers that wrap it() or expect() matter
const TESTS = /(?<![.\w$])(?:t\.)?(?:it|test)(?:\.(?:each|only|concurrent|skip|todo))?\s*\(/g;
const ASSERTS = /(?<![.\w$])(?:expect|assert)\s*\(|(?<![.\w$])assert\.\w+\s*\(|(?<![.\w$])t\.(?:is|not|true|false|truthy|falsy|deepEqual|notDeepEqual|like|regex|throws|throwsAsync|notThrows|notThrowsAsync|snapshot|pass|fail|assert|equal|ok)\b/g;
const SKIPS = /(?<![.\w$])(?:(?:it|test|describe|suite|t)\.(?:skip|todo)\b|x(?:it|test|describe)\s*\(|(?:skip|todo)\s*:)/g;

/** @param {string} text */
function counts(text) {
  const code = stripCode(text);
  return { tests: code.match(TESTS)?.length ?? 0, assertions: code.match(ASSERTS)?.length ?? 0, skips: code.match(SKIPS)?.length ?? 0 };
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function testIntegrity({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const since = sha === EMPTY_TREE ? "an empty repository" : baseName(cwd, base);
  const top = topLevel(cwd);
  const files = changes(cwd, sha).filter((c) => matches(c.from, testPaths) || matches(c.path, testPaths));
  const before = showMany(cwd, sha, files.filter((c) => c.status !== "A" && c.status !== "D" && matches(c.from, testPaths)).map((c) => c.from));
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  for (const change of files) {
    if (change.status === "D") {
      findings.push({ target: change.path, message: `${change.path}: test file deleted` });
      continue;
    }
    const was = change.status === "A" || !matches(change.from, testPaths) ? counts("") : counts(before.get(change.from) ?? "");
    // A test file moved to a path that is no longer a test path has, as far as the suite knows, no tests left.
    const now = matches(change.path, testPaths) ? counts(readFileSync(join(top, change.path), "utf8")) : counts("");
    const lost = [];
    if (now.tests < was.tests) lost.push(`tests ${was.tests} → ${now.tests}`);
    if (now.assertions < was.assertions) lost.push(`assertions ${was.assertions} → ${now.assertions}`);
    if (now.skips > was.skips) lost.push(`skips and todos ${was.skips} → ${now.skips}`);
    if (lost.length) findings.push({ target: change.path, message: `${change.path}: ${lost.join(", ")} since ${since}` });
  }
  return { findings, summary: `${files.length} changed test files checked` };
}
