// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "./shared.mjs";
import { isTestCall } from "./require-assertion.mjs";

/** Matchers whose argument decides: a zero count says something did not happen. */
const COUNTED = /^(toHaveBeenCalledTimes|toHaveCount)$/;

/**
 * Each assertion in a test callback, as true when it can only show that something did not happen: `.not.` chains,
 * a zero call count, `assert.notEqual`, `doesNotThrow`. A value's absence (`toBeNull()`) is a claim about what a
 * function returns, and counts as positive.
 * @param {any} fn
 * @returns {boolean[]}
 */
function assertions(fn) {
  /** @type {boolean[]} */
  const found = [];
  walk(fn.body, (n) => {
    if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression") return;
    const name = n.callee.property.name ?? "";
    let chain = n.callee.object;
    let negated = false;
    while (chain?.type === "MemberExpression") {
      if (chain.property.name === "not") negated = true;
      chain = chain.object;
    }
    if (chain?.type === "CallExpression" && chain.callee.name === "expect") {
      const zero = COUNTED.test(name) && n.arguments[0]?.type === "Literal" && n.arguments[0].value === 0;
      found.push(negated || zero);
      return false;
    }
    if (n.callee.object.name === "assert" || n.callee.object.property?.name === "assert") {
      found.push(/^(notEqual|notStrictEqual|notDeepEqual|notDeepStrictEqual|doesNotThrow|doesNotReject|doesNotMatch)$/.test(name));
      return false;
    }
  });
  return found;
}

export const id = "no-absence-only-test";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      absent: "Every assertion here checks that something did not happen, and no test beside it checks that it does, so a feature that never runs at all passes. Add the positive case: the same setup with the input that should trigger it, asserting that it happens.",
    },
  },
  createOnce(context) {
    return {
      Program(program) {
        /** @type {Map<any, { node: any, negative: boolean }[]>} tests per parent block (a describe body, or the file) */
        const groups = new Map();
        walk(program, (n, parent) => {
          if (n.type !== "CallExpression" || !isTestCall(n.callee)) return;
          const fn = n.arguments.find((/** @type {any} */ a) => a.type.endsWith("FunctionExpression"));
          if (!fn) return false;
          const found = assertions(fn);
          if (!found.length) return false;
          let block = parent;
          while (block && block.type !== "BlockStatement" && block.type !== "Program") block = block.parent;
          const list = groups.get(block) ?? [];
          list.push({ node: n, negative: found.every(Boolean) });
          groups.set(block, list);
          return false;
        });
        for (const tests of groups.values()) {
          if (tests.every((t) => t.negative)) for (const t of tests) context.report({ node: t.node.callee, messageId: "absent" });
        }
      },
    };
  },
});

export const bad = [
  "it('does not email unverified users', async () => { await signup(unverified); expect(mailer.send).not.toHaveBeenCalled(); });",
  "describe('rate limit', () => { it('does not block the first request', () => { assert.doesNotThrow(() => limit(first)); }); });",
];

export const good = [
  "it('emails verified users', async () => { await signup(verified); expect(mailer.send).toHaveBeenCalledTimes(1); });\nit('does not email unverified users', async () => { await signup(unverified); expect(mailer.send).not.toHaveBeenCalled(); });",
  "it('saves', async () => { const row = await save(input); expect(row.id).toBeDefined(); expect(row.error).toBeUndefined(); });",
  "it('returns null for an unknown id', async () => { expect(await find('nope')).toBeNull(); });",
];
