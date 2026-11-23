// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile, jsxAttribute } from "../shared.mjs";

/** Input types whose `value` is not what the user edits (checkboxes and radios are controlled by `checked`). */
const NOT_EDITED = /^(hidden|submit|button|reset|checkbox|radio|image)$/;

export const id = "no-read-only-input";
export const pack = "react";
export const ext = "tsx";

/** Reported on the field, once per element. */
export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      readOnly: "This <{{tag}}> has a value and no onChange, so React renders it read-only: typing does nothing, and React warns. Add onChange to update the value, use defaultValue for a field the browser owns, or mark it readOnly if it is meant to be.",
    },
  },
  createOnce(context) {
    return {
      before: () => !isTestFile(context),
      JSXOpeningElement(node) {
        const n = /** @type {any} */ (node);
        if (n.name.type !== "JSXIdentifier" || !/^(input|textarea|select)$/.test(n.name.name)) return;
        if (!jsxAttribute(n, "value") || n.attributes.some((/** @type {any} */ a) => a.type === "JSXSpreadAttribute" || /^(onChange|onInput|readOnly|disabled)$/.test(a.name?.name ?? ""))) return;
        const type = jsxAttribute(n, "type")?.value;
        if (type && (type.type !== "Literal" || NOT_EDITED.test(String(type.value)))) return;
        context.report({ node, messageId: "readOnly", data: { tag: n.name.name } });
      },
    };
  },
});

export const bad = [
  "export const Name = ({ name }) => <input value={name} />;",
  "export const Bio = ({ bio }) => <textarea value={bio} className='w-full' />;",
  "export const Size = ({ size }) => <select value={size}><option>S</option></select>;",
  "export const Email = ({ email }) => <input type='email' value={email} onBlur={() => {}} />;",
];

export const good = [
  "export const Name = ({ name, setName }) => <input value={name} onChange={(e) => setName(e.target.value)} />;",
  "export const Name = ({ name }) => <input defaultValue={name} />;",
  "export const Code = ({ code }) => <input value={code} readOnly />;",
  "export const Field = ({ field }) => <input {...field} value={field.value} />;",
  "export const Id = ({ id }) => <input type='hidden' value={id} />;",
  "export const Opt = ({ v, on }) => <input type='checkbox' value={v} checked={on} onChange={() => {}} />;",
  "export const Off = ({ v }) => <input value={v} disabled />;",
];
