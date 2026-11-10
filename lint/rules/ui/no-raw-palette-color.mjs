// @ts-check
import { defineRule } from "@oxlint/plugins";

import { eachClass, skipFile } from "./classes.mjs";
import { designSystem, examples } from "./project.mjs";

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const HINT = new RegExp(`-(?:${PALETTE})-\\d`);
const RAW = new RegExp(`^(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow)-(?:${PALETTE})-(?:50|[1-9]00|950)(?:/\\d+)?$`);

export const id = "no-raw-palette-color";
export const pack = "ui";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ value }}` is a raw Tailwind palette colour, but this project's theme names its colours{{ names }}. Use the semantic class (`bg-primary`, `text-muted-foreground`, `border-destructive`) so the colour follows the theme and dark mode; add a theme colour if none means this.",
    },
  },
  createOnce(context) {
    let names = "";
    return {
      before() {
        const { themeColors, stylesheets } = designSystem(context.cwd);
        if ((stylesheets && !themeColors.length) || skipFile(context)) return false;
        names = examples(themeColors);
      },
      ...eachClass(HINT, (utility, word, node) => {
        if (RAW.test(utility)) context.report({ node, messageId: "found", data: { value: word, names } });
      }),
    };
  },
});

export const bad = [
  'export const Alert = () => <p className="text-red-500 text-sm">Payment failed</p>;',
  'export const Cta = () => <button className="rounded-md bg-indigo-600 px-4 hover:bg-indigo-700">Start</button>;',
  'export const row = cn("border-b border-gray-200", "dark:border-zinc-800/60");',
  'export const Hero = () => <h1 className="bg-gradient-to-r from-purple-500 to-blue-500 bg-clip-text">Ship</h1>;',
];

export const good = [
  'export const Alert = () => <p className="text-destructive text-sm">Payment failed</p>;',
  'export const Cta = () => <button className="rounded-md bg-primary px-4 text-primary-foreground hover:bg-primary/90">Start</button>;',
  'export const Overlay = () => <div className="bg-black/50 text-white" />;',
  'export const copy = "The red-500 shade was retired";',
  'export const Pill = () => <span className="bg-muted text-muted-foreground border-border" />;',
];
