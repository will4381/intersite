// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isDiscarded, isGenerated, isTestFile } from "./shared.mjs";

/** Words that say nothing about why dropping the error is safe: `ignore`, `noop`, `best effort`, `intentionally empty`. */
const filler = new Set("ignore ignored ignoring error errors err e it its this here silently silent intentionally deliberately purposely on purpose empty noop no op nothing do swallow swallowed fine ok okay best effort catch the we just safe to expected".split(" "));

/** A comment that gives a reason: two or more words beyond filler such as "ignore" and "noop". @param {string} text */
const isReason = (text) => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !filler.has(w)).length >= 2;

/** `undefined`, `null` or `void 0`: a handler that returns nothing on purpose. @param {any} node */
const isNothing = (node) => (node.type === "Identifier" && node.name === "undefined") || (node.type === "Literal" && node.value === null) || (node.type === "UnaryExpression" && node.operator === "void");

/** An empty `{}` body: a catch block, or the block body of a `.catch(() => {})` handler. @param {any} node */
const isEmptyBlock = (node) => node?.type === "BlockStatement" && node.body.length === 0;

export const id = "no-empty-catch";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      // ponytail: test/lint/cli.test.mjs pins this text; say there that a comment giving the reason (not `ignore`) also clears it.
      empty: "An empty catch hides the error. Handle it (return an explicit fallback and say why), rethrow it, or remove the try.",
    },
  },
  createOnce(context) {
    /** A reason in a comment inside the block, or after it (or after `end`) on the same line. @param {any} block @param {any} end */
    function explained(block, end) {
      if (context.sourceCode.getCommentsInside(block).some((c) => isReason(c.value))) return true;
      const rest = context.sourceCode.lines[end.loc.end.line - 1].slice(end.loc.end.column);
      const comment = rest.indexOf("//") >= 0 ? rest.indexOf("//") : rest.indexOf("/*");
      return comment >= 0 && isReason(rest.slice(comment));
    }

    /** @param {any} node @param {any} end the node a trailing comment follows */
    function report(node, end) {
      if (!explained(node, end)) context.report({ node, messageId: "empty" });
    }

    /** @param {any} block */
    const check = (block) => isEmptyBlock(block) && report(block, block);

    return {
      // A generated client's empty catches belong to its generator. In a test, a swallowed rejection sets up the state
      // the next assertion checks (`await mutate().catch(() => {}); expect(result.error)...`), and a catch around
      // assertions is no-swallowed-test-failure's to report.
      before: () => !isGenerated(context) && !isTestFile(context),
      CatchClause: (node) => check(node.body),
      // promise.catch(() => {}) and promise.then(onDone, () => {})
      CallExpression(node) {
        const method = node.callee.type === "MemberExpression" ? node.callee.property.name : undefined;
        const handler = method === "catch" ? node.arguments[0] : method === "then" ? node.arguments[1] : undefined;
        if (handler?.type !== "ArrowFunctionExpression" && handler?.type !== "FunctionExpression") return;
        // `p.catch(() => undefined);` with the result thrown away swallows the error just as `() => {}` does.
        if (handler.body.type !== "BlockStatement" && isNothing(handler.body) && isDiscarded(node)) return report(handler.body, node);
        check(handler.body);
      },
    };
  },
});

export const bad = [
  "try { save(); } catch {}",
  "try { save(); } catch (error) { /* ignore */ }",
  "save().catch(() => {});",
  "save().catch(function () {});",
  "save().then(done, () => {});",
  "try { save(); } catch { /* best effort */ }",
  "try { save(); } catch {} // ignore",
  "await client.close().catch(() => undefined);",
  "void audio.play().catch(() => null);",
];

export const good = [
  "try { return JSON.parse(text); } catch { return null; // not JSON: callers treat null as absent\n}",
  "save().catch((error) => { throw new SaveError(error); });",
  "try { localStorage.setItem('poll', poll); } catch { /* Storage blocked: the default interval stays. */ }",
  "try { await claim(job); } catch {\n  // Another worker claimed it at the same moment; the next run picks up the rest.\n}",
  "try { unlinkSync(tmp); } catch {} // already gone, nothing to clean",
  "save().then(done);",
  "await client.close().catch(() => undefined); // the server may already have closed it",
  "const user = await load().catch(() => undefined);",
];
