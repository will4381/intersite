// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isAssertion, isTestCall } from "./require-assertion.mjs";

/** `toHaveBeenCalledWith`, `toBeCalledTimes`, `fn.mock.calls`, node:test `fn.mock.callCount()`. */
const mockCheck = /\.(?:toHaveBeen|toBe)(?:Last|Nth)?Called(?:With|Times)?\b|\.(?:last|nth)CalledWith\b|\.mock\.(?:calls|callCount)\b/;

export const id = "no-mock-only-assertions";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      mockOnly: "Every assertion in this test only checks that a mock was called, so it passes even when the result is wrong. Assert on what the code returned or changed: a value, stored state, a response.",
    },
  },
  createOnce(context) {
    /** @type {{ node: any, total: number, mock: number }[]} */
    let tests = [];
    /** @type {any[]} the assertion being visited; calls inside it (`expect(x)`, `expect.any()`) are part of it */
    let inside = [];
    return {
      before() {
        tests = [];
        inside = [];
      },
      CallExpression(node) {
        if (isTestCall(node.callee) && node.arguments.some((/** @type {any} */ a) => a.type.endsWith("FunctionExpression"))) {
          tests.push({ node, total: 0, mock: 0 });
        } else if (!inside.length && tests.length && isAssertion(node.callee)) {
          inside.push(node);
          const frame = /** @type {{ total: number, mock: number }} */ (tests.at(-1));
          frame.total++;
          if (mockCheck.test(context.sourceCode.getText(node))) frame.mock++;
        }
      },
      "CallExpression:exit"(node) {
        if (inside.at(-1) === node) inside.pop();
        if (tests.at(-1)?.node !== node) return;
        const frame = /** @type {{ node: any, total: number, mock: number }} */ (tests.pop());
        if (frame.total > 0 && frame.mock === frame.total) context.report({ node, messageId: "mockOnly" });
      },
    };
  },
});

export const bad = [
  "it('saves', async () => { const db = { insert: vi.fn() }; await save(db, user); expect(db.insert).toHaveBeenCalledWith(user); });",
  "test('notifies once', () => { const send = jest.fn(); notify(send); expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalled(); });",
  "test('retries', (t) => { const fetch = t.mock.fn(); retry(fetch); assert.equal(fetch.mock.callCount(), 3); });",
  "it('logs', () => { const log = vi.fn(); run(log); expect(log.mock.calls).toHaveLength(2); });",
  "it('binds', () => { const on = vi.fn(); bind(on); expect(on).toHaveBeenCalledWith(expect.any(Function)); });",
  "test('calls', () => { const fn = mock.fn(); run(fn); assert.strictEqual(fn.mock.calls.length, 1); });",
];

export const good = [
  "it('saves', async () => { const db = createMemoryDb(); await save(db, user); expect(await db.find(user.id)).toEqual(user); });",
  "test('notifies', () => { const send = jest.fn(); const result = notify(send); expect(send).toHaveBeenCalledTimes(1); expect(result).toEqual({ sent: 1 }); });",
  "test('retries', (t) => { const fetch = t.mock.fn(() => 'ok'); assert.equal(retry(fetch), 'ok'); });",
  "test('outer', async (t) => { await t.test('inner', () => { assert.equal(run(), 3); }); });",
];
