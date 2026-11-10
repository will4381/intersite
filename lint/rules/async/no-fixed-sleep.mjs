// @ts-check
import { relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

// Not `wait` or `pause`: those names mostly belong to animation and demo scripts, where a fixed beat is the point.
const sleepName = /^(sleep|delay|setTimeout)$/;
/** Tests, smoke scripts and fixtures, where a short wait often proves something did not happen. */
const testFile = /(^|[/._-])(tests?|testing|spec|e2e|smoke|fixtures?|__tests__)([/._-]|$)/;
const loops = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

/** @param {any} node */
const isDelay = (node) => node?.type === "Literal" && typeof node.value === "number" && node.value > 0;

/**
 * `sleep(500)`, `delay(500)`, `setTimeout(500)` from timers/promises, or `new Promise((r) => setTimeout(r, 500))`.
 * @param {any} node
 */
function isFixedSleep(node) {
  if (node.type === "CallExpression") {
    // Only bare calls: a method such as `actor.wait(300)` is usually an animation or a scripted demo.
    return node.callee.type === "Identifier" && sleepName.test(node.callee.name) && isDelay(node.arguments[0]);
  }
  if (node.type !== "NewExpression" || node.callee.name !== "Promise") return false;
  const executor = node.arguments[0];
  if (!executor?.type.endsWith("FunctionExpression")) return false;
  const inner = executor.body.type === "BlockStatement" ? (executor.body.body.length === 1 ? executor.body.body[0].expression : undefined) : executor.body;
  return inner?.type === "CallExpression" && inner.callee.name === "setTimeout" && isDelay(inner.arguments[1]);
}

export const id = "no-fixed-sleep";
export const pack = "async";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      sleep: "A fixed sleep guesses how long something takes: too short and it races, too long and it wastes time. Wait for the real condition instead: await the event or promise, or poll the condition with a timeout.",
    },
  },
  createOnce(context) {
    return {
      AwaitExpression(node) {
        if (!isFixedSleep(node.argument) || testFile.test(relative(context.cwd, context.filename))) return;
        // Only a sleep with more work after it is waiting for something. As the last statement it holds or paces.
        const statement = node.parent;
        const block = statement.parent;
        if (statement.type !== "ExpressionStatement" || block.type !== "BlockStatement" || block.body.at(-1) === statement) return;
        // A grace period that is then checked, `kill(pid); await sleep(1000); if (alive(pid)) ...`, is not a guess.
        const [next, after] = block.body.slice(block.body.indexOf(statement) + 1);
        if (next.type === "IfStatement" || (next.type === "VariableDeclaration" && after?.type === "IfStatement")) return;
        // In a loop it is a polling interval or a paced batch; in a catch, a single retry a moment later.
        for (let up = block; up && !up.type.endsWith("FunctionExpression") && up.type !== "FunctionDeclaration"; up = up.parent) {
          if (loops.has(up.type) || up.type === "CatchClause") return;
        }
        const fn = block.parent;
        if (fn.parent?.type === "CallExpression" && fn.parent.callee.property?.name === "catch") return;
        context.report({ node, messageId: "sleep" });
      },
    };
  },
});

export const bad = [
  "async function save() { await db.insert(row); await new Promise((r) => setTimeout(r, 2000)); return db.get(row.id); }",
  "async function start() { spawn('server'); await sleep(3000); return connect(); }",
  "async function stop(pid) { process.kill(pid); await delay(1500); await start(); }",
  "import { setTimeout } from 'node:timers/promises';\nasync function warm() { await setTimeout(500); await ping(); }",
  "async function deploy() {\n  // Wait 2 seconds for cleanup to complete\n  await new Promise((resolve) => { setTimeout(resolve, 2000); });\n  await run();\n}",
];

export const good = [
  "async function poll() { while (!(await ready())) { await sleep(500); } }",
  "async function retry(fn) { for (let i = 0; i < 5; i++) { try { return await fn(); } catch { await sleep(2 ** i * 100); } } }",
  "async function retry(attempt) { await sleep(backoff(attempt)); return send(); }",
  "async function send() { try { return await post(); } catch { await delay(1000); return post(); } }",
  "const out = await run().catch(async () => { await sleep(600); return run(); });",
  "async function chime() { play(); await sleep(2000); }",
  "async function script(actor) { await actor.wait(1000); await actor.key('cmd+k'); }",
  "async function tap() { press(); await wait(140); release(); }",
  "async function stop(pid) { process.kill(pid, 'SIGTERM'); await delay(1000); const alive = listeners(port); if (alive.length) process.kill(pid, 'SIGKILL'); }",
  "async function tick() { await new Promise((r) => setTimeout(r, 0)); render(); }",
  "async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }",
  "async function start() { await waitForPort(3000); }",
];
