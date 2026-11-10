// @ts-check
import { basename } from "node:path";

import { defineRule } from "@oxlint/plugins";

import { filePath } from "../shared.mjs";

/** A statement that only re-exports: `export * from './x'`, `export { a } from './x'`. @param {any} s */
const isReExport = (s) => s.type === "ExportAllDeclaration" || (s.type === "ExportNamedDeclaration" && s.source && !s.declaration);

/** An import, or an export of names it brought in: `import x from './x'; export default x;`, `export { a };`. @param {any} s */
const isImportExport = (s) =>
  s.type === "ImportDeclaration" ||
  (s.type === "ExportNamedDeclaration" && !s.source && !s.declaration) ||
  (s.type === "ExportDefaultDeclaration" && s.declaration.type === "Identifier");

/**
 * Files whose path is the point: index files (a package's public entry), `.d.ts` files, framework routes (Next.js
 * `page`/`layout`/`route`, `pages/`, Remix `app/routes`, SvelteKit `+page`), and tool configs (`*.config.*`),
 * which a tool loads by name. Re-exporting into them is how they are wired.
 */
const BY_PATH = /^index\.|\.d\.[cm]?ts$|^(?:page|layout|route|template|default|loading|error|global-error|not-found|middleware|instrumentation)\.[cm]?[jt]sx?$|^\+|\.config\.[cm]?[jt]s$|^\./;
// ponytail: Expo Router files outside `routes/` (app/settings.tsx re-exporting a screen) still report; `app/` is also Angular's whole source tree.
const ROUTE_DIR = /(?:^|\/)(?:pages|routes)\//;

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
        if (BY_PATH.test(basename(context.filename)) || ROUTE_DIR.test(filePath(context))) return;
        const body = node.body.filter((/** @type {any} */ s) => !(s.type === "ExpressionStatement" && s.directive));
        if (!body.length || !body.every((/** @type {any} */ s) => isReExport(s) || isImportExport(s)) || !body.some((/** @type {any} */ s) => s.type.startsWith("Export"))) return;
        const sources = new Set(body.filter((/** @type {any} */ s) => s.source).map((/** @type {any} */ s) => s.source.value));
        // A file gathering several modules is a deliberate facade; one source is a second name for one module.
        if (sources.size !== 1) return;
        const [source] = sources;
        // Re-exporting a package (export * from 'zod') pins one import site for a dependency, which is a real choice; a
        // generated module gets a stable hand-written path while its generated one churns.
        if (!source.startsWith(".") || /generated|\.gen(?:\.|$)/.test(source)) return;
        context.report({ node: body[0], messageId: "alias", data: { source } });
      },
    };
  },
});

export const bad = [
  "export * from './user-service';",
  "export { createUser, deleteUser } from '../users/actions';\nexport type { User } from '../users/actions';",
  "'use client';\nexport { Button as PrimaryButton } from './button';",
  "import { createUser } from './users';\nexport { createUser };",
  "import Button from './button';\nexport default Button;",
];

export const good = [
  "export * from './users';\nexport * from './teams';",
  "export { z } from 'zod';",
  "export { createUser } from './actions';\nexport const VERSION = 2;",
  "import { createUser } from './actions';\nexport const create = (name: string) => createUser({ name, role: 'member' });",
  "export * from './schema.generated';",
  "import './polyfills';\nexport * from './app';",
  "import { setup } from './setup';\nsetup();",
];
