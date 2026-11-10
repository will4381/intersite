// @ts-check
import { defineRule } from "@oxlint/plugins";

const assertionName = /^(expect|assert|should)/i;

/**
 * True for `it(...)`/`test(...)` and their modifiers (`it.only`, `test.concurrent`), but not `.todo`/`.each`.
 * @param {any} callee
 */
function isTestCall(callee) {
  if (callee.type === "Identifier") return callee.name === "it" || callee.name === "test";
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "it" || callee.object.name === "test") &&
    !["todo", "each", "skip"].includes(callee.property.name)
  );
}

/**
 * True when any name in the callee chain looks like an assertion: `expect(x)`, `assert.equal`, `t.assert.ok`,
 * `request.expect(200)`, `expectTypeOf`.
 * @param {any} callee
 */
function isAssertion(callee) {
  for (let node = callee; node; node = node.type === "CallExpression" ? node.callee : node.object) {
    if (node.type === "Identifier") return assertionName.test(node.name);
    if (node.type === "MemberExpression" && node.property.type === "Identifier" && assertionName.test(node.property.name)) return true;
    if (node.type !== "MemberExpression" && node.type !== "CallExpression") return false;
  }
  return false;
}

export const id = "require-assertion";
export const pack = "tests";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      none: "This test asserts nothing, so it passes whatever the code does. Assert the result (expect/assert), or delete the test.",
    },
  },
  createOnce(context) {
    /** @type {{ node: any, asserted: boolean }[]} */
    let open = [];
    return {
      before() {
        open = [];
      },
      CallExpression(node) {
        if (isTestCall(node.callee) && node.arguments.some((/** @type {any} */ a) => a.type.endsWith("FunctionExpression"))) {
          open.push({ node, asserted: false });
        } else if (isAssertion(node.callee)) {
          for (const frame of open) frame.asserted = true;
        }
      },
      "CallExpression:exit"(node) {
        if (open.at(-1)?.node !== node) return;
        const frame = /** @type {{ node: any, asserted: boolean }} */ (open.pop());
        if (!frame.asserted) context.report({ node, messageId: "none" });
      },
    };
  },
});

export const bad = [
  "it('adds', () => {});",
  "test('adds', () => { add(1, 2); });",
  "it.only('saves', async () => { await save(user); });",
];

export const good = [
  "it('adds', () => { expect(add(1, 2)).toBe(3); });",
  "test('adds', () => { assert.equal(add(1, 2), 3); });",
  "test('adds', async (t) => { t.assert.equal(add(1, 2), 3); });",
  "it('responds', () => request(app).get('/').expect(200));",
  "it.todo('handles refunds');",
  "test('outer', async (t) => { await t.test('inner', () => { assert.ok(run()); }); });",
];
