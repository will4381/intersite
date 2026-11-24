// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, mentions, unwrap } from "../shared.mjs";

const NEEDS = /recursive/;
/** Node's recursive deletes: `rm`, `rmSync`, `rmdir`, `rmdirSync`, on `fs`, `fs.promises` or imported. */
const REMOVE = /^(rm|rmSync|rmdir|rmdirSync)$/;
/**
 * A path built from outside the program: an environment variable (unset, it is empty) or a request. A command-line
 * argument is left out: a tool that deletes the folder its user names does what it was asked.
 */
const OUTSIDE = /\bprocess\.env\b|\b(?:req|request|ctx\.req|c\.req|event)\.(?:body|query|params|url)\b|\bsearchParams\b|\bformData\b/;

export const id = "no-unguarded-recursive-rm";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "This deletes recursively at a path built from {{ source }}: unset, it becomes the current folder or `/`; from a request, `../` reaches anywhere the process can write. Resolve the path, check it is inside the folder you mean to clear (`path.relative(root, target)` must not start with `..` and must not be empty), then delete.",
    },
  },
  createOnce(context) {
    return {
      before: () => mentions(context, NEEDS),
      CallExpression(/** @type {any} */ node) {
        if (!REMOVE.test(calleeName(node) ?? "")) return;
        const options = unwrap(node.arguments[1]);
        const recursive = options?.type === "ObjectExpression" && options.properties.some((/** @type {any} */ p) => p.key?.name === "recursive" && p.value?.value === true);
        if (!recursive) return;
        let target = unwrap(node.arguments[0]);
        if (target?.type === "Identifier") target = unwrap(constInit(target, context.sourceCode)) ?? target;
        const source = target && OUTSIDE.exec(context.sourceCode.getText(target))?.[0];
        if (source) context.report({ node, messageId: "found", data: { source: source.startsWith("process.") ? `\`${source}\`` : "the request" } });
      },
    };
  },
});

export const bad = [
  "import { rmSync } from 'node:fs';\nexport const clean = () => rmSync(process.env.BUILD_DIR, { recursive: true, force: true });",
  "import fs from 'node:fs/promises';\nimport path from 'node:path';\nexport const wipe = () => fs.rm(path.join(process.env.CACHE_ROOT ?? '', 'cache'), { recursive: true });",
  "import { rm } from 'node:fs/promises';\nexport async function remove(req: Request) {\n  const dir = `uploads/${req.query.folder}`;\n  await rm(dir, { recursive: true, force: true });\n}",
];

export const good = [
  "import { rmSync } from 'node:fs';\nexport const clean = () => rmSync('dist', { recursive: true, force: true });",
  "import fs from 'node:fs';\nimport path from 'node:path';\nconst out = path.resolve(process.argv[2] ?? 'dist');\nfs.rmSync(out, { recursive: true });",
  "import { mkdtempSync, rmSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nexport function scratch() {\n  const dir = mkdtempSync(tmpdir() + '/x-');\n  rmSync(dir, { recursive: true, force: true });\n}",
  "import { rm } from 'node:fs/promises';\nexport const drop = () => rm(process.env.LOCK_FILE ?? 'app.lock');",
  "import { rm } from 'node:fs/promises';\nexport async function remove(root: string, name: string) {\n  await rm(safeJoin(root, name), { recursive: true });\n}",
];
