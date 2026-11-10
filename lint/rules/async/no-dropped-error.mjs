// @ts-check
import { defineRule } from "@oxlint/plugins";

/**
 * True when this use of the caught error keeps it: inside the new error, in a value derived from it
 * (`const output = String(error)`), handed to a call made for its effect (`log(error)`, `await report(error)`), or
 * rethrown or returned elsewhere in the catch, which makes the new error a translation of one known case. Only testing it (`if (error.code === 'ENOENT')`) does not keep it.
 * @param {any} identifier @param {any} thrown
 */
function passesOn(identifier, thrown) {
  for (let node = identifier.parent; node; node = node.parent) {
    if (node === thrown || node.type === "VariableDeclarator" || node.type === "ThrowStatement" || node.type === "ReturnStatement") return true;
    if (node.type === "CallExpression" && (node.parent.type === "AwaitExpression" ? node.parent.parent : node.parent).type === "ExpressionStatement") return true;
    if (node.type.endsWith("Statement") || node.type === "CatchClause") return false;
  }
  return false;
}

/**
 * A try block that only runs `JSON.parse(...)` or `new URL(...)`.
 * @param {any} block
 */
function isParseOnly(block) {
  if (block.body.length !== 1) return false;
  const [only] = block.body;
  let value = only.expression ?? only.argument ?? only.declarations?.[0]?.init;
  while (value?.type === "TSAsExpression" || value?.type === "AwaitExpression") value = value.expression ?? value.argument;
  if (value?.type === "NewExpression") return value.callee.name === "URL";
  return value?.type === "CallExpression" && value.callee.object?.name === "JSON" && value.callee.property?.name === "parse";
}

export const id = "no-dropped-error";
export const pack = "async";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      dropped: "This throws a new error and discards the one that was caught, so the real reason (its message and stack) is lost. Pass it on: new Error('...', { cause: error }).",
    },
  },
  createOnce(context) {
    return {
      ThrowStatement(node) {
        const thrown = node.argument;
        if (thrown.type !== "NewExpression" || thrown.callee.type !== "Identifier" || !thrown.callee.name.endsWith("Error")) return;
        // The nearest catch, unless a function boundary comes first.
        let clause = node.parent;
        while (clause && clause.type !== "CatchClause" && !clause.type.endsWith("FunctionExpression") && clause.type !== "FunctionDeclaration") clause = clause.parent;
        if (clause?.type !== "CatchClause") return;
        // `catch {}` with no binding: the author chose not to look at the error, often for a parse or lookup whose
        // failure has one meaning. Only a named error that then goes unused is a dropped cause.
        if (clause.param?.type !== "Identifier") return;
        // `try { new URL(s) } catch (e) { throw new Error('bad URL') }`: a parse failure has one meaning.
        if (isParseOnly(clause.parent.block)) return;
        const name = clause.param.name;
        const variable = context.sourceCode.getDeclaredVariables(clause).find((v) => v.name === name);
        if (!variable || variable.references.some((/** @type {any} */ ref) => passesOn(ref.identifier, thrown))) return;
        context.report({ node: thrown, messageId: "dropped" });
      },
    };
  },
});

export const bad = [
  "async function load(id) { try { return await db.get(id); } catch (error) { throw new Error('Failed to load user'); } }",
  "function config(file) { try { return load(file); } catch (e) { throw new ConfigError(`bad config in ${file}`); } }",
  "async function charge() { try { await stripe.charge(); } catch (err) { log('charge failed'); throw new PaymentError('Payment failed'); } }",
  "async function read(path) { try { return await open(path); } catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('Cannot open credentials file.'); } }",
];

export const good = [
  "async function load(id) { try { return await db.get(id); } catch (error) { throw new Error('Failed to load user', { cause: error }); } }",
  "function parse(text) { try { return JSON.parse(text); } catch (e) { throw new ConfigError(`bad config: ${e.message}`); } }",
  "async function charge() { try { await stripe.charge(); } catch (err) { if (err.code === 'card_declined') throw new DeclinedError(); throw err; } }",
  "function isUrl(s) { try { return new URL(s); } catch { throw new Error(`not a URL: ${s}`); } }",
  "function check(url) { try { new URL(url); } catch (e) { throw new Error('Invalid URL format in job config'); } }",
  "function parse(text) { try { return JSON.parse(text) as Config; } catch (error) { throw new Error('Invalid JSON from KV'); } }",
  "function run() { try { step(); } catch (error) { report(error); throw new Error('step failed'); } }",
  "function run() { try { exec(cmd); } catch (error) { const output = String(error.stderr ?? error); throw new Error(`${cmd} failed: ${output}`); } }",
  "function run() { try { step(); } catch (error) { queue.push(() => { throw new Error('later'); }); } }",
];
