// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isGenerated, isTestFile } from "../shared.mjs";

const LIMIT = 4;

/** A fixed value: a literal, a template with no `${}`, `undefined`, or an enum-style member such as `Status.Active`. @param {any} n */
const isValue = (n) =>
  n.type === "Literal" ||
  (n.type === "TemplateLiteral" && n.expressions.length === 0) ||
  (n.type === "Identifier" && n.name === "undefined") ||
  (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && /^[A-Z]/.test(n.object.name));

/**
 * What an `x === value` test compares, as source text, or undefined for any other test.
 * @param {any} test @param {(node: any) => string} text
 */
function subject(test, text) {
  if (test?.type !== "BinaryExpression" || (test.operator !== "===" && test.operator !== "==")) return undefined;
  const other = isValue(test.right) ? test.left : isValue(test.left) ? test.right : undefined;
  return other && !isValue(other) ? text(other) : undefined;
}

/**
 * A plain value, the kind a lookup table holds: a literal, a name or member, a template or array or object of those,
 * or a JSX element with no children and only string props. A call or a computed expression is work, and a branch
 * doing work is dispatch.
 * @param {any} n @returns {boolean}
 */
function plain(n) {
  if (!n) return false;
  if (n.type === "Literal" || n.type === "Identifier") return true;
  if (n.type === "TemplateLiteral") return n.expressions.every(plain);
  if (n.type === "MemberExpression") return !n.computed && plain(n.object);
  if (n.type === "UnaryExpression") return n.operator === "-" && n.argument.type === "Literal";
  if (n.type === "JSXElement") return n.openingElement.selfClosing && n.openingElement.attributes.every((/** @type {any} */ a) => a.type === "JSXAttribute" && (a.value === null || a.value.type === "Literal"));
  if (n.type === "ArrayExpression") return n.elements.every(plain);
  if (n.type === "ObjectExpression") return n.properties.every((/** @type {any} */ p) => p.type === "Property" && plain(p.value));
  return false;
}

/**
 * Whether a branch only picks a value: one `return value` or one assignment of a value. A ladder of those is a table
 * written as code; branches that do different work read fine as a chain, or as a switch.
 * @param {any} node
 */
function picks(node) {
  const only = node?.type === "BlockStatement" && node.body.length === 1 ? node.body[0] : node;
  if (only?.type === "ReturnStatement") return plain(only.argument);
  return only?.type === "ExpressionStatement" && only.expression.type === "AssignmentExpression" && plain(only.expression.right);
}

/** The subject of an `if` that tests `x === value` and only picks a value, or undefined. @param {any} node @param {(node: any) => string} text */
const rung = (node, text) => (node?.type === "IfStatement" && picks(node.consequent) ? subject(node.test, text) : undefined);

export const id = "no-equality-ladder";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      ladder: `These {{count}} branches each compare \`{{subject}}\` to a value and pick a result, a table written as code: a reader scans every test to find the row. Put the values and results in one lookup object or Map and read it once.`,
    },
  },
  createOnce(context) {
    const text = (/** @type {any} */ node) => context.sourceCode.getText(node);
    /** @param {any} node @param {number} count @param {string} on */
    const report = (node, count, on) => context.report({ node, messageId: "ladder", data: { count: String(count), subject: on.length > 40 ? `${on.slice(0, 37)}...` : on } });

    /** `if (x === a) … else if (x === b) …`: counted from the first `if` of the chain. @param {any} node */
    function chain(node) {
      if (node.parent?.type === "IfStatement" && node.parent.alternate === node) return;
      const on = rung(node, text);
      if (!on) return;
      let count = 0;
      for (let n = node; rung(n, text) === on; n = n.alternate) count++;
      if (count >= LIMIT) report(node, count, on);
    }

    /** `if (x === a) return …; if (x === b) return …;`: a run of sibling `if`s without `else`. @param {any[]} body */
    function siblings(body) {
      for (let i = 0; i < body.length; ) {
        const on = body[i].alternate ? undefined : rung(body[i], text);
        let j = i + 1;
        while (on && !body[j]?.alternate && rung(body[j], text) === on) j++;
        if (on && j - i >= LIMIT) report(body[i], j - i, on);
        i = j;
      }
    }

    return {
      // A fake server in a test matches routes in a row on purpose; generated code is the generator's to shape.
      before: () => !isTestFile(context) && !isGenerated(context),
      IfStatement: chain,
      BlockStatement: (/** @type {any} */ node) => siblings(node.body),
      SwitchCase: (/** @type {any} */ node) => siblings(node.consequent),
      Program: (/** @type {any} */ node) => siblings(node.body),
    };
  },
});

export const bad = [
  "export function label(status) {\n  if (status === 'draft') return 'Draft';\n  else if (status === 'review') return 'In review';\n  else if (status === 'live') return 'Live';\n  else if (status === 'archived') return 'Archived';\n  return 'Unknown';\n}",
  "export function icon(kind) {\n  if (kind === 'pdf') return PdfIcon;\n  if (kind === 'image') return ImageIcon;\n  if (kind === 'video') return VideoIcon;\n  if (kind === 'audio') return AudioIcon;\n  return FileIcon;\n}",
  "export function rank(role) {\n  let level = 0;\n  if (Role.Admin === role) { level = 3; }\n  else if (Role.Owner === role) { level = 4; }\n  else if (Role.Member === role) { level = 2; }\n  else if (Role.Guest === role) { level = 1; }\n  return level;\n}",
];

export const good = [
  "export function label(status) {\n  if (status === 'draft') return 'Draft';\n  if (status === 'review') return 'In review';\n  if (status === 'live') return 'Live';\n  return 'Unknown';\n}",
  "export function route(req) {\n  if (req.method === 'GET') return read(req);\n  if (req.path === '/health') return ok();\n  if (req.user === undefined) return deny();\n  if (req.method === 'POST') return write(req);\n}",
  "export function grade(score) {\n  if (score >= 90) return 'A';\n  else if (score >= 80) return 'B';\n  else if (score >= 70) return 'C';\n  else if (score >= 60) return 'D';\n  return 'F';\n}",
  "export function run(role) {\n  if (Role.Admin === role) { grant(); }\n  else if (Role.Owner === role) { grant(); audit(); }\n  else if (Role.Member === role) { limit(); }\n  else if (Role.Guest === role) { deny(); }\n}",
  "export function check(e) {\n  if (e.type === 'Literal') return e.value === true;\n  if (e.type === 'Identifier') return e.name === name;\n  if (e.type === 'CallExpression') return isBoolean(e.callee);\n  if (e.type === 'UnaryExpression') return e.operator === '!' && check(e.argument);\n  return false;\n}",
  "export function pick(a, b) {\n  if (a === b) return 0;\n  if (a === b + 1) return 1;\n  if (a === b + 2) return 2;\n  if (a === b + 3) return 3;\n}",
];
