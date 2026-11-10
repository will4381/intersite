// @ts-check
import { defineRule } from "@oxlint/plugins";

const asserts = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual", "is", "same"]);

export const id = "no-self-comparison-assertion";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      self: "This assertion compares a value with itself, so it can never fail. Compare against an independently written expected value.",
    },
  },
  createOnce(context) {
    // Two literals (`expect(true).toBe(true)`) are no-constant-assertion's to report.
    /** @param {any} a @param {any} b */
    const same = (a, b) => a && b && a.type !== "Literal" && context.sourceCode.getText(a) === context.sourceCode.getText(b);
    return {
      // expect(x).toBe(x)
      "CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual)$/][callee.object.type='CallExpression'][callee.object.callee.name='expect']"(node) {
        if (same(node.callee.object.arguments[0], node.arguments[0])) {
          context.report({ node, messageId: "self" });
        }
      },
      // ponytail: a determinism test, expect(hash(a)).toBe(hash(a)), reports too; it reads the same as a tautology.
      // assert.equal(x, x), t.assert.deepEqual(x, x), t.is(x, x)
      "CallExpression[callee.type='MemberExpression']"(node) {
        // `Object.is(x, x)` is not an assertion.
        if (asserts.has(node.callee.property.name) && node.callee.object.name !== "Object" && same(node.arguments[0], node.arguments[1])) {
          context.report({ node, messageId: "self" });
        }
      },
    };
  },
});

export const bad = [
  "expect(total).toBe(total);",
  "expect(order.items).toEqual(order.items);",
  "assert.deepStrictEqual(result, result);",
  "t.assert.equal(sum(1, 2), sum(1, 2));",
];

export const good = [
  "expect(total).toBe(3);",
  "assert.deepStrictEqual(result, { ok: true });",
  "assert.equal(a, b);",
  "expect(true).toBe(true);",
  "export const same = Object.is(value, value);",
];
