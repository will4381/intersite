// @ts-check
import { defineRule } from "@oxlint/plugins";

import { mentions } from "../shared.mjs";
import { eachClass, report, skipFile } from "./classes.mjs";
import { designSystem } from "./project.mjs";

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const HINT = new RegExp(`-(?:${PALETTE})-\\d`);
const RAW = new RegExp(`^(bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow)-(?:${PALETTE})-(?:50|[1-9]00|950)(?:/\\d+)?$`);

const TEXT_NAME = /foreground|text|fg|ink|muted/;

/**
 * Three theme colours written with the same utility (`text-red-500` -> `text-foreground`), text-like names first for
 * text utilities and the rest first for surfaces.
 * @param {string} prefix @param {string[]} colors
 */
function suggest(prefix, colors) {
  const names = colors.length ? colors : ["primary", "muted-foreground", "destructive"];
  const textual = /^(?:text|placeholder|decoration|caret)$/.test(prefix);
  const ranked = [...names.filter((n) => TEXT_NAME.test(n) === textual), ...names.filter((n) => TEXT_NAME.test(n) !== textual)];
  return ranked.slice(0, 3).map((c) => `\`${prefix}-${c}\``).join(", ");
}

export const id = "no-raw-palette-color";
export const pack = "ui";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ value }}` is a raw Tailwind palette colour, but this project's theme names its colours. Use the theme colour that means this ({{ names }}) so it follows the theme and dark mode; if none does, add one to the theme.",
    },
  },
  createOnce(context) {
    /** @type {string[]} */
    let colors = [];
    return {
      before() {
        const { themeColors, stylesheets } = designSystem(context.cwd);
        // Two names (create-next-app's background and foreground) are not a palette to move to.
        if ((stylesheets && themeColors.length < 3) || skipFile(context)) return false;
        colors = themeColors;
        return mentions(context, HINT);
      },
      ...eachClass(HINT, (utility, word, node) => {
        const prefix = RAW.exec(utility)?.[1];
        if (prefix) report(context, { node, messageId: "found", data: { value: word, names: suggest(prefix, colors) } });
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
