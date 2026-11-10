// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { mentions, perFile } from "../../lint/rules/shared.mjs";

let files = 0;
/** A rule context for a new file holding `text`. @param {string} text */
const file = (text) => ({ cwd: "/p", filename: `/p/f${files++}.ts`, sourceCode: { text } });

test("mentions finds a word however the source spells it, and only rules out files that cannot hold it", () => {
  for (const [text, pattern, want] of /** @type {[string, RegExp, boolean][]} */ ([
    ["exec(cmd)", /exec|spawn/, true],
    ["run(cmd)", /exec|spawn/, false],
    ["\\x65xec(cmd)", /exec/, true],
    ["\\u0065xec(cmd)", /exec/, true],
    ["\\u{65}xec(cmd)", /exec/, true],
    ['"\\-\\["', /-\[/, true],
    ['"-\\\n["', /-\[/, true],
    ["\\101", /A/, true],
    ['<i className="&#45;[x]" />', /-\[/, true],
    ["<p>&nbsp;</p>", /exec/, true],
    ['"\\n"', /exec/, false],
    ["// \\u{FFFFFFFF}", /exec/, false],
  ])) {
    assert.equal(mentions(file(text), pattern), want, `${pattern} in ${JSON.stringify(text)}`);
  }
});

test("perFile works an answer out once per file", () => {
  let runs = 0;
  const answer = perFile(() => ++runs);
  const a = file("a");
  assert.equal(answer(a), 1);
  assert.equal(answer(a), 1);
  assert.equal(answer(file("b")), 2);
});

test("perFile works it out again when the same file is linted with new text, as in an editor", () => {
  let runs = 0;
  const answer = perFile(() => ++runs);
  const before = file("a");
  assert.equal(answer(before), 1);
  assert.equal(answer({ ...before, sourceCode: { text: "b" } }), 2);
});
