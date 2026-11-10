// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isTestFile } from "./paths.mjs";

const LIMIT = 4;

/** Synchronous iteration and React state updaters: nesting these is ordinary data shaping, not a pyramid. */
const ITERATION = /^(?:map|flatMap|filter|find|findIndex|findLast|findLastIndex|some|every|reduce|reduceRight|forEach|sort|toSorted|from|set[A-Z]\w*)$/;

/**
 * A level of the pyramid: a function with a block body passed straight to a call, such as `db.open((err, conn) => { ... })`
 * or `new Promise((resolve) => { ... })`.
 * @param {any} node
 */
function isLevel(node) {
  const call = node.parent;
  if ((call.type !== "CallExpression" && call.type !== "NewExpression") || !call.arguments.includes(node) || node.body.type !== "BlockStatement") return false;
  const name = call.callee.type === "MemberExpression" ? call.callee.property.name : call.callee.name;
  return !ITERATION.test(name ?? "");
}

export const id = "no-callback-pyramid";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      pyramid: `This callback is the ${LIMIT}th nested inside other callbacks, so its errors, order and variables depend on every level above it. Use async/await, or give the inner callbacks names and define them at the top level.`,
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      if (!isLevel(node)) return;
      let levels = 0;
      for (let n = node; n; n = n.parent) if (FUNCTIONS.has(n.type) && isLevel(n)) levels++;
      if (levels === LIMIT) context.report({ node, messageId: "pyramid" });
    }
    return {
      // Tests nest describe/it/beforeEach callbacks on purpose.
      before: () => !isTestFile(context),
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});

export const bad = [
  "export function load(id, done) {\n  db.open((err, conn) => {\n    conn.query(id, (err, rows) => {\n      cache.set(id, rows, () => {\n        log.write(id, () => { done(rows); });\n      });\n    });\n  });\n}",
  "export function boot() {\n  ready(function () {\n    fetchConfig(function (config) {\n      loadUser(config, function (user) {\n        render(user, function () { track('boot'); });\n      });\n    });\n  });\n}",
  "export const run = () => new Promise((resolve) => {\n  fs.readFile('a', (e, a) => {\n    fs.readFile('b', (e, b) => {\n      fs.writeFile('c', a + b, () => { resolve(); });\n    });\n  });\n});",
];

export const good = [
  "export async function load(id) {\n  const conn = await db.open();\n  const rows = await conn.query(id);\n  await cache.set(id, rows);\n  return rows;\n}",
  "export const total = (groups) => groups.map((g) => g.items.filter((i) => i.tags.some((t) => t.on)).length);",
  "export function run() {\n  app.get('/', (req, res) => {\n    res.on('finish', () => {\n      setTimeout(() => log(req), 0);\n    });\n  });\n}",
];
