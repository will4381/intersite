// @ts-check
import { defineRule } from "@oxlint/plugins";

import { arbitrary, eachClass, eachStyleObject, keyName, literalValue, skipFile } from "./classes.mjs";
import { designSystem } from "./project.mjs";

// Padding, margin, gap and radius in absolute units, and any numeric z-index. Widths, heights and offsets are layout
// and may take any value; em, %, calc() and var() are relative or tokenised.
const SPACING = /^(?:p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|rounded(?:-[trblse]{1,2})?)$/;
const ABSOLUTE = /^-?\d*\.?\d+(?:px|rem)$/;

export const id = "no-arbitrary-scale-value";
export const pack = "ui";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      spacing: "`{{ value }}` puts a one-off length on the spacing or radius scale. Use a scale step (`p-3`, `gap-4`, `rounded-lg`) or the project's spacing/radius token, so the rhythm stays even; if the design needs a new step, add it to the theme.",
      z: "`{{ value }}` is a magic z-index, so the next overlay has to guess a bigger number. Use the project's layer token (`z-[var(--z-modal)]`, a named `z-*` theme step) or Tailwind's `z-10`…`z-50`, and give each layer (sticky, dropdown, modal, toast) one name.",
    },
  },
  createOnce(context) {
    /** @param {any} node @param {string} value @param {"spacing" | "z"} messageId */
    const report = (node, value, messageId) => context.report({ node, messageId, data: { value } });
    return {
      before() {
        const { tailwind, stylesheets } = designSystem(context.cwd);
        if ((stylesheets && !tailwind) || skipFile(context, { primitives: true })) return false;
      },
      ...eachClass(/-\[/, (utility, word, node) => {
        const [prefix, value] = arbitrary(utility) ?? [];
        if (prefix === "z" && /^-?\d+$/.test(value)) report(node, word, "z");
        else if (prefix && SPACING.test(prefix) && ABSOLUTE.test(value)) report(node, word, "spacing");
      }),
      ...eachStyleObject(context, (object) => {
        for (const p of object.properties) {
          const value = keyName(p) === "zIndex" ? literalValue(p.value) : undefined;
          if (value && Math.abs(Number(value)) >= 100) report(p.value, `zIndex: ${value}`, "z");
        }
      }),
    };
  },
});

export const bad = [
  'export const Modal = () => <div className="fixed inset-0 z-[9999]" />;',
  'export const Card = () => <div className="rounded-[2rem] p-[13px]">x</div>;',
  'export const list = cn("flex gap-[18px]", "mt-[7px]");',
  "export const Bar = () => <div className=\"fixed\" style={{ zIndex: 9999 }} />;",
];

export const good = [
  'export const Modal = () => <div className="fixed inset-0 z-50 rounded-lg p-3" />;',
  'export const Hero = () => <div className="max-w-[1200px] h-[437px] w-[22%]" />;',
  'export const Tile = () => <div className="rounded-[inherit] p-[12%] gap-[var(--ui-menu-gap)] z-[var(--ui-z-toast)]" />;',
  'export const Chip = () => <span className="rounded-[calc(var(--radius-chip)-2px)] px-[0.5em]" />;',
  "export const Lift = () => <div className=\"relative\" style={{ zIndex: 1 }} />;",
];
