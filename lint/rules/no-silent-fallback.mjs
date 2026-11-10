// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, FUNCTIONS, isDiscarded, isGenerated, unwrap, walk } from "./shared.mjs";

/** `null`, a literal (`-1` included), `undefined`, `[]` or `{}`, under any cast. @param {any} node */
function isFakeValue(node) {
  node = unwrap(node);
  if (!node) return false;
  if (node.type === "Literal") return true;
  if (node.type === "UnaryExpression") return node.argument.type === "Literal";
  if (node.type === "Identifier") return node.name === "undefined";
  if (node.type === "ArrayExpression") return node.elements.length === 0;
  if (node.type === "ObjectExpression") return node.properties.length === 0;
  return false;
}

/**
 * `console.error(error)`, `logger.warn('load failed', err)`: logging the caught error before the fallback reports
 * nothing to callers either. A message of its own (`console.error('config is not valid JSON: restore it')`) is a CLI
 * telling its user, which is a report.
 * @param {any} s @param {string | undefined} error the caught error's name
 */
const logsError = (s, error) =>
  s.type === "ExpressionStatement" && s.expression.type === "CallExpression" && /^(?:console|logger|log)$/.test(s.expression.callee.object?.name ?? "") &&
  s.expression.arguments.some((/** @type {any} */ a) => a.type === "Identifier" && a.name === error);

/** `null`, `undefined`, `[]`, `{}`: empty data, as opposed to a status code such as `return 2`. @param {any} node */
function isEmptyData(node) {
  const n = unwrap(node);
  return n.type === "Literal" ? n.value === null : n.type !== "UnaryExpression" && isFakeValue(n);
}

/**
 * The `return <fake>` a block ends with: alone, or after lines that only log the caught error (then only empty data).
 * @param {any} block @param {any} [param] the caught error
 */
function fallbackReturn(block, param) {
  const last = block.body.at(-1);
  if (last?.type !== "ReturnStatement" || !isFakeValue(last.argument)) return undefined;
  const before = block.body.slice(0, -1);
  if (before.length && !(isEmptyData(last.argument) && before.every((/** @type {any} */ s) => logsError(s, param?.name)))) return undefined;
  return last;
}

const bodyRead = /^(?:json|text|formData|arrayBuffer|blob)$/;

const boolCall = /^(?:Boolean|is[A-Z]\w*|has[A-Z]\w*|can[A-Z]\w*|should[A-Z]\w*|exists?|includes|some|every|test|matches|startsWith|endsWith|compare|equals?)$/;

/** An expression that reads as yes or no: `true`, `!x`, `a === b`, `Boolean(x)`, `stat.isFile()`, `pattern.test(s)`. @param {any} node */
function isBooleanShaped(node) {
  node = unwrap(node);
  if (node?.type === "Literal") return node.value === true;
  if (node?.type === "UnaryExpression") return node.operator === "!";
  if (node?.type === "BinaryExpression") return /^(?:[!=]==?|[<>]=?|instanceof|in)$/.test(node.operator);
  if (node?.type !== "CallExpression") return false;
  return boolCall.test(node.callee.type === "MemberExpression" ? node.callee.property.name ?? "" : node.callee.name ?? "");
}

/** The return statements of a try block, not those of functions inside it. @param {any} block */
function returns(block) {
  /** @type {any[]} */
  const out = [];
  walk(block, (n) => (FUNCTIONS.has(n.type) ? false : void (n.type === "ReturnStatement" && out.push(n))));
  return out;
}

export const id = "no-silent-fallback";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      fallback: "This catch turns the failure into normal-looking data, so callers never learn it failed. Rethrow, return an explicit error result, or, when the fallback really is correct, say why in a comment inside the catch or after its closing brace.",
    },
  },
  createOnce(context) {
    /** A comment saying why the fallback is right: inside the handler, or after it on the same line. @param {any} body @param {any} end */
    function explained(body, end) {
      if (context.sourceCode.getCommentsInside(body).length) return true;
      return /\/[/*]/.test(context.sourceCode.lines[end.loc.end.line - 1].slice(end.loc.end.column));
    }

    return {
      // A generated client's fallbacks belong to its generator.
      before: () => !isGenerated(context),
      CatchClause(node) {
        const only = fallbackReturn(node.body, node.param);
        if (!only || explained(node.body, node.body)) return;
        // `try { new URL(s); return true; } catch { return false; }` is a predicate, not a fallback.
        if (unwrap(only.argument).value === false && returns(node.parent.block).some((r) => isBooleanShaped(r.argument))) return;
        context.report({ node: only, messageId: "fallback" });
      },
      // promise.catch(() => null), promise.catch((error) => { log(error); return []; })
      CallExpression(node) {
        const handler = node.callee.type === "MemberExpression" && node.callee.property.name === "catch" ? node.arguments[0] : undefined;
        if (handler?.type !== "ArrowFunctionExpression" && handler?.type !== "FunctionExpression") return;
        // Nothing reads a discarded `p.catch(() => undefined)` (no-empty-catch's case), and an unreadable body
        // (`await res.json().catch(() => null)`) has one meaning, which the schema or status check after it handles.
        if (isDiscarded(node) || bodyRead.test(calleeName(node.callee.object))) return;
        // `verify(sig).catch(() => false)`: a failed check answering no is a yes/no result, not disguised data.
        if (handler.body.type === "Literal" && handler.body.value === false) return;
        const fake = handler.body.type === "BlockStatement" ? fallbackReturn(handler.body, handler.params[0]) : isFakeValue(handler.body) && handler.body;
        if (fake && !explained(handler.body, node)) context.report({ node: fake, messageId: "fallback" });
      },
    };
  },
});

export const bad = [
  "async function loadUser(id) { try { return await db.get(id); } catch { return null; } }",
  "function prices() { try { return fetchPrices(); } catch (error) { return []; } }",
  "function config() { try { return JSON.parse(read()); } catch { return {}; } }",
  "function total() { try { return sum(rows()); } catch { return 0; } }",
  "function name() { try { return lookup(); } catch { return undefined; } }",
  "function name() {\n  try { return lookup(); } catch { return undefined; }\n  // a comment on the next line explains nothing about the catch\n}",
  "async function prices() { try { return await fetchPrices(); } catch (error) { console.error(error); return []; } }",
  "const user = await loadUser(id).catch(() => null);",
  "const rows = await load().catch((error) => { logger.warn(error); return []; });",
  "function index(id) { try { return find(id); } catch { return -1; } }",
  "function items() { try { return load(); } catch { return [] as Item[]; } }",
];

export const good = [
  "function isUrl(s) { try { new URL(s); return true; } catch { return false; } }",
  "function parse(text) { try { return JSON.parse(text); } catch { // user input; null means not JSON, callers check it\n return null; } }",
  "async function loadUser(id) { try { return await db.get(id); } catch (error) { throw new LoadError(id, { cause: error }); } }",
  "async function loadUser(id) { try { return { ok: true, user: await db.get(id) }; } catch (error) { return { ok: false, error }; } }",
  "function stop() { try { worker.stop(); } catch { return; } }",
  "function parse(text) { try { return JSON.parse(text); } catch { return null; } // not JSON: callers treat null as absent\n}",
  "function size(path) {\n  try { return statSync(path).size; } catch { return 0; } /* missing file counts as empty */\n}",
  "function fileExists(path) { try { return statSync(path).isFile(); } catch { return false; } }",
  "function webglSupported() { try { return Boolean(canvas.getContext('webgl2')); } catch { return false; } }",
  "const cached = await load().catch(() => null); // offline: the cached copy shows",
  "const user = await load().catch((error) => { throw new LoadError(error); });",
  "const body = await response.json().catch(() => null);",
  "await client.close().catch(() => undefined);",
  "const valid = await verify(signature).catch(() => false);",
  "function load() { try { return JSON.parse(read()); } catch { console.error('config.json is not valid JSON: restore it from git'); return undefined; } }",
  "function main() { try { return run(); } catch (error) { console.error(`run: ${error.message}`); return 2; } }",
  "// This file is auto-generated. Do not edit.\nexport function read(json) { try { return JSON.parse(json); } catch { return undefined; } }",
];
