// @ts-check
import { defineRule } from "@oxlint/plugins";

import { counted, fails, hasTestCalls, isAssertion, isFail, isTestCall } from "./require-assertion.mjs";
import { FUNCTIONS, walk } from "./shared.mjs";


/** A test call with its callback: `it(...)`, `test.concurrent(...)`, `it.each(table)(...)`. @param {any} node */
const isTest = (node) => isTestCall(node.callee) && node.arguments.some((/** @type {any} */ a) => FUNCTIONS.has(a.type));

/** Whether the block calls an assertion, nested callbacks included (`await act(async () => { expect(...) })`). @param {any} block */
function asserts(block) {
  let found = false;
  walk(block, (n) => {
    if (found) return false;
    if (n.type === "CallExpression" && isAssertion(n.callee)) found = true;
  });
  return found;
}

/** Whether the catch throws or fails the test itself, outside nested functions. @param {any} block */
function rethrows(block) {
  let found = false;
  walk(block, (n) => {
    if (found || (n !== block && FUNCTIONS.has(n.type))) return false;
    if (n.type === "ThrowStatement" || (n.type === "CallExpression" && isFail(n))) found = true;
  });
  return found;
}

/** `catch (err) { caught = err; }`: the error is kept for an assertion after the try. @param {any} clause */
const keeps = (clause) =>
  clause.param?.type === "Identifier" && clause.body.body.length > 0 &&
  clause.body.body.every((/** @type {any} */ s) => s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.right.type === "Identifier" && s.expression.right.name === clause.param.name);

export const id = "no-swallowed-test-failure";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      swallowed: "This catch can swallow a failed assertion, or passes when nothing throws. Use assert.rejects/assert.throws or expect(...).rejects/toThrow instead, or rethrow from the catch.",
    },
  },
  createOnce(context) {
    /** @type {any[]} tests being visited */
    let tests = [];
    return {
      before() {
        tests = [];
        return hasTestCalls(context);
      },
      CallExpression(node) {
        if (isTest(node)) tests.push(node);
      },
      "CallExpression:exit"(node) {
        if (tests.at(-1) === node) tests.pop();
      },
      CatchClause(node) {
        const test = tests.at(-1);
        if (!test || counted.test(context.sourceCode.getText(test)) || rethrows(node.body) || keeps(node)) return;
        const tried = node.parent.block;
        // `try { await run(); assert.fail('should throw'); } catch (e) { expect(e.code)... }`: if nothing throws, the
        // fail lands in the catch and its assertion fails on it.
        if (tried.body.some(fails) && asserts(node.body)) return;
        if (asserts(tried) || asserts(node.body)) context.report({ node, messageId: "swallowed" });
      },
    };
  },
});

export const bad = [
  "it('rejects bad input', async () => { try { await parse('x'); } catch (error) { expect(error.message).toBe('bad'); } });",
  "test('works', () => { try { assert.equal(run(), 1); } catch {} });",
  "it.each([1, 2])('runs %i', (n) => { try { expect(run(n)).toBe(1); } catch (error) { console.log(error); } });",
  "test('renders', async () => { try { await act(async () => { expect(await load()).toBe(1); }); } catch {} });",
];

export const good = [
  "it('rejects bad input', async () => { await expect(parse('x')).rejects.toThrow('bad'); });",
  "test('cleans up', () => { try { assert.equal(run(), 1); } finally { cleanup(); } });",
  "function load() { try { return read(); } catch { return null; } }",
  "it('archives', async () => { let caught; try { await archive('svc-1'); } catch (err) { caught = err; } expect(caught).toBeInstanceOf(ApiError); });",
  "test('refuses', () => { let error; try { assertTarget(url, 'production'); } catch (caught) { error = caught; } expect(String(error)).not.toContain('secret'); });",
  "it('blocks', async () => { try { await guard(db, input); expect.fail('should have thrown'); } catch (err) { expect(err).toMatchObject({ code: 'BLOCKED' }); } });",
  "it('blocks', async () => { try { await guard(db, input); throw new Error('should have thrown'); } catch (err) { expect(err).toBeInstanceOf(AppError); } });",
  "it('rate limits', async () => { for (let i = 0; i < 6; i++) { try { await verify('bad'); } catch { /* expected */ } } expect(await verify('ok')).toBe(true); });",
  "test('reports', () => { try { assert.equal(run(), 1); } catch (error) { assert.fail(String(error)); } });",
  "it('counts', async () => { expect.assertions(1); try { await parse('x'); } catch (error) { expect(error.message).toBe('bad'); } });",
  "test('screenshots', async ({ page }) => { try { await expect(page.getByText('Saved')).toBeVisible(); } catch (error) { await page.screenshot({ path: 'fail.png' }); throw error; } });",
];
