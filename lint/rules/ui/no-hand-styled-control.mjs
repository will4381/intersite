// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";
import { literalValue, skipFile, utilityOf } from "./classes.mjs";
import { designSystem } from "./project.mjs";

const CONTROLS = new Set(["button", "input", "select", "textarea"]);
// Inputs a form kit rarely wraps, so a raw one is expected.
const NATIVE_INPUT = /^(?:checkbox|radio|file|hidden|range|color|image)$/;
// What a control's look is made of. Three of these is re-creating the control; layout (`fixed inset-0 z-30`) or one
// state ring is placing it.
const LOOK = /** @type {[string, RegExp][]} */ ([
  ["padding", /^p[xytrblse]?-/],
  ["radius", /^rounded/],
  ["surface", /^bg-/],
  ["border", /^(?:border|ring|outline|shadow)(?:-|$)/],
  ["type", /^(?:text-(?:xs|sm|base|lg|\d?xl)$|font-|leading-|tracking-)/],
]);
const STATE = /(?:^|:)(?:hover|focus|focus-visible|active|disabled):/;

/** The JSX attribute `name` on an opening element. @param {any} element @param {string} name */
const attribute = (element, name) => element.attributes.find((/** @type {any} */ a) => a.type === "JSXAttribute" && a.name.name === name);

/** How many parts of a control's look (padding, radius, surface, border, type, states) the class words set. @param {Set<string>} words */
function lookParts(words) {
  const parts = new Set();
  for (const word of words) {
    if (STATE.test(word)) parts.add("state");
    const utility = utilityOf(word);
    for (const [part, test] of LOOK) if (test.test(utility)) parts.add(part);
  }
  return parts.size;
}

/** The class words a `className` spells out: its string, or every string in `cn(…)`, a ternary or a template. @param {any} attr */
function classWords(attr) {
  const words = new Set();
  walk(attr?.value, (n) => {
    const text = n.type === "Literal" ? n.value : n.type === "TemplateElement" ? n.value.cooked : undefined;
    if (typeof text === "string") for (const w of text.split(/\s+/)) if (w) words.add(w);
  });
  return words;
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
        if (!where || lookParts(classWords(attribute(node, "className"))) < 3) return;
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
  'import { Button } from "@/components/ui/button";\nexport const Bar = ({ on }) => <button className={cn("inline-flex items-center rounded-md px-4 py-2", on && "bg-primary")}>Go</button>;',
  'import { Input } from "@/components/ui/input";\nexport const Search = ({ wide }) => <input className={`h-9 rounded-md border px-3 ${wide ? "w-full" : "w-48"}`} />;',
];

export const good = [
  'import { Button } from "@/components/ui/button";\nexport const Bar = () => <Button variant="ghost" className="ml-auto">Save</Button>;',
  'import { Input } from "@/components/ui/input";\nexport const Pick = () => <input type="checkbox" className="size-4 rounded border accent-primary shrink-0" />;',
  'export const Plain = () => <button className="rounded-md bg-primary px-4 py-2 text-sm">Go</button>;',
  'import { Button } from "@/components/ui/button";\nexport const Nav = () => <button type="button" data-nav-item className="ic-trigger mt-auto">Out</button>;',
  'import { Button } from "@/components/ui/button";\nexport const Backdrop = ({ open }) => <button type="button" aria-label="Close" className={cn("fixed inset-0 z-30 bg-scrim backdrop-blur-xs md:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")} />;',
  'import { Button } from "@/components/ui/button";\nexport const Cta = ({ broken }) => <button type="button" className={cn(classes.cta, broken && "ring-2 ring-destructive ring-offset-2 ring-offset-background")}>Go</button>;',
  'import { Button } from "@/components/ui/button";\nexport const Nav = ({ active }) => <button className={cn("mt-auto", active && "font-medium", className)}>Out</button>;',
];
