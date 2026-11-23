// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isTestFile, jsxAttribute, resolveVariable, unwrap, walk } from "../shared.mjs";

/**
 * The function an `onSubmit` value runs, when it is one written in this file: inline, a function declaration, a const
 * arrow or function, or a `useCallback` around one. Anything else (a form library's `handleSubmit(fn)`, a prop, a
 * member) is undefined: something else may prevent the reload.
 * @param {any} value @param {any} sourceCode
 */
function handler(value, sourceCode) {
  const e = unwrap(value);
  if (FUNCTIONS.has(e?.type)) return e;
  if (e?.type !== "Identifier") return undefined;
  const def = resolveVariable(e, sourceCode)?.defs[0];
  const decl = def?.node;
  if (decl?.type === "FunctionDeclaration") return decl;
  if (decl?.type !== "VariableDeclarator" || !decl.init) return undefined;
  const init = unwrap(decl.init);
  if (FUNCTIONS.has(init.type)) return init;
  if (init.type === "CallExpression" && /^(useCallback|React\.useCallback)$/.test(sourceCode.getText(init.callee)) && FUNCTIONS.has(init.arguments[0]?.type)) return init.arguments[0];
  return undefined;
}

/** Whether the handler prevents the browser's submit, or hands the event to code that may. @param {any} fn */
function prevents(fn) {
  const event = fn.params[0];
  if (!event) return false;
  if (event.type !== "Identifier") return true;
  let handled = false;
  walk(fn.body, (n) => {
    if (n.type === "MemberExpression" && n.property.type === "Identifier" && n.property.name === "preventDefault") handled = true;
    if ((n.type === "CallExpression" || n.type === "NewExpression") && n.arguments.some((/** @type {any} */ a) => a.type === "Identifier" && a.name === event.name)) handled = true;
  });
  return handled;
}

export const id = "no-reloading-form-submit";
export const pack = "react";
export const ext = "tsx";

/** Reported on the <form>, where the action or the handler is fixed. */
export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      reload: "This form has no action and its submit handler never calls event.preventDefault(), so submitting reloads the page and throws away what the handler started (its state updates, the request in flight). Call e.preventDefault() first, or give the form an action.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context),
      JSXOpeningElement(node) {
        const n = /** @type {any} */ (node);
        if (n.name.type !== "JSXIdentifier" || n.name.name !== "form" || jsxAttribute(n, "action") || n.attributes.some((/** @type {any} */ a) => a.type === "JSXSpreadAttribute")) return;
        const value = jsxAttribute(n, "onSubmit")?.value;
        if (value?.type !== "JSXExpressionContainer") return;
        const fn = handler(value.expression, context.sourceCode);
        if (fn && !prevents(fn)) context.report({ node, messageId: "reload" });
      },
    };
  },
});

export const bad = [
  "export function Signup({ save }) {\n  const onSubmit = async () => { await save(); };\n  return <form onSubmit={onSubmit}><button>Go</button></form>;\n}",
  "export function Search({ run }) {\n  function submit(e) { run(e.target.q.value); }\n  return <form onSubmit={submit}><input name='q' /></form>;\n}",
  "export const Note = ({ add }) => <form onSubmit={() => add()}><button>Add</button></form>;",
  "export function Login({ login }) {\n  const onSubmit = useCallback(async (event) => { await login(); }, [login]);\n  return <form onSubmit={onSubmit} />;\n}",
];

export const good = [
  "export function Signup({ save }) {\n  const onSubmit = async (e) => { e.preventDefault(); await save(); };\n  return <form onSubmit={onSubmit}><button>Go</button></form>;\n}",
  "export function Profile({ form, save }) {\n  return <form onSubmit={form.handleSubmit(save)} />;\n}",
  "export function Profile({ save }) {\n  const { handleSubmit } = useForm();\n  return <form onSubmit={handleSubmit(save)} />;\n}",
  "export const Post = ({ create }) => <form action={create}><button>Post</button></form>;",
  "export const Wrapped = ({ onSubmit }) => <form onSubmit={onSubmit} />;",
  "export function Search({ handle }) {\n  const onSubmit = (e) => handle(e);\n  return <form onSubmit={onSubmit} />;\n}",
];
