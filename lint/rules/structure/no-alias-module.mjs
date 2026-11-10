// @ts-check
import { basename } from "node:path";

import { defineRule } from "@oxlint/plugins";

/** A statement that only re-exports: `export * from './x'`, `export { a } from './x'`. @param {any} s */
const isReExport = (s) => s.type === "ExportAllDeclaration" || (s.type === "ExportNamedDeclaration" && s.source && !s.declaration);

export const id = "no-alias-module";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      alias: "This file only re-exports {{source}}, so every import of it is a detour through a second path to the same code. Import from {{source}} directly and delete this file.",
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        // index files are a package's public entry, and .d.ts files describe other code; both re-export by design.
        if (/^index\.|\.d\.[cm]?ts$/.test(basename(context.filename))) return;
        const body = node.body.filter((/** @type {any} */ s) => !(s.type === "ExpressionStatement" && s.directive));
        if (!body.length || !body.every(isReExport)) return;
        const sources = new Set(body.map((/** @type {any} */ s) => s.source.value));
        // A file gathering several modules is a deliberate facade; one source is a second name for one module.
        if (sources.size !== 1) return;
        // Re-exporting a package (export * from 'zod') pins one import site for a dependency, which is a real choice.
        const [source] = sources;
        if (!source.startsWith(".")) return;
        context.report({ node: body[0], messageId: "alias", data: { source } });
      },
    };
  },
});

export const bad = [
  "export * from './user-service';",
  "export { createUser, deleteUser } from '../users/actions';\nexport type { User } from '../users/actions';",
  "'use client';\nexport { Button as PrimaryButton } from './button';",
];

export const good = [
  "export * from './users';\nexport * from './teams';",
  "export { z } from 'zod';",
  "export { createUser } from './actions';\nexport const VERSION = 2;",
  "import { createUser } from './actions';\nexport const create = (name: string) => createUser({ name, role: 'member' });",
];
