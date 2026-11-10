// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "./shared.mjs";

/**
 * Whether every write to the variable fills a lazy cache: `x ??= create()`, `x ||= …`, or an assignment under
 * `if (!x)`. A per-instance client or pool reused across requests is the point on serverless, not a leak.
 * @param {any} variable
 */
function lazyCache(variable) {
  const writes = variable.references.filter((/** @type {any} */ r) => r.isWrite() && r.writeExpr !== variable.defs[0]?.node.init);
  return writes.length > 0 && writes.every((/** @type {any} */ r) => {
    const assignment = r.identifier.parent;
    if (assignment?.type === "AssignmentExpression" && /^(?:\?\?|\|\|)=$/.test(assignment.operator)) return true;
    for (let n = assignment; n; n = n.parent) {
      if (n.type === "IfStatement" && n.test.type === "UnaryExpression" && n.test.operator === "!" && n.test.argument.name === variable.name) return true;
    }
    return false;
  });
}

export const id = "no-module-scope-let";
export const pack = "runtime";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      shared: "A module-level let lives as long as the instance, so on Workers and serverless it is shared by every request it serves and one request's data leaks into the next. Keep per-request state inside the handler; use const for true constants.",
    },
  },
  createOnce(context) {
    return {
      // Test files keep fixtures in module-level lets (`let server;` set in before()); they never serve requests.
      // A "use client" module runs in one browser tab, which serves one user.
      before: () => !isTestFile(context) && !/^\s*["']use client["']/.test(context.sourceCode.text),
      "Program > VariableDeclaration[kind=/^(let|var)$/]"(node) {
        const variables = context.sourceCode.getDeclaredVariables(node);
        if (variables.length && variables.every(lazyCache)) return;
        context.report({ node, messageId: "shared" });
      },
    };
  },
});

export const bad = [
  "let currentUser;\nexport default { fetch(request) { currentUser = auth(request); return handle(request); } };",
  "var requests = 0;\nexport function handler() { requests++; }",
  "let client;\nexport function connect(request) { client = createClient(request.headers.get('x-tenant')); return client; }",
];

export const good = [
  "const limit = 100;\nexport default { fetch(request) { let user = auth(request); return handle(request, user); } };",
  "export function handler(request) { let attempts = 0; while (attempts < 3) attempts++; return attempts; }",
  "for (let i = 0; i < 3; i++) warm(i);",
  "let client: Client | undefined;\nexport function getClient() { return (client ??= createClient()); }",
  "let pool;\nexport function getPool() {\n  if (!pool) pool = createPool();\n  return pool;\n}",
  "'use client';\nlet toastCount = 0;\nexport function nextToastId() { return ++toastCount; }",
];
