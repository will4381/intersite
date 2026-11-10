// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, isScriptFile, notShipped, receiverName, resolveVariable, unwrap } from "../shared.mjs";

// Calls that run their string as SQL whatever it looks like: Drizzle/Knex/Prisma `raw`, postgres.js `unsafe`, Prisma's
// unsafe raw queries, Knex `whereRaw` and friends.
const RAW = /^(raw|unsafe|\$queryRawUnsafe|\$executeRawUnsafe|(or)?(where|having)Raw|(orderBy|groupBy|join|from|select)Raw)$/;
// Calls that run SQL when given SQL: pg/mysql `query`, `execute`, better-sqlite3 and D1 `prepare`, sqlite3 `run`/`all`/`exec`.
const RUNS = /^(query|execute|exec|prepare|run|all)$/;
// TypeORM query builder conditions, which take a SQL fragment: `.where(\`u.email = '${email}'\`)`.
const CONDITION = /^(where|andWhere|orWhere|having|andHaving|orHaving)$/;
const SQL = /^\s*\(?\s*(select|insert|update|delete|with|create|alter|drop|truncate|merge|replace|pragma|explain|call|grant|revoke)\b|\b(select\s[\s\S]*\sfrom|insert\s+into|delete\s+from|update\s+\S+\s+set|where)\s/i;
const COMPARISON = /[=<>]|\b(like|in|is|between)\b/i;
const UPPER = /^[A-Z][A-Z0-9_]*$/;
// `ids.map(() => '?').join(',')`, `words.map(() => "AND x LIKE ?")`, `ids.map((_, i) => \`$${i + 1}\`)`: placeholders.
const PLACEHOLDERS = /\?['"`]|\$\$\{/;

/**
 * The pieces of a string built in code, as static text and interpolated expressions: a template, `String.raw`, a `+`
 * concatenation, `[...].join(sep)`, or a `const` set to one. Undefined for anything else.
 * @param {any} node @param {any} sourceCode @param {number} [depth]
 * @returns {({ text: string } | { expr: any })[] | undefined}
 */
export function pieces(node, sourceCode, depth = 0) {
  node = unwrap(node);
  if (node?.type === "TaggedTemplateExpression" && sourceCode.getText(node.tag) === "String.raw") node = node.quasi;
  if (node?.type === "Literal") return typeof node.value === "string" ? [{ text: node.value }] : undefined;
  if (node?.type === "TemplateLiteral") return node.quasis.flatMap((/** @type {any} */ q, /** @type {number} */ i) => [{ text: q.value.cooked ?? q.value.raw }, ...(i < node.expressions.length ? [{ expr: node.expressions[i] }] : [])]);
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = pieces(node.left, sourceCode, depth);
    const right = pieces(node.right, sourceCode, depth);
    return left || right ? [...(left ?? [{ expr: node.left }]), ...(right ?? [{ expr: node.right }])] : undefined;
  }
  if (calleeName(node) === "join" && unwrap(node.callee.object)?.type === "ArrayExpression") {
    const sep = node.arguments[0]?.type === "Literal" ? String(node.arguments[0].value) : ",";
    return unwrap(node.callee.object).elements.flatMap((/** @type {any} */ e, /** @type {number} */ i) => [...(i ? [{ text: sep }] : []), ...(pieces(e, sourceCode, depth) ?? [{ expr: e }])]);
  }
  if (node?.type === "Identifier" && depth < 2) {
    const init = constInit(node, sourceCode);
    return init && unwrap(init) !== node ? pieces(init, sourceCode, depth + 1) : undefined;
  }
  return undefined;
}

/**
 * True when a value written into a string is fixed by the code, not by a caller: a literal, a number, an UPPER_CASE
 * constant, an import or something read off one (`users.name.name`, `this.table`), a placeholder list, or a `const`
 * set to one of those.
 * @param {any} node @param {any} sourceCode @param {number} [depth]
 */
export function isCodeValue(node, sourceCode, depth = 0) {
  node = unwrap(node);
  if (!node || depth > 3) return false;
  const again = (/** @type {any} */ n) => isCodeValue(n, sourceCode, depth + 1);
  switch (node.type) {
    case "Literal":
      return true;
    case "TemplateLiteral":
      return node.expressions.every(again);
    case "UnaryExpression":
      return node.operator !== "void" && node.operator !== "delete";
    case "BinaryExpression":
      return node.operator !== "+" || (again(node.left) && again(node.right));
    case "ConditionalExpression":
      return again(node.consequent) && again(node.alternate);
    case "CallExpression":
      // Numbers cannot break out of a query; a placeholder list is what parameterizing an IN looks like.
      return /^(Number|parseInt|parseFloat|toFixed|identifier)$/.test(calleeName(node)) || receiverName(node) === "Math" || PLACEHOLDERS.test(sourceCode.getText(node));
    case "MemberExpression": {
      if (!node.computed && node.property.name === "length") return true;
      let root = node;
      while (root.type === "MemberExpression") root = unwrap(root.object);
      return root.type === "ThisExpression" || (root.type === "Identifier" && isCodeName(root, sourceCode, depth));
    }
    case "Identifier":
      return isCodeName(node, sourceCode, depth);
    default:
      return false;
  }
}

/** An UPPER_CASE constant, an import, or a `const` set to a code value or placeholder list. @param {any} node @param {any} sourceCode @param {number} depth */
function isCodeName(node, sourceCode, depth) {
  if (UPPER.test(node.name)) return true;
  if (resolveVariable(node, sourceCode)?.defs[0]?.type === "ImportBinding") return true;
  const init = constInit(node, sourceCode);
  return init !== undefined && (PLACEHOLDERS.test(sourceCode.getText(init)) || isCodeValue(init, sourceCode, depth + 1));
}

/**
 * The first interpolated value a caller controls. With `quotedOnly` (the call also passes parameters, so bare
 * interpolations are usually placeholders or identifiers), only one written inside '...' counts.
 * @param {({ text: string } | { expr: any })[]} parts @param {any} sourceCode @param {boolean} quotedOnly
 */
export function firstDynamic(parts, sourceCode, quotedOnly) {
  let before = "";
  for (const p of parts) {
    if ("text" in p) before += p.text;
    else if (!isCodeValue(p.expr, sourceCode) && (!quotedOnly || (before.match(/'/g)?.length ?? 0) % 2 === 1)) return p.expr;
  }
  return undefined;
}

/** The static text of a built string. @param {({ text: string } | { expr: any })[]} parts */
const staticText = (parts) => parts.map((p) => ("text" in p ? p.text : " ? ")).join("");

export const id = "no-interpolated-sql";
export const pack = "security";
// ponytail: no data flow: SQL built with `let`/`+=`, passed through a helper's parameter or a wrapper not named *query, or an unquoted interpolation in a call that also passes parameters, is not reported.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      sql: "`{{value}}` is written into this SQL as text, so a value containing a quote rewrites the query (SQL injection). Pass it as a parameter: query('SELECT * FROM users WHERE id = $1', [id]), Prisma's tagged $queryRaw`...${id}`, Drizzle's sql`...${id}` (not sql.raw). A table or column name the caller picks must come from an allowlist, or go through sql.identifier().",
    },
  },
  createOnce(context) {
    /** @param {any} arg @param {(text: string) => boolean} looksRight @param {boolean} quotedOnly */
    function check(arg, looksRight, quotedOnly) {
      arg = unwrap(arg);
      if (arg?.type === "ObjectExpression") arg = arg.properties.find((/** @type {any} */ p) => /^(text|sql)$/.test(p.key?.name ?? ""))?.value;
      const options = unwrap(arg)?.type === "ConditionalExpression" ? [unwrap(arg).consequent, unwrap(arg).alternate] : [arg];
      for (const option of options) {
        const parts = option && pieces(option, context.sourceCode);
        if (!parts || !looksRight(staticText(parts))) continue;
        const value = firstDynamic(parts, context.sourceCode, quotedOnly);
        if (value) return context.report({ node: value, messageId: "sql", data: { value: context.sourceCode.getText(value).slice(0, 40) } });
      }
    }
    return {
      // Seeds, migrations, test setup and scripts build DDL from their own constants.
      before: () => !isScriptFile(context) && !notShipped(context),
      CallExpression(node) {
        const name = calleeName(node);
        const [first, params] = /** @type {any[]} */ (node.arguments);
        if (!first) return;
        const member = node.callee.type === "MemberExpression";
        // D1 and better-sqlite3 take the parameters on the next call: `prepare(sql).bind(...values)`.
        const next = /** @type {any} */ (node).parent;
        const bound = Boolean(params) || (next?.type === "MemberExpression" && /^(bind|all|get|run)$/.test(next.property.name) && next.parent?.arguments?.length > 0);
        if (member && RAW.test(name)) check(first, () => true, bound);
        else if (member && name === "literal" && /sequelize/i.test(receiverName(node))) check(first, () => true, false);
        else if (member && CONDITION.test(name)) check(first, (text) => COMPARISON.test(text), bound);
        else if ((member && RUNS.test(name)) || (!member && /query$/i.test(name))) check(first, (text) => SQL.test(text), bound);
      },
    };
  },
});

export const bad = [
  "await db.query(`SELECT * FROM users WHERE id = ${id}`);",
  "await knex.raw(`DELETE FROM orders WHERE user_id = ${req.params.id}`);",
  "await sql.unsafe(`UPDATE users SET name = '${name}' WHERE id = ${id}`);",
  "db.exec(`INSERT INTO log VALUES ('${message}')`);",
  "await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE email = '${email}'`);",
  "await db.query('SELECT * FROM users WHERE id = ' + id);",
  "const q = `SELECT * FROM users WHERE email = '${email}'`;\nawait pool.query(q);",
  "await pool.query({ text: `SELECT * FROM users WHERE id = ${id}` });",
  "await env.DB.prepare(`SELECT * FROM users WHERE id = ${id}`).first();",
  "await knex('users').whereRaw(`name = '${req.query.name}'`);",
  "await repo.createQueryBuilder('u').where(`u.email = '${email}'`).getOne();",
  "await db.query(String.raw`SELECT * FROM t WHERE id = ${id}`);",
  "await db.query(admin ? `SELECT * FROM users WHERE org = ${org}` : 'SELECT 1');",
  "export async function list(column: string) { return db.execute(sql.raw(`select ${column} from users`)); }",
  "const where = `email = '${email}'`;\nawait db.query(`SELECT * FROM users WHERE ${where}`);",
  "await client.query(`UPDATE users SET name = '${body.name}' WHERE id = $1`, [id]);",
];

export const good = [
  "await db.query(sql`SELECT * FROM users WHERE id = ${id}`);",
  "await db.query('SELECT * FROM users WHERE id = $1', [id]);",
  "await db.query(`SELECT * FROM ${USERS_TABLE} WHERE id = $1`, [id]);",
  "const match = pattern.exec(`${first} ${last}`);",
  "await db.query(`SELECT * FROM users`);",
  "const table = 'users';\nawait db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);",
  "const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');\nawait db.query(`SELECT * FROM users WHERE id IN (${placeholders})`, ids);",
  "await env.DB.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();",
  "await db.prepare(`SELECT * FROM events WHERE 1 = 1 ${words.map(() => 'AND text LIKE ?').join(' ')}`).all(...words);",
  "import { users } from './schema';\nawait db.insert(users).values(rows).onConflictDoUpdate({ target: users.id, set: { name: sql.raw(`excluded.${users.name.name}`) } });",
  "await db.query(`SELECT * FROM users WHERE ${conditions.join(' AND ')} LIMIT $1`, [...values, limit]);",
  "await env.DB.prepare(`SELECT * FROM cases WHERE ${where.join(' AND ')}`).bind(...params).all();",
  "class Repo { find(id: string) { return this.pool.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]); } }",
  "const res = await api.query(`?${new URLSearchParams(params)}`);",
  "const x = await graphql.query(`query { user(id: \"${id}\") { name } }`);",
];
