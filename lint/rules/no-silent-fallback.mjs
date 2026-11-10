// @ts-check
import { defineRule } from "@oxlint/plugins";

/**
 * `null`, a literal, `undefined`, `[]` or `{}`.
 * @param {any} node
 */
function isFakeValue(node) {
  if (!node) return false;
  if (node.type === "Literal") return true;
  if (node.type === "Identifier") return node.name === "undefined";
  if (node.type === "ArrayExpression") return node.elements.length === 0;
  if (node.type === "ObjectExpression") return node.properties.length === 0;
  return false;
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
    return {
      CatchClause(node) {
        const [only, ...rest] = node.body.body;
        if (rest.length || only?.type !== "ReturnStatement" || !isFakeValue(only.argument)) return;
        // A comment saying why the fallback is right is the honest way out, as no-empty-catch asks.
        // Inside the block, or on the same line after its closing brace: `catch { return null; } // not JSON`.
        if (context.sourceCode.getCommentsInside(node.body).length) return;
        if (context.sourceCode.getCommentsAfter(node.body).some((c) => c.loc.start.line === node.body.loc.end.line)) return;
        // `try { new URL(s); return true; } catch { return false; }` is a predicate, not a fallback.
        const tried = node.parent.block.body;
        if (only.argument.value === false && tried.some((/** @type {any} */ s) => s.type === "ReturnStatement" && s.argument?.value === true)) return;
        context.report({ node: only, messageId: "fallback" });
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
];

export const good = [
  "function isUrl(s) { try { new URL(s); return true; } catch { return false; } }",
  "function parse(text) { try { return JSON.parse(text); } catch { // user input; null means not JSON, callers check it\n return null; } }",
  "async function loadUser(id) { try { return await db.get(id); } catch (error) { throw new LoadError(id, { cause: error }); } }",
  "async function loadUser(id) { try { return { ok: true, user: await db.get(id) }; } catch (error) { return { ok: false, error }; } }",
  "function stop() { try { worker.stop(); } catch { return; } }",
  "function parse(text) { try { return JSON.parse(text); } catch { return null; } // not JSON: callers treat null as absent\n}",
  "function size(path) {\n  try { return statSync(path).size; } catch { return 0; } /* missing file counts as empty */\n}",
];
