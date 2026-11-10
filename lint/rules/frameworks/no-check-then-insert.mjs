// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isScriptFile, unwrap, walk } from "../shared.mjs";
import { chainMethods } from "./syntax.mjs";

/**
 * What a read looks up, as `model:<name>` or `table:<name>`: Prisma `prisma.user.findFirst(...)`, Drizzle
 * `db.query.users.findFirst(...)` or `db.select().from(users)...`. Undefined for anything else.
 * @param {any} node
 */
function readTarget(node) {
  const call = unwrap(node);
  if (call?.type !== "CallExpression") return undefined;
  const callee = call.callee;
  if (callee.type === "MemberExpression" && /^(findFirst|findUnique)$/.test(callee.property.name) && callee.object.type === "MemberExpression" && call.arguments.length) {
    const owner = callee.object.object;
    // `db.query.users.findFirst` names a table; `prisma.user.findFirst` names a model.
    return owner.type === "MemberExpression" && owner.property.name === "query" ? `table:${callee.object.property.name}` : `model:${callee.object.property.name}`;
  }
  if (!chainMethods(call).includes("where")) return undefined;
  /** @type {string | undefined} */
  let table;
  walk(call, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "from" && n.arguments[0]?.type === "Identifier") table = `table:${n.arguments[0].name}`;
  });
  return table;
}

/** Whether `node` creates a row of `target`: `prisma.user.create(...)` or `db.insert(users)`. @param {any} node @param {string} target */
function createsRow(node, target) {
  let found = false;
  walk(node, (n) => {
    if (found || n.type !== "CallExpression" || n.callee.type !== "MemberExpression") return;
    const { property, object } = n.callee;
    if (target.startsWith("model:") && property.name === "create" && object.type === "MemberExpression" && `model:${object.property.name}` === target) found = true;
    if (target.startsWith("table:") && property.name === "insert" && `table:${n.arguments[0]?.name}` === target) found = true;
  });
  return found;
}

/** The name `const x = await …` or `const [x] = await …` binds. @param {any} declarator */
const boundName = (declarator) => declarator.id.type === "Identifier" ? declarator.id.name : declarator.id.type === "ArrayPattern" && declarator.id.elements[0]?.type === "Identifier" ? declarator.id.elements[0].name : undefined;

/** `!x`, `x == null`, `x === undefined`. @param {any} test @param {string} name */
const testsMissing = (test, name) =>
  (test.type === "UnaryExpression" && test.operator === "!" && test.argument.type === "Identifier" && test.argument.name === name) ||
  (test.type === "BinaryExpression" && /^===?$/.test(test.operator) && test.left.name === name && (test.right.value === null || test.right.name === "undefined"));

export const id = "no-check-then-insert";
export const pack = "orm";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      race: "This reads `{{name}}` and inserts it when it is missing, so two requests at once both see nothing and both insert: a duplicate row, or a unique-constraint error surfacing as a 500. Do it in one statement: Prisma upsert, or Drizzle .insert(...).onConflictDoNothing() / .onConflictDoUpdate(...) on the unique column.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return !isScriptFile(context);
      },
      // Statements of one block: `const x = await read(...)` then `if (!x) { …create… }`.
      BlockStatement(node) {
        /** @type {Map<string, string>} name -> what it read */
        const reads = new Map();
        for (const statement of /** @type {any[]} */ (node.body)) {
          if (statement.type === "VariableDeclaration") {
            for (const d of statement.declarations) {
              const name = boundName(d);
              const target = name && unwrap(d.init) !== d.init && readTarget(d.init);
              if (name && target) reads.set(name, target);
            }
          } else if (statement.type === "IfStatement") {
            for (const [name, target] of reads) if (testsMissing(statement.test, name) && createsRow(statement.consequent, target)) context.report({ node: statement, messageId: "race", data: { name } });
          }
        }
      },
    };
  },
});

export const bad = [
  "async function follow(userId: string, targetId: string) {\n  const existing = await prisma.follow.findFirst({ where: { userId, targetId } });\n  if (!existing) {\n    await prisma.follow.create({ data: { userId, targetId } });\n  }\n}",
  "async function ensureProfile(id: string) {\n  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, id)).limit(1);\n  if (!profile) await db.insert(profiles).values({ userId: id });\n}",
  "async function tag(name: string) {\n  let tag = await db.query.tags.findFirst({ where: eq(tags.name, name) });\n  if (tag == null) {\n    [tag] = await db.insert(tags).values({ name }).returning();\n  }\n  return tag;\n}",
];

export const good = [
  "async function follow(userId: string, targetId: string) {\n  await prisma.follow.upsert({ where: { userId_targetId: { userId, targetId } }, create: { userId, targetId }, update: {} });\n}",
  "async function ensureProfile(id: string) {\n  await db.insert(profiles).values({ userId: id }).onConflictDoNothing();\n}",
  "async function signUp(email: string) {\n  const taken = await prisma.user.findUnique({ where: { email } });\n  if (taken) throw new Error('Email in use');\n  return prisma.user.create({ data: { email } });\n}",
  "async function log(userId: string) {\n  const user = await prisma.user.findUnique({ where: { id: userId } });\n  if (!user) {\n    await prisma.audit.create({ data: { event: 'missing-user', userId } });\n  }\n}",
];
