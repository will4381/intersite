// @ts-check
import { defineRule } from "@oxlint/plugins";

import { literalValue, skipFile } from "./classes.mjs";
import { designSystem } from "./project.mjs";

const CONTROLS = new Set(["button", "input", "select", "textarea"]);
// Inputs a form kit rarely wraps, so a raw one is expected.
const NATIVE_INPUT = /^(?:checkbox|radio|file|hidden|range|color|image)$/;
// Five utilities is where a class list stops placing the control and starts re-creating its look.
const STYLED = 5;

/** The JSX attribute `name` on an opening element. @param {any} element @param {string} name */
const attribute = (element, name) => element.attributes.find((/** @type {any} */ a) => a.type === "JSXAttribute" && a.name.name === name);

/** The static class list of a `className`, or "" when it is computed. @param {any} attr */
function classList(attr) {
  const value = attr?.value;
  if (value?.type === "Literal") return String(value.value);
  return value?.type === "JSXExpressionContainer" ? literalValue(value.expression) ?? "" : "";
}

export const id = "no-hand-styled-control";
export const pack = "ui";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "This raw `<{{ element }}>` re-creates by hand what the project's `{{ component }}` ({{ where }}) already does, so it drifts from it on focus ring, disabled state, sizing and dark mode. Render `{{ component }}` with a variant (add one if none fits) and keep `className` for layout.",
    },
  },
  createOnce(context) {
    /** @type {Record<string, string>} */
    let available = {};
    return {
      before() {
        if (skipFile(context, { primitives: true })) return false;
        available = { ...designSystem(context.cwd).primitives };
        for (const s of context.sourceCode.ast.body) {
          if (s.type !== "ImportDeclaration") continue;
          for (const spec of s.specifiers) {
            const element = spec.local.name.toLowerCase();
            if (CONTROLS.has(element) && /^[A-Z]/.test(spec.local.name)) available[element] ??= `imported from ${s.source.value}`;
          }
        }
        if (!Object.keys(available).length) return false;
      },
      JSXOpeningElement(/** @type {any} */ node) {
        const element = node.name.type === "JSXIdentifier" ? node.name.name : "";
        const where = available[element];
        if (!where || classList(attribute(node, "className")).split(/\s+/).filter(Boolean).length < STYLED) return;
        if (element === "input" && NATIVE_INPUT.test(literalValue(attribute(node, "type")?.value) ?? "")) return;
        const component = element[0].toUpperCase() + element.slice(1);
        context.report({ node, messageId: "found", data: { element, component, where } });
      },
    };
  },
});

export const bad = [
  'import { Button } from "@/components/ui/button";\nexport const Bar = () => <><Button>Save</Button><button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">Cancel</button></>;',
  'import { Input } from "@/components/ui/input";\nexport const Search = () => <input className="h-9 w-full rounded-md border px-3 text-sm focus:ring-2" placeholder="Search" />;',
  'import { Button, Textarea } from "@acme/ui";\nexport const Note = () => <textarea className={"min-h-24 w-full rounded-md border p-3 text-sm"} />;',
];

export const good = [
  'import { Button } from "@/components/ui/button";\nexport const Bar = () => <Button variant="ghost" className="ml-auto">Save</Button>;',
  'import { Input } from "@/components/ui/input";\nexport const Pick = () => <input type="checkbox" className="size-4 rounded border accent-primary shrink-0" />;',
  'export const Plain = () => <button className="rounded-md bg-primary px-4 py-2 text-sm">Go</button>;',
  'import { Button } from "@/components/ui/button";\nexport const Nav = () => <button type="button" data-nav-item className="ic-trigger mt-auto">Out</button>;',
];
