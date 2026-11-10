// @ts-check
import { defineRule } from "@oxlint/plugins";

import { chainMethods, chainRoot, dependencyRange, importsModule } from "./syntax.mjs";

/** A Workers file: imports the runtime, or handles requests with an ExecutionContext or a Durable Object (or its package deploys with wrangler). */
const WORKER = /["']cloudflare:workers["']|\bExecutionContext\b|\bDurableObjectState\b|\.waitUntil\(/;

/** Binding methods that start I/O: KV, R2, D1, Queues, service bindings, Durable Object stubs. */
const BINDING_IO = /^(put|delete|send|sendBatch|fetch|run|all|first|batch|exec|get|list)$/;

/** `env`, `this.env`, `c.env`: where Worker bindings live. @param {any} node */
function isEnv(node) {
  return (node?.type === "Identifier" && node.name === "env") || (node?.type === "MemberExpression" && !node.computed && node.property.name === "env");
}

/** The `env` a call chain starts from, if any: `env.KV.put(...)` and `this.env.QUEUE.send(...)`. @param {any} call */
function envRoot(call) {
  for (let n = call.callee; n?.type === "MemberExpression" || n?.type === "CallExpression"; n = n.type === "CallExpression" ? n.callee : n.object) {
    if (n.type === "MemberExpression" && isEnv(n.object)) return n.object;
  }
  return undefined;
}

export const id = "no-floating-worker-promise";
export const pack = "workers";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      floating: "This promise is neither awaited nor passed to ctx.waitUntil(), and a Worker cancels unfinished work once the response is returned, so `{{call}}` may never finish and its errors vanish. Await it, or hand it to ctx.waitUntil(...) (or `waitUntil` from \"cloudflare:workers\") to run after the response.",
    },
  },
  createOnce(context) {
    /** @type {Map<string, boolean>} functions and methods this file declares -> all of that name are async */
    let declared;
    /** @param {string} name @param {boolean} isAsync */
    const declare = (name, isAsync) => declared.set(name, (declared.get(name) ?? true) && isAsync);
    /** @type {{ node: any, text: string, local?: string }[]} statements that start I/O, or call `local` if it is async */
    let candidates;
    return {
      before() {
        declared = new Map();
        candidates = [];
        if (WORKER.test(context.sourceCode.text)) return true;
        // Browser code in the same wrangler package (components, hooks) may float promises freely.
        const browser = /\.[jt]sx$/.test(context.filename) || importsModule(context.sourceCode.ast, /^react(-dom)?(\/|$)/);
        return !browser && Boolean(dependencyRange(context.filename, "wrangler"));
      },
      FunctionDeclaration(node) {
        if (node.id) declare(node.id.name, node.async);
      },
      VariableDeclarator(node) {
        const init = /** @type {any} */ (node.init);
        if (init?.type.endsWith("FunctionExpression") && node.id.type === "Identifier") declare(node.id.name, init.async);
      },
      MethodDefinition(node) {
        const value = /** @type {any} */ (node.value);
        if (node.key.type === "Identifier") declare(`this.${node.key.name}`, value.async);
      },
      ExpressionStatement(node) {
        let call = /** @type {any} */ (node.expression);
        if (call.type === "UnaryExpression" && call.operator === "void") call = call.argument;
        if (call.type !== "CallExpression") return;
        const methods = chainMethods(call);
        // Durable Object storage writes are held by the output gate until they land, so they need no await.
        if (methods.includes("storage") || methods.includes("waitUntil")) return;
        const root = chainRoot(call);
        const text = context.sourceCode.getText(call).split("\n")[0].slice(0, 60);
        if ((root?.type === "Identifier" && root.name === "fetch") || (envRoot(call) && methods.some((m) => BINDING_IO.test(m)))) return candidates.push({ node, text });
        // A call to an async function or method of this file: `logEvent(env, e)`, `this.flush()`.
        const callee = call.callee;
        const local = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.object.type === "ThisExpression" ? `this.${callee.property.name}` : undefined;
        if (local) candidates.push({ node, text, local });
      },
      "Program:exit"() {
        for (const c of candidates) if (!c.local || declared.get(c.local)) context.report({ node: c.node, messageId: "floating", data: { call: c.text } });
      },
    };
  },
});

export const bad = [
  "export default {\n  async fetch(request: Request, env: Env, ctx: ExecutionContext) {\n    env.ANALYTICS_KV.put(`hit:${Date.now()}`, request.url);\n    return new Response('ok');\n  },\n};",
  "async function audit(env: Env, event: string) {\n  await env.DB.prepare('insert into audit (event) values (?)').bind(event).run();\n}\nexport default {\n  async fetch(request: Request, env: Env, ctx: ExecutionContext) {\n    audit(env, 'visit');\n    return new Response('ok');\n  },\n};",
  "export default {\n  async fetch(request: Request, env: Env, ctx: ExecutionContext) {\n    fetch('https://hooks.example.com/ping', { method: 'POST' }).catch(() => {});\n    return Response.json({ ok: true });\n  },\n};",
  "import { DurableObject } from 'cloudflare:workers';\nexport class Room extends DurableObject {\n  async flush() { await this.env.QUEUE.send({ room: this.ctx.id.toString() }); }\n  async fetch() {\n    void this.flush();\n    return new Response('ok');\n  }\n}",
];

export const good = [
  "export default {\n  async fetch(request: Request, env: Env, ctx: ExecutionContext) {\n    ctx.waitUntil(env.ANALYTICS_KV.put(`hit:${Date.now()}`, request.url));\n    return new Response('ok');\n  },\n};",
  "export default {\n  async fetch(request: Request, env: Env, ctx: ExecutionContext) {\n    await env.QUEUE.send({ url: request.url });\n    return new Response('ok');\n  },\n};",
  "import { DurableObject } from 'cloudflare:workers';\nexport class Counter extends DurableObject {\n  async fetch() {\n    this.ctx.storage.put('count', 1);\n    return new Response('ok');\n  }\n}",
  "export async function handler(request: Request) {\n  fetch('https://hooks.example.com/ping');\n  return new Response('ok');\n}",
  "export default {\n  async fetch(request: Request, env: Env, ctx: ExecutionContext) {\n    log(request.url);\n    cache.set(request.url, Date.now());\n    return new Response('ok');\n  },\n};",
];
