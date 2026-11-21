// @ts-check
import { defineRule } from "@oxlint/plugins";

import { resolveVariable, unwrap, walk } from "./shared.mjs";

const ASSERTS = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual", "is", "same"]);
const MATCHERS = /^(toBe|toEqual|toStrictEqual|toMatchObject)$/;
/** Calls that build an expected value without being the code under test: built-ins and test helpers. */
const NEUTRAL = /^(JSON|Object|Math|Array|String|Number|Boolean|Date|Promise|Symbol|BigInt|Buffer|Map|Set|URL|expect|vi|jest|sinon|structuredClone|t)\b/;

/** The called function's name as written (`format`, `money.format`), or undefined for anything else. @param {any} node @param {any} sourceCode */
function calledName(node, sourceCode) {
  const call = unwrap(node);
  if (call?.type !== "CallExpression") return undefined;
  const name = sourceCode.getText(call.callee);
  return /^[\w$.]+$/.test(name) && !NEUTRAL.test(name) ? name : undefined;
}

/**
 * Whether `expected` calls `name` with arguments of its own. A `const` set earlier (`const before = await state()`) is a
 * snapshot taken at another time, which is how "nothing changed" is tested, so only the expression itself is read.
 * @param {any} expected @param {string} name @param {any} sourceCode
 */
function callsIt(expected, name, sourceCode) {
  let found = false;
  walk(expected, (n) => {
    if (n.type === "CallExpression" && n.arguments.length && sourceCode.getText(n.callee) === name) found = true;
    return !found;
  });
  return found;
}

export const id = "no-derived-expectation";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      derived: "The expected value is computed by {{name}}, the function under test, so a bug in it changes both sides and the test still passes. Write the expected value out as a literal, or compute it another, simpler way.",
    },
  },
  createOnce(context) {
    /** @param {any} node @param {any} actual @param {any} expected */
    function check(node, actual, expected) {
      const { sourceCode } = context;
      const name = calledName(actual, sourceCode);
      const [actualText, expectedText] = [sourceCode.getText(actual), expected && sourceCode.getText(expected)];
      // The same text on both sides is no-self-comparison-assertion's; f(f(x)) against f(x) tests that f is idempotent.
      if (!name || !expected || !unwrap(actual).arguments.length || actualText === expectedText || actualText.includes(expectedText)) return;
      // The code under test is imported; a function the test file defines is the test's own helper (a parser, a builder).
      const root = unwrap(actual).callee;
      const head = root.type === "MemberExpression" ? root.object : root;
      if (head.type !== "Identifier" || resolveVariable(head, sourceCode)?.defs[0]?.type !== "ImportBinding") return;
      if (callsIt(expected, name, sourceCode)) context.report({ node, messageId: "derived", data: { name } });
    }
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (MATCHERS.test(callee.property.name) && callee.object.type === "CallExpression" && callee.object.callee.name === "expect") check(node, callee.object.arguments[0], node.arguments[0]);
        else if (ASSERTS.has(callee.property.name) && callee.object.name !== "Object") check(node, node.arguments[0], node.arguments[1]);
      },
    };
  },
});

export const bad = [
  "import { formatPrice } from './price';\nit('formats', () => { expect(formatPrice(1999)).toBe(formatPrice(1999.0)); });",
  "import { total } from './cart';\nit('totals', () => { expect(total([item, item])).toEqual(total([item]) * 2); });",
  "import { slugify } from './slug';\ntest('slug', () => { assert.equal(slugify('A B'), slugify('a b')); });",
];

export const good = [
  "it('formats', () => { expect(formatPrice(1999)).toBe('$19.99'); });",
  "it('totals', () => { expect(total([item, item])).toEqual(item.price * 2); });",
  "it('parses', () => { expect(parse(JSON.stringify(user))).toEqual(JSON.parse(JSON.stringify(user))); });",
  "it('same', () => { expect(hash(a)).toBe(hash(a)); });",
  "const lines = (out) => out.split('\\n').sort();\nit('agrees', () => { expect(lines(run(['--a']))).toEqual(lines(run(['--b']))); });",
  "it('changes nothing', async () => { const before = await state(); await reject(id); expect(await state()).toEqual(before); });",
  "it('is idempotent', () => { expect(scrub(scrub(input))).toEqual(scrub(input)); });",
];
