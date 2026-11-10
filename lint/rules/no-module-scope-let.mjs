// @ts-check
import { matchesGlob, relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

import { TEST_PATHS } from "../../shared/config.mjs";

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
      before() {
        const file = relative(context.cwd, context.filename);
        return !TEST_PATHS.some((glob) => matchesGlob(file, glob));
      },
      "Program > VariableDeclaration[kind=/^(let|var)$/], Program > ExportNamedDeclaration > VariableDeclaration[kind=/^(let|var)$/]"(node) {
        context.report({ node, messageId: "shared" });
      },
    };
  },
});

export const bad = [
  "let currentUser;\nexport default { fetch(request) { currentUser = auth(request); return handle(request); } };",
  "export let cache = new Map();",
  "var requests = 0;\nexport function handler() { requests++; }",
];

export const good = [
  "const limit = 100;\nexport default { fetch(request) { let user = auth(request); return handle(request, user); } };",
  "export function handler(request) { let attempts = 0; while (attempts < 3) attempts++; return attempts; }",
  "for (let i = 0; i < 3; i++) warm(i);",
];
