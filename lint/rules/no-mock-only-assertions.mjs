// @ts-check
import { defineRule } from "@oxlint/plugins";

import { testAssertions } from "./require-assertion.mjs";

/**
 * `toHaveBeenCalledWith`, `toHaveBeenCalledOnce`, `toHaveReturnedWith`, `fn.mock.calls`, node:test `fn.mock.callCount()`,
 * sinon's `sinon.assert.calledWith` and `spy.calledOnce`.
 */
const mockCheck = /\.(?:toHaveBeen|toBe)(?:Last|Nth)?Called\w*|\.toHave(?:Last|Nth)?(?:Returned|Resolved)\w*|\.(?:last|nth)CalledWith\b|\.mock\.(?:calls|callCount)\b|\bsinon\.assert\.\w+|\.(?:calledOnce|calledTwice|calledThrice|calledWith\w*|callCount)\b/;
/** `expect(fetch).not.toHaveBeenCalled()`: that nothing happened is itself the behaviour, with no result to check. */
const notCalled = /\.not\.(?:toHaveBeen|toBe)\w*Called/;

export const id = "no-mock-only-assertions";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      mockOnly: "Every assertion in this test only checks that a mock was called, so it passes even when the result is wrong. Assert on what the code returned or changed: a value, stored state, a response, the rendered text.",
    },
  },
  createOnce(context) {
    return testAssertions(context, {
      test: () => ({ total: 0, mock: 0 }),
      assertion(node, frame) {
        const text = context.sourceCode.getText(node);
        if (notCalled.test(text)) return;
        frame.total++;
        if (mockCheck.test(text)) frame.mock++;
      },
      done(frame, node) {
        if (frame.total > 0 && frame.mock === frame.total) context.report({ node, messageId: "mockOnly" });
      },
    });
  },
});

export const bad = [
  "it('saves', async () => { const db = { insert: vi.fn() }; await save(db, user); expect(db.insert).toHaveBeenCalledWith(user); });",
  "test('notifies once', () => { const send = jest.fn(); notify(send); expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalled(); });",
  "test('retries', (t) => { const fetch = t.mock.fn(); retry(fetch); assert.equal(fetch.mock.callCount(), 3); });",
  "it('logs', () => { const log = vi.fn(); run(log); expect(log.mock.calls).toHaveLength(2); });",
  "it('binds', () => { const on = vi.fn(); bind(on); expect(on).toHaveBeenCalledWith(expect.any(Function)); });",
  "test('calls', () => { const fn = mock.fn(); run(fn); assert.strictEqual(fn.mock.calls.length, 1); });",
  "it('runs once', () => { const fn = vi.fn(); run(fn); expect(fn).toHaveBeenCalledOnce(); });",
  "it('passes the id', () => { const fn = sinon.spy(); run(fn); sinon.assert.calledWith(fn, 1); });",
  "it('toasts', () => { submit(); expect(toast.success).toHaveBeenCalledWith('Saved'); expect(toast.error).not.toHaveBeenCalled(); });",
  "it.each([1, 2])('passes %i', (n) => { const fn = vi.fn(); run(fn, n); expect(fn).toHaveBeenCalledWith(n); });",
];

export const good = [
  "it('saves', async () => { const db = createMemoryDb(); await save(db, user); expect(await db.find(user.id)).toEqual(user); });",
  "test('notifies', () => { const send = jest.fn(); const result = notify(send); expect(send).toHaveBeenCalledTimes(1); expect(result).toEqual({ sent: 1 }); });",
  "test('retries', (t) => { const fetch = t.mock.fn(() => 'ok'); assert.equal(retry(fetch), 'ok'); });",
  "it('does not fetch while disabled', () => { render(false); expect(fetchMock).not.toHaveBeenCalled(); });",
  "test('outer', async (t) => { await t.test('inner', () => { assert.equal(run(), 3); }); });",
];
