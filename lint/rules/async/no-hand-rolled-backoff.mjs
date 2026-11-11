// @ts-check
import { defineRule } from "@oxlint/plugins";

import { filePath, isGenerated, isMethodCall, isTestFile, walk } from "../shared.mjs";

/** The project's retry helper, where the schedule is meant to live: a file whose name says retry or backoff. */
const RETRY_HOME = /(?:^|\/)[^/]*(?:retry|retries|backoff)[^/]*$/i;
/** A name that says the number is a wait or a retry count. */
const TIMING = /attempt|retr(y|ies)|failure|backoff|delay|wait|sleep|timeout|interval|cooldown/i;

/** The name a node is called or stored under: `delay` in `const delay = …`, `{ delay: … }`, `delay = …`, `sleep(…)`. @param {any} node */
function nameOf(node) {
  if (node.type === "VariableDeclarator" || node.type === "PropertyDefinition") return node.id?.name ?? node.key?.name;
  if (node.type === "Property") return node.key?.name;
  if (node.type === "AssignmentExpression") return node.left.name ?? node.left.property?.name;
  if (node.type === "CallExpression") return node.callee.name ?? node.callee.property?.name;
  return undefined;
}

/**
 * `2 ** attempt`, or `2 ** n` whose result is a delay: the exponent names a retry count, or the expression is stored as
 * or passed to something named for waiting. `2 ** ((note - 69) / 12)` and `2 ** 32` are arithmetic, not a schedule.
 * @param {any} node
 */
function isBackoff(node) {
  let timed = false;
  walk(node.type === "BinaryExpression" ? node.right : node.arguments[1], (n) => {
    if (n.type === "Identifier" && TIMING.test(n.name)) timed = true;
  });
  for (let up = node.parent; !timed && up && !up.type.endsWith("Statement") && !up.type.includes("Function"); up = up.parent) timed = TIMING.test(nameOf(up) ?? "");
  return timed;
}

export const id = "no-hand-rolled-backoff";
export const pack = "async";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      doubling: "This doubles a delay by hand, which adds one more retry schedule to the project, each with its own cap and jitter, or none. Call the project's shared retry helper; if there is none yet, write one in a file named for retry or backoff and use it everywhere.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context) && !isGenerated(context) && !RETRY_HOME.test(filePath(context)),
      BinaryExpression(node) {
        if (node.operator === "**" && /** @type {any} */ (node.left).value === 2 && node.right.type !== "Literal" && isBackoff(node)) context.report({ node, messageId: "doubling" });
      },
      CallExpression(node) {
        const [base, exponent] = /** @type {any[]} */ (node.arguments);
        if (isMethodCall(node, "Math", "pow") && base?.value === 2 && exponent && exponent.type !== "Literal" && isBackoff(node)) context.report({ node, messageId: "doubling" });
      },
    };
  },
});

export const bad = [
  "export async function send(job: Job, attempt: number) { await sleep(1000 * 2 ** attempt); return deliver(job); }",
  "export const nextRunAt = (failures: number) => Date.now() + 60_000 * 2 ** (failures - 1);",
  "export function schedule(n: number) { const delay = Math.min(30_000, 500 * 2 ** n); setTimeout(run, delay); }",
  "export function wait(retries: number) { return new Promise((resolve) => setTimeout(resolve, Math.pow(2, retries) * 100)); }",
];

export const good = [
  "import { retryDelay } from './retry.js';\nexport async function send(job: Job, attempt: number) { await sleep(retryDelay(attempt)); return deliver(job); }",
  "export const frequency = (note: number) => 440 * 2 ** ((note - 69) / 12);",
  "export const MAX_ID = 2 ** 32;",
  "export const bucketSize = (level: number) => 2 ** level;",
];
