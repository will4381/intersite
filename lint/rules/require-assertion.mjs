// @ts-check
import { defineRule } from "@oxlint/plugins";

import { mentions, perFile } from "./shared.mjs";

const assertionName = /^(expect|assert|should)/i;

/** Modifiers that still declare a test. Anything else on `test.` is a hook, a group or a skip (`test.beforeEach`, `test.describe`). */
/** Whether the file names `it` or `test`, as every test call does (modifiers and `.each` included). */
export const hasTestCalls = perFile((context) => mentions(context, /\b(?:it|test)\b/));

const modifiers = new Set(["only", "concurrent", "sequential", "serial", "fails", "fail", "failing"]);

/**
 * True for `it(...)`/`test(...)`, their modifiers (`it.only`, `test.concurrent`) and tables (`it.each(rows)(...)`,
 * test.each`rows`(...)), but not hooks, groups, `.todo` or `.skip`.
 * @param {any} callee
 */
export function isTestCall(callee) {
  if (callee.type === "CallExpression" || callee.type === "TaggedTemplateExpression") {
    const each = callee.type === "CallExpression" ? callee.callee : callee.tag;
    return each.type === "MemberExpression" && each.property.name === "each" && isTestCall(each.object);
  }
  if (callee.type === "Identifier") return callee.name === "it" || callee.name === "test";
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "it" || callee.object.name === "test") &&
    modifiers.has(callee.property.name)
  );
}

/**
 * True when any name in the callee chain looks like an assertion: `expect(x)`, `assert.equal`, `t.assert.ok`,
 * `request.expect(200)`, `expectTypeOf`.
 * @param {any} callee
 */
export function isAssertion(callee) {
  for (let node = callee; node; node = node.type === "CallExpression" ? node.callee : node.object) {
    if (node.type === "Identifier") return assertionName.test(node.name);
    if (node.type === "MemberExpression" && node.property.type === "Identifier" && assertionName.test(node.property.name)) return true;
    if (node.type !== "MemberExpression" && node.type !== "CallExpression") return false;
  }
  return false;
}

/** `assert.fail()`, `expect.fail()`, `expect.unreachable()`, Jest's global `fail()`: a call that fails the test where it runs. @param {any} node */
export const isFail = (node) => /^(?:fail|unreachable)$/.test(node.callee.type === "MemberExpression" ? node.callee.property.name : node.callee.name ?? "");

/** `expect.assertions(n)` in a test: it fails when an assertion in a branch or catch is skipped. */
export const counted = /\bexpect\.(?:assertions|hasAssertions)\(/;

/** A statement that fails the test: `throw ...`, `assert.fail()`, `await expect.unreachable()`. @param {any} statement */
export function fails(statement) {
  if (statement.type === "ThrowStatement") return true;
  let e = statement.type === "ExpressionStatement" ? statement.expression : undefined;
  if (e?.type === "AwaitExpression") e = e.argument;
  return e?.type === "CallExpression" && isFail(e);
}

export const id = "require-assertion";
export const pack = "tests";

/**
 * A call whose result is thrown away and whose name says it checks: a helper (`checkA11y`, `verifyRefused`), an
 * end-to-end fixture method (`ui.require(id)`, `ui.gone(id)`), a query that throws when nothing matches
 * (`screen.findByText`), or a wait that fails on timeout (`page.waitForURL`).
 */
const checkName = /^(?:verify|check|ensure)(?:[A-Z_]|$)/;
const checkMethod = /^(?:require|gone|find(?:All)?By[A-Z]\w*|waitForURL)$/;

/** @param {any} node */
function isDiscardedCheck(node) {
  const statement = node.parent.type === "AwaitExpression" ? node.parent.parent : node.parent;
  if (statement.type !== "ExpressionStatement" && statement.type !== "ReturnStatement") return false;
  const { callee } = node;
  if (callee.type === "Identifier") return checkName.test(callee.name);
  return callee.type === "MemberExpression" && callee.property.type === "Identifier" && (checkName.test(callee.property.name) || checkMethod.test(callee.property.name));
}

/**
 * The name a function is declared under: `function refused() {}` or `const refused = () => {}`.
 * @param {any} node
 */
const functionName = (node) => node.id?.name ?? (node.parent.type === "VariableDeclarator" ? node.parent.id.name : undefined);

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      none: "This test asserts nothing, so it passes whatever the code does. Assert the result (expect/assert, or a helper named expect.../assert.../check...), or delete the test.",
    },
  },
  createOnce(context) {
    /** @typedef {{ node: any, asserted: boolean, calls: Set<string> }} Frame */
    /** @type {Frame[]} */
    let open = [];
    /** @type {Frame[]} tests with no assertion of their own, decided at the end of the file */
    let pending = [];
    /** @type {(string | undefined)[]} names of the functions being visited */
    let functions = [];
    /** @type {Map<string, Set<string>>} function name -> names it calls; "" stands for "asserts" */
    let graph = new Map();

    /** @param {string} callee */
    const recordCall = (callee) => {
      for (const name of functions) if (name) graph.set(name, (graph.get(name) ?? new Set()).add(callee));
      for (const frame of open) frame.calls.add(callee);
    };

    return {
      before() {
        open = [];
        pending = [];
        functions = [];
        graph = new Map();
        return hasTestCalls(context);
      },
      ":function"(node) {
        functions.push(functionName(node));
      },
      ":function:exit"() {
        functions.pop();
      },
      CallExpression(node) {
        if (isTestCall(node.callee) && node.arguments.some((/** @type {any} */ a) => a.type.endsWith("FunctionExpression"))) {
          open.push({ node, asserted: false, calls: new Set() });
        } else if (isAssertion(node.callee) || isDiscardedCheck(node)) {
          for (const frame of open) frame.asserted = true;
          recordCall("");
        } else if (node.callee.type === "Identifier") {
          recordCall(node.callee.name);
        }
      },
      "CallExpression:exit"(node) {
        if (open.at(-1)?.node !== node) return;
        const frame = /** @type {Frame} */ (open.pop());
        // `// @ts-expect-error` is a compile-time assertion: a type test asserts through it.
        const typeTest = context.sourceCode.getCommentsInside(node).some((c) => c.value.trim().startsWith("@ts-expect-error"));
        if (!frame.asserted && !typeTest) pending.push(frame);
      },
      "Program:exit"() {
        if (!pending.length) return;
        // A helper declared in this file asserts when it, or a helper it calls, asserts.
        // ponytail: an asserting helper imported from another file (`refused(res)`) is not seen; only check/verify/ensure names count.
        const asserting = new Set([""]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const [name, calls] of graph) {
            if (!asserting.has(name) && [...calls].some((c) => asserting.has(c))) grew = Boolean(asserting.add(name));
          }
        }
        for (const frame of pending) if (![...frame.calls].some((c) => asserting.has(c))) context.report({ node: frame.node, messageId: "none" });
      },
    };
  },
});

export const bad = [
  "it('adds', () => {});",
  "test('adds', () => { add(1, 2); });",
  "it.only('saves', async () => { await save(user); });",
  "function seed() { return db.insert(user); }\ntest('seeds', async () => { await seed(); });",
  "test('loads', async ({ page }) => { const row = await screen.findByText('Ada'); await page.goto('/'); });",
  "test.describe('users', () => { test.beforeEach(async () => { expect(await reset()).toBe(true); }); test('lists', async () => { await list(); }); });",
];

export const good = [
  "it('adds', () => { expect(add(1, 2)).toBe(3); });",
  "test('adds', () => { assert.equal(add(1, 2), 3); });",
  "test('adds', async (t) => { t.assert.equal(add(1, 2), 3); });",
  "it('responds', () => request(app).get('/').expect(200));",
  "it.todo('handles refunds');",
  "test('outer', async (t) => { await t.test('inner', () => { assert.ok(run()); }); });",
  "test.beforeEach(async ({ page }) => { await page.goto('/'); });",
  "test.describe('users', () => { test.afterAll(async () => { await db.close(); }); });",
  "function refused(res) { expect(res.status).toBe(404); }\nit('refuses', async () => { refused(await get('/x')); });",
  "it('refuses', async () => { denied(await get('/x')); });\nconst denied = (res) => refused(res);\nfunction refused(res) { assert.equal(res.status, 404); }",
  "test('applies', async ({ ui }) => { await ui.tap('apply'); await ui.require('Applied'); });",
  "it('shows the banner', async () => { render(page); await screen.findByText(/too many/i); });",
  "it('shows the error', () => { render(page); return screen.findByText('Email taken'); });",
  "test('redirects', async ({ page }) => { await page.goto('/roles'); await page.waitForURL('/403'); });",
  "test('options are typed', () => {\n  // @ts-expect-error retry takes a policy\n  client.get('/me', { retry: 3 });\n});",
];
