// @ts-check
import { defineRule } from "@oxlint/plugins";

import { eachStyleObject, keyName, literalValue, skipFile } from "./classes.mjs";
import { designSystem } from "./project.mjs";

export const id = "no-static-inline-style";
export const pack = "ui";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "This `style` holds only fixed values, so it bypasses the classes and tokens the rest of the file uses and cannot take hover, focus, breakpoints or dark mode. Move it into `className` (theme classes, or a class in the stylesheet); keep `style` for values computed at runtime or `--custom-property` handoffs.",
    },
  },
  createOnce(context) {
    return {
      before() {
        const { tailwind, colorVars, stylesheets } = designSystem(context.cwd);
        if ((stylesheets && !tailwind && !colorVars.length) || skipFile(context, { primitives: true })) return false;
      },
      ...eachStyleObject(context, (object, attribute) => {
        const props = object.properties;
        const fixed = props.every((/** @type {any} */ p) => {
          const key = keyName(p);
          return key && !key.startsWith("--") && literalValue(p.value) !== undefined;
        });
        // A lone dimension (`width: 320`) is often a measured or library-required size; two or more fixed values is
        // styling. Components (`<SocialIcon style>`) may offer no other way in, so only DOM elements count.
        const element = attribute?.parent?.name;
        if (props.length >= 2 && fixed && element?.type === "JSXIdentifier" && /^[a-z]/.test(element.name)) context.report({ node: object, messageId: "found" });
      }),
    };
  },
});

export const bad = [
  "export const Error = () => <p className=\"error\" style={{ fontSize: '14px', marginBottom: '12px' }}>Failed</p>;",
  "export const Row = () => <div className=\"row\" style={{ display: 'flex', alignItems: 'center', gap: 8 }} />;",
  "export const Hint = () => <span className=\"hint\" style={{ opacity: 0.6, fontStyle: 'italic' } as React.CSSProperties}>x</span>;",
];

export const good = [
  "export const Bar = ({ pct }: { pct: number }) => <div className=\"bar\" style={{ width: `${pct}%`, height: 4 }} />;",
  "export const Tint = ({ hue }: { hue: string }) => <div className=\"tint\" style={{ '--tint': hue, opacity: 0.5 } as React.CSSProperties} />;",
  "export const Box = () => <div className=\"box\" style={{ width: 320 }} />;",
  "export const Icon = () => <div className=\"row\"><SocialIcon style={{ height: 48, width: 48 }} /></div>;",
  "export const Og = () => <div style={{ display: 'flex', fontSize: 64 }}>Lucra</div>;",
  "export const Pos = ({ x, y }: { x: number; y: number }) => <div className=\"dot\" style={{ left: x, top: y }} />;",
];
