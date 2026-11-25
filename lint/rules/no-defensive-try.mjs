// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isGenerated, walk } from "./shared.mjs";

/** Nodes that can throw: a call, `new`, `await`, `throw`, a property read (on undefined), iteration, `yield`. */
const THROWS = /^(CallExpression|NewExpression|AwaitExpression|ThrowStatement|MemberExpression|TaggedTemplateExpression|YieldExpression|ForOfStatement|ForInStatement|ImportExpression|SpreadElement)$/;

/** Whether a try block holds nothing that can throw, functions declared in it aside (they run later). @param {any} block */
function cannotThrow(block) {
  let can = false;
  walk(block, (n) => {
    if (FUNCTIONS.has(n.type)) return false;
    if (THROWS.test(n.type)) can = true;
    return !can;
  });
  return !can;
}

/** A message that says less than the error it replaces: "Failed", "Something went wrong", "Error loading data". @param {any} arg */
function isGeneric(arg) {
  const text = arg?.type === "Literal" && typeof arg.value === "string" ? arg.value : arg?.type === "TemplateLiteral" && !arg.expressions.length ? arg.quasis[0].value.cooked : undefined;
  return text !== undefined && text.split(/\s+/).length <= 5 && /^(failed|failure|error|something went wrong|an error occurred|unable to|could not|unexpected error|internal error)\b/i.test(text.trim());
}

/** A catch whose only statement throws a new error with a generic message. @param {any} handler */
function rethrowsGeneric(handler) {
  const [only, ...rest] = handler?.body.body ?? [];
  const thrown = only?.type === "ThrowStatement" ? only.argument : undefined;
  return !rest.length && thrown?.type === "NewExpression" && (thrown.callee.name ?? "").endsWith("Error") && isGeneric(thrown.arguments[0]);
}

export const id = "no-defensive-try";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      nothing: "Nothing in this try block can throw, so the catch never runs: it only adds a branch every reader has to rule out. Remove the try.",
      generic: "This try wraps the whole function only to throw \"{{message}}\", which says less than the error it replaces, and every caller now sees two errors for one failure. Remove the try and let the original error propagate; catch where something can actually be done about it.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isGenerated(context),
      TryStatement(node) {
        if (node.handler && cannotThrow(node.block)) return context.report({ node, messageId: "nothing" });
        const fn = node.parent?.parent;
        const wholeBody = node.parent?.type === "BlockStatement" && FUNCTIONS.has(fn?.type ?? "") && node.parent.body.length === 1;
        if (wholeBody && !node.finalizer && rethrowsGeneric(node.handler)) {
          const arg = /** @type {any} */ (node.handler).body.body[0].argument.arguments[0];
          context.report({ node, messageId: "generic", data: { message: arg.value ?? arg.quasis[0].value.cooked } });
        }
      },
    };
  },
});

export const bad = [
  "export function total(a: number, b: number) { let sum = 0; try { sum = a + b; } catch { sum = 0; } return sum; }",
  "export async function loadUser(id: string) { try { return await db.user.find(id); } catch (error) { throw new Error('Failed to load user', { cause: error }); } }",
  "export const save = async (row) => { try { await api.post('/rows', row); } catch (e) { throw new Error(`Something went wrong`); } };",
];

export const good = [
  "export async function loadUser(id: string) { try { return await db.user.find(id); } catch (error) { if (isNotFound(error)) return undefined; throw error; } }",
  "export async function loadUser(id: string) { try { return await db.user.find(id); } catch (error) { throw new Error(`loading user ${id} from the replica`, { cause: error }); } }",
  "export async function sync() { const rows = await read(); try { await write(rows); } catch (error) { throw new Error('Failed to write', { cause: error }); } }",
  "export function parse(text: string) { try { return JSON.parse(text); } catch { return undefined; } }",
  "export async function run() { try { await step(); } finally { await cleanup(); } }",
];
