// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

/** Handlers a person triggers: a control wired to one of these that does nothing is unfinished. */
const TRIGGERED = /^on(Click|DoubleClick|Submit|Press|Tap|Select|Change|Input)$/;

/** @param {any} n */
const isLog = (n) => n?.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.object.type === "Identifier" && n.callee.object.name === "console";

/** Whether a function's body does nothing: empty, `undefined`, `null`, `void 0`, or only console calls. @param {any} fn */
function noop(fn) {
  const body = fn.body;
  if (body.type !== "BlockStatement") {
    return (body.type === "Identifier" && body.name === "undefined") || (body.type === "Literal" && body.value === null && !body.regex) || (body.type === "UnaryExpression" && body.operator === "void" && body.argument.type === "Literal") || isLog(body);
  }
  return body.body.every((/** @type {any} */ s) => s.type === "ExpressionStatement" && isLog(s.expression));
}

export const id = "no-noop-handler";
export const pack = "ui";
export const ext = "tsx";

/** Reported on the attribute, so the line names the handler. */
export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      noop: "This {{handler}} does nothing, so the control looks finished and is not: wire it to what it should do, or remove the control until it does something. A console.log is not an implementation.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context),
      JSXAttribute(node) {
        const name = /** @type {any} */ (node.name);
        const value = /** @type {any} */ (node.value);
        if (name.type !== "JSXIdentifier" || !TRIGGERED.test(name.name) || value?.type !== "JSXExpressionContainer") return;
        const fn = value.expression;
        if ((fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression") && noop(fn)) context.report({ node, messageId: "noop", data: { handler: name.name } });
      },
    };
  },
});

export const bad = [
  "export const Save = () => <button onClick={() => {}}>Save</button>;",
  "export const Buy = () => <Button onClick={() => console.log('buy')}>Buy</Button>;",
  "export const Form = () => <form onSubmit={function () {}}><button>Go</button></form>;",
  "export const Pick = () => <Menu onSelect={() => undefined} />;",
  "export const Del = () => <button onClick={() => { console.log('delete', 1); }}>Delete</button>;",
];

export const good = [
  "export const Save = ({ save }) => <button onClick={() => save()}>Save</button>;",
  "export const Stop = () => <div onClick={(e) => e.stopPropagation()} />;",
  "export const Form = () => <form onSubmit={(e) => e.preventDefault()} />;",
  // Not a control a person triggers: a dialog that must not close on outside clicks.
  "export const Locked = ({ children }) => <Dialog open onOpenChange={() => {}}>{children}</Dialog>;",
  "export const Save = ({ save }) => <button onClick={() => { console.log('saving'); save(); }}>Save</button>;",
];
