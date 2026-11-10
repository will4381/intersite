// @ts-check
import { defineRule } from "@oxlint/plugins";

/** The JSX attribute `name` on an opening element. @param {any} element @param {string} name */
const attribute = (element, name) => element.attributes.find((/** @type {any} */ a) => a.type === "JSXAttribute" && a.name.name === name);

/** `(e) => e.stopPropagation()`: a handler that only keeps the event from reaching a parent is not an action. @param {any} attr */
function onlyStopsEvent(attr) {
  const fn = attr?.value?.expression;
  if (!fn?.type?.endsWith("FunctionExpression")) return false;
  const body = fn.body.type === "BlockStatement" ? fn.body.body.map((/** @type {any} */ s) => s.expression) : [fn.body];
  return body.length > 0 && body.every((/** @type {any} */ e) => /^(?:stopPropagation|preventDefault)$/.test(e?.callee?.property?.name ?? ""));
}

export const id = "require-action-name";
export const pack = "actions";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: 'This control has no action name. Add a stable one such as data-intersite="program.save": tests and replay find the element by it, so they survive markup and text changes.',
    },
  },
  createOnce(context) {
    return {
      JSXOpeningElement(/** @type {any} */ node) {
        const tag = node.name.type === "JSXIdentifier" ? node.name.name : "";
        // `onSubmit` on a component (`<BrandTagForm onSubmit>`) is a callback prop: its own <form> takes the name.
        const handler = attribute(node, "onClick");
        if (!/^(?:button|form|Form)$/.test(tag) && (!handler || onlyStopsEvent(handler))) return;
        // A spread may pass the name through; a submit button is named by its form.
        if (attribute(node, "data-intersite") || node.attributes.some((/** @type {any} */ a) => a.type === "JSXSpreadAttribute")) return;
        if (attribute(node, "type")?.value?.value === "submit") return;
        context.report({ node, messageId: "found" });
      },
    };
  },
});

export const bad = [
  "export const Save = () => <button onClick={save}>Save</button>;",
  "export const Edit = () => <form onSubmit={submit}><input name=\"title\" /></form>;",
  "export const Row = () => <div onClick={open}>Open</div>;",
  "export const Close = () => <Button onClick={close}>Close</Button>;",
  "export const Edit = () => <Form method=\"post\" onSubmit={submit}><input name=\"title\" /></Form>;",
  "export const Menu = () => <Dropdown.Item onClick={() => archive(id)}>Archive</Dropdown.Item>;",
];

export const good = [
  "export const Save = () => <button data-intersite=\"program.save\" onClick={save}>Save</button>;",
  "export const Edit = () => <form data-intersite=\"program.edit\" onSubmit={submit}><button type=\"submit\">Save</button></form>;",
  "export const Action = (props) => <button {...props}>Go</button>;",
  "export const Link = () => <a href=\"/programs\">Programs</a>;",
  "export const Panel = ({ children }) => <div className=\"panel\" onClick={(e) => e.stopPropagation()}>{children}</div>;",
  "export const Tags = () => <BrandTagForm onSubmit={create} />;",
  "export const Open = ({ id }) => <button data-intersite={`row.${id}.open`} onClick={open}>Open</button>;",
];
