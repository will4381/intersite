// @ts-check
import { defineRule } from "@oxlint/plugins";

import { counted, fails, isAssertion, isFail, isTestCall } from "./require-assertion.mjs";

/** An assertion, a throw, or a fail call: a branch with one of these does not let the test pass silently. */
const checks = /\b(?:expect|assert\w*|throw|should)\b|\.fail\(/;

export const id = "no-conditional-assertion";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      conditional: "This assertion sits in a branch that may not run, so the test can pass without checking anything. Make the expected path unconditional (assert the condition first), or use assert.rejects/expect(...).rejects for errors.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    const text = (node) => context.sourceCode.getText(node);
    /** @type {any[]} tests being visited whose bodies are not guarded by expect.assertions */
    let tests = [];
    /** @type {any[]} */
    let inside = [];

    /**
     * The branch statement that makes `node` conditional, if any, climbing to the enclosing test call.
     * @param {any} node
     * @param {any} test
     */
    function conditional(node, test) {
      for (let child = node, parent = node.parent; parent && parent !== test; child = parent, parent = parent.parent) {
        if ((parent.type === "IfStatement" || parent.type === "ConditionalExpression") && child !== parent.test) {
          if (parent.type === "IfStatement" && assertedBefore(parent)) continue;
          const other = child === parent.consequent ? parent.alternate : parent.consequent;
          if (!checks.test(other ? text(other) : after(parent))) return true;
        }
        if (parent.type === "CatchClause" && !parent.parent.block.body.some(fails)) return true;
        // `r.ok && expect(r.value)...`: the right side runs only when the left is truthy.
        if (parent.type === "LogicalExpression" && child === parent.right) return true;
        // A case runs only for its value, unless a default case checks the rest.
        if (parent.type === "SwitchCase" && child !== parent.test && !switchChecksDefault(parent.parent)) return true;
      }
      return false;
    }

    /** Whether the switch has a default case that asserts or fails. @param {any} node a SwitchStatement */
    const switchChecksDefault = (node) => node.cases.some((/** @type {any} */ c) => !c.test && checks.test(c.consequent.map(text).join("\n")));

    /**
     * The statements after `node` in its block, as text, when the branch returns early: `if (x) return check(a);`
     * leaves the rest of the block as the other branch.
     * @param {any} node
     */
    function after(node) {
      const last = node.consequent.type === "BlockStatement" ? node.consequent.body.at(-1) : node.consequent;
      const body = node.parent.body;
      if (last?.type !== "ReturnStatement" || !Array.isArray(body)) return "";
      return body.slice(body.indexOf(node) + 1).map(text).join("\n");
    }

    /**
     * True when an earlier statement in the same block asserts the condition's subject, as in
     * `expect(r.ok).toBe(false); if (!r.ok) expect(r.error)...`: the branch narrows a type, it is not optional.
     * @param {any} node an IfStatement
     */
    function assertedBefore(node) {
      let subject = node.test;
      while (subject.type === "UnaryExpression" && subject.operator === "!") subject = subject.argument;
      if (subject.type === "BinaryExpression") subject = subject.left;
      const body = node.parent.body;
      if (!Array.isArray(body) || !["Identifier", "MemberExpression"].includes(subject.type)) return false;
      const name = text(subject);
      return body.slice(0, body.indexOf(node)).some((/** @type {any} */ s) => s.type === "ExpressionStatement" && checks.test(text(s)) && text(s).includes(name));
    }

    return {
      before() {
        tests = [];
        inside = [];
      },
      CallExpression(node) {
        if (isTestCall(node.callee) && node.arguments.some((/** @type {any} */ a) => a.type.endsWith("FunctionExpression"))) {
          tests.push(counted.test(text(node)) ? null : node);
        } else if (!inside.length && tests.length && isAssertion(node.callee)) {
          inside.push(node);
          const test = tests.at(-1);
          if (test && !isFail(node) && conditional(node, test)) context.report({ node, messageId: "conditional" });
        }
      },
      "CallExpression:exit"(node) {
        if (inside.at(-1) === node) inside.pop();
        if (isTestCall(node.callee) && node.arguments.some((/** @type {any} */ a) => a.type.endsWith("FunctionExpression"))) tests.pop();
      },
    };
  },
});

export const bad = [
  "it('loads', async () => { const user = await load(); if (user) { expect(user.name).toBe('Ada'); } });",
  "test('parses', () => { const r = parse('1'); r.ok ? assert.equal(r.value, 1) : null; });",
  "it('rejects', async () => { try { await parse('x'); } catch (error) { expect(error.message).toBe('bad'); } });",
  "test('items', () => { for (const item of list()) { if (item.done) assert.ok(item.at); } });",
  "test('falls through', () => { const r = run(); if (r.a) { assert.equal(r.a, 1); } else if (r.b) { assert.equal(r.b, 2); } });",
  "it('lists', async () => { const body = await list(); expect(Array.isArray(body.items)).toBe(true); if (body.items.length > 0) { expect(body.items[0]).toHaveProperty('id'); } });",
  "it('hides', async () => { const other = await find(); if (other) { expect(ids).not.toContain(other.id); } });",
  "test('unrelated', () => { const r = run(); expect(r.count).toBe(1); if (r.ok) assert.equal(r.value, 1); });",
  "test('short-circuits', () => { const r = run(); r.ok && expect(r.value).toBe(1); });",
  "test('cases', () => { const r = run(); switch (r.kind) { case 'a': expect(r.a).toBe(1); break; } });",
  "it.each([1, 2])('runs %i', (n) => { const r = run(n); if (r) expect(r).toBe(n); });",
];

export const good = [
  "test('rejects', async () => { try { await parse('x'); assert.fail('parse should throw'); } catch (error) { assert.equal(error.message, 'bad'); } });",
  "it('loads', async () => { const user = await load(); if (!user) throw new Error('no user'); expect(user.name).toBe('Ada'); });",
  "test('narrows', () => { const r = parse('1'); if (r.ok) { assert.equal(r.value, 1); } else { assert.fail(r.error); } });",
  "test('guards', () => { const r = run(); if (!r.ok) assert.fail(r.error); assert.equal(r.value, 1); });",
  "it('counts', async () => { expect.assertions(1); try { await parse('x'); } catch (error) { expect(error.message).toBe('bad'); } });",
  "function check(user) { if (user) { expect(user.name).toBe('Ada'); } }",
  "it('refuses', () => { const r = schema.safeParse(input); expect(r.success).toBe(false); if (!r.success) expect(r.error.issues[0].message).toBe('required'); });",
  "test('narrows', () => { const d = gate(); assert.equal(d.skip, true); if (d.skip) { assert.equal(d.reason, 'consent'); } });",
  "it('rejects', async () => { try { await parse('x'); expect.unreachable('parse should throw'); } catch (error) { expect(error.message).toBe('bad'); } });",
  "test('kinds', () => { const r = run(); switch (r.kind) { case 'a': expect(r.a).toBe(1); break; default: assert.fail(r.kind); } });",
  "test('either', async () => { if (await empty.isVisible()) return expectEmpty(screen); await expect(table).toBeVisible(); });",
];
