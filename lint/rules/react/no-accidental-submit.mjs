// @ts-check
import { defineRule } from "@oxlint/plugins";

import { FUNCTIONS, isTestFile, jsxAttribute, walk } from "../shared.mjs";

/** Whether an onClick value prevents the click's default (a submit), so the button only runs its handler. @param {any} value */
function preventsDefault(value) {
  const fn = value?.expression;
  if (!FUNCTIONS.has(fn?.type)) return false;
  let found = false;
  walk(fn.body, (n) => {
    if (n.type === "MemberExpression" && n.property.type === "Identifier" && n.property.name === "preventDefault") found = true;
  });
  return found;
}

export const id = "no-accidental-submit";
export const pack = "react";
export const ext = "tsx";

/** Reported on the button: the fix is its type attribute. */
export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      submit: "This <button> is inside a <form> and has no type, so it is a submit button: clicking it runs its onClick and also submits the form. Add type=\"button\" if it should only run its handler, or type=\"submit\" and drop the onClick if submitting is the point.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context),
      JSXOpeningElement(node) {
        const n = /** @type {any} */ (node);
        if (n.name.type !== "JSXIdentifier" || n.name.name !== "button" || jsxAttribute(n, "type") || n.attributes.some((/** @type {any} */ a) => a.type === "JSXSpreadAttribute")) return;
        const onClick = jsxAttribute(n, "onClick");
        if (!onClick || preventsDefault(onClick.value)) return;
        // The nearest enclosing element written in this component; a form further up is in another component's JSX.
        for (let p = n.parent?.parent; p && !FUNCTIONS.has(p.type); p = p.parent) {
          if (p.type === "JSXElement" && p.openingElement.name.type === "JSXIdentifier" && p.openingElement.name.name === "form") {
            context.report({ node, messageId: "submit" });
            return;
          }
        }
      },
    };
  },
});

export const bad = [
  "export const Edit = ({ save, reset }) => <form onSubmit={save}><input name='a' /><button onClick={reset}>Reset</button><button type='submit'>Save</button></form>;",
  "export function Items({ add, submit }) {\n  return <form onSubmit={submit}><div><button onClick={() => add()}>Add item</button></div></form>;\n}",
];

export const good = [
  "export const Edit = ({ save, reset }) => <form onSubmit={save}><button type='button' onClick={reset}>Reset</button><button type='submit'>Save</button></form>;",
  "export const Bar = ({ go }) => <div><button onClick={go}>Go</button></div>;",
  "export const Edit = ({ save }) => <form onSubmit={save}><button>Save</button></form>;",
  "export const Edit = ({ save, reset }) => <form onSubmit={save}><button onClick={(e) => { e.preventDefault(); reset(); }}>Reset</button></form>;",
  "export const Edit = ({ save, props }) => <form onSubmit={save}><button {...props} onClick={props.onClick}>x</button></form>;",
];
