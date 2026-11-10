// @ts-check
import { defineRule } from "@oxlint/plugins";

import { arbitrary, eachClass, eachStyleObject, keyName, literalValue, skipFile } from "./classes.mjs";
import { designSystem, examples } from "./project.mjs";

// Absolute sizes: em and % scale with their parent, so `text-[0.62em]` inside a scaled demo is relative, not off-scale.
const LENGTH = /^-?\d*\.?\d+(?:px|rem)?$/;
/** What an arbitrary type utility hardcodes, by prefix: `text-[13px]`, `leading-[18px]`, `tracking-[-0.5px]`, `font-[650]`. */
const CLASS_CHECKS = /** @type {Record<string, (v: string) => boolean>} */ ({
  text: (v) => LENGTH.test(v),
  // Unitless line heights are fine unless they repeat a named step: 1.25 is `leading-tight`.
  leading: (v) => /^\d*\.?\d+(?:px|rem)$/.test(v) || /^(?:1|1\.25|1\.375|1\.5|1\.625|2)$/.test(v),
  tracking: (v) => /^-?\d*\.?\d+(?:px|rem)$/.test(v),
  font: (v) => /^\d{3}$/.test(v),
});
/** What an inline style hardcodes, by property. */
const STYLE_CHECKS = /** @type {Record<string, (v: string) => boolean>} */ ({
  fontSize: (v) => LENGTH.test(v),
  lineHeight: (v) => /^\d*\.?\d+(?:px|rem)$/.test(v),
  letterSpacing: (v) => /^-?\d*\.?\d+(?:px|rem)$/.test(v),
  fontWeight: (v) => /^\d{3}$/.test(v),
  fontFamily: (v) => !/^(?:inherit|initial|unset)$|var\(/.test(v.trim()),
});

export const id = "no-hardcoded-typography";
export const pack = "ui";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ value }}` hardcodes a type value off the project's scale{{ tokens }}. Use a type step (`text-sm`, `leading-tight`, `font-semibold`, or the project's own `text-*`/`--font-*` tokens) so headings and body text stay consistent; if the design needs a new step, add it to the theme once.",
    },
  },
  createOnce(context) {
    let tokens = "";
    /** @param {any} node @param {string} value */
    const report = (node, value) => context.report({ node, messageId: "found", data: { value, tokens } });
    return {
      before() {
        const { tailwind, typeVars, stylesheets } = designSystem(context.cwd);
        if ((stylesheets && !tailwind && !typeVars.length) || skipFile(context, { primitives: true })) return false;
        tokens = examples(typeVars.filter((v) => v.startsWith("--")));
      },
      ...eachClass(/-\[/, (utility, word, node) => {
        const [prefix, value] = arbitrary(utility) ?? [];
        if (prefix && CLASS_CHECKS[prefix]?.(value)) report(node, word);
      }),
      ...eachStyleObject(context, (object) => {
        for (const p of object.properties) {
          const key = keyName(p);
          const value = key ? literalValue(p.value) : undefined;
          if (value !== undefined && STYLE_CHECKS[key ?? ""]?.(value)) report(p.value, `${key}: ${value}`);
        }
      }),
    };
  },
});

export const bad = [
  'export const Title = () => <h1 className="text-[13.5px] font-semibold">Plans</h1>;',
  'export const Stat = () => <p className="font-[650] leading-[1.25] tracking-[-0.5px]">42</p>;',
  "export const Note = () => <p className=\"mt-2\" style={{ fontSize: '14px', fontFamily: 'Inter, sans-serif' }}>Saved</p>;",
  'export const heading = cva("text-[2.25rem] font-bold", { variants: {} });',
  "export const Badge = () => <span className=\"px-2\" style={{ fontWeight: 600, lineHeight: '18px' }}>New</span>;",
];

export const good = [
  'export const Title = () => <h1 className="text-sm font-semibold leading-tight">Plans</h1>;',
  'export const Mark = () => <span className="text-[0.62em] text-[color:var(--ui-text-muted)] font-[family-name:var(--ui-font-heading)]">i</span>;',
  "export const Code = () => <code className=\"px-1\" style={{ fontFamily: 'var(--font-relative-mono)', fontSize: 'inherit' }}>x</code>;",
  "export const Scaled = ({ size }: { size: number }) => <p className=\"m-0\" style={{ fontSize: size, lineHeight: 1.4 }}>x</p>;",
  'export const Quote = () => <p className="text-lg leading-[1.15]">x</p>;',
  'export const Fill = () => <span className="text-[length:var(--ui-font-size-sm)] leading-[var(--ui-label-line)]">x</span>;',
  "export const OgTitle = () => <div style={{ display: 'flex', fontSize: 64, fontWeight: 700 }}>Lucra</div>;",
];
