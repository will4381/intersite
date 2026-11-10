// @ts-check
import { defineRule } from "@oxlint/plugins";

const LIMIT = 3;

/** The ternary under parentheses and TypeScript casts, if there is one. @param {any} node */
function ternary(node) {
  while (node && (node.type === "ParenthesizedExpression" || node.type === "TSAsExpression" || node.type === "TSNonNullExpression")) node = node.expression;
  return node?.type === "ConditionalExpression" ? node : undefined;
}

/** Ternaries in this nest, and whether any sits in a condition or first branch. @param {any} node @returns {[number, boolean]} */
function nest(node) {
  let count = 1, inner = false;
  for (const [child, position] of [[node.test, true], [node.consequent, true], [node.alternate, false]]) {
    const t = ternary(child);
    if (!t) continue;
    const [n, i] = nest(t);
    count += n;
    inner ||= i || position;
  }
  return [count, inner];
}

export const id = "no-nested-ternary";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      nested: `This expression nests ${LIMIT} or more ternaries, some inside a condition or a first branch, so it has to be untangled from the inside out. Use if/else with early returns, or name the inner result in a variable first. A flat chain (a ? x : b ? y : z) reads top to bottom and is fine.`,
    },
  },
  createOnce(context) {
    return {
      ConditionalExpression(node) {
        let parent = node.parent;
        while (parent.type === "ParenthesizedExpression" || parent.type === "TSAsExpression" || parent.type === "TSNonNullExpression") parent = parent.parent;
        if (parent.type === "ConditionalExpression") return;
        const [count, inner] = nest(node);
        if (inner && count >= LIMIT) context.report({ node, messageId: "nested" });
      },
    };
  },
});

export const bad = [
  "export const label = done ? (failed ? 'Failed' : retried ? 'Retried' : 'Done') : 'Running';",
  "export const size = (wide ? full : half) ? (tall ? 'large' : 'wide') : 'small';",
  "export const price = member ? (annual ? yearly * 0.8 : monthly) : annual ? yearly : monthly;",
  "export const owner = imported\n  ? isService(principal)\n    ? await readService(principal)\n    : 'kind' in principal ? null : await readOwner(principal)\n  : null;",
];

export const good = [
  "export const label = failed ? 'Failed' : done ? 'Done' : running ? 'Running' : 'Idle';",
  "export const icon = on ? (direction === 'asc' ? up : down) : neutral;",
  "export function label(done, failed, retried) { if (!done) return 'Running'; if (failed) return 'Failed'; return retried ? 'Retried' : 'Done'; }",
  "export const fn = ready ? () => (big ? (huge ? 1 : 2) : 3) : undefined;",
];
