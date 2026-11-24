// @ts-check
import { defineRule } from "@oxlint/plugins";

import { mentions } from "../shared.mjs";
import { eachClass, report, skipFile } from "./classes.mjs";
import { designSystem } from "./project.mjs";

const HINT = /\bdark:/;
const UTILITY = "bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|placeholder|caret|shadow";

export const id = "no-dark-color-override";
export const pack = "ui";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ value }}` sets a colour for dark mode by hand, but this project's theme colours already change in dark mode. Use the theme colour on its own (`{{ plain }}` without `dark:`) and give it its dark value in the theme, so every screen switches together.",
    },
  },
  createOnce(context) {
    /** @type {RegExp} */
    let color = /$^/;
    return {
      before() {
        const { themeColors, stylesheets, darkTheme } = designSystem(context.cwd);
        if ((stylesheets && (!darkTheme || themeColors.length < 3)) || skipFile(context, { primitives: true })) return false;
        const names = [...themeColors, "white", "black"].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        color = new RegExp(`^(?:${UTILITY})-(?:${names})(?:/\\d+)?$`);
        return mentions(context, HINT);
      },
      ...eachClass(HINT, (utility, word, node) => {
        if (word.split(":").slice(0, -1).includes("dark") && color.test(utility)) report(context, { node, messageId: "found", data: { value: word, plain: utility } });
      }),
    };
  },
});

export const ext = "tsx";

export const bad = [
  'export const Card = () => <div className="bg-white dark:bg-black rounded-lg">Plan</div>;',
  'export const Note = () => <p className="text-sm text-black dark:text-white">Saved</p>;',
  'export const panel = cn("border", "dark:border-white/10");',
];

export const good = [
  'export const Card = () => <div className="bg-card text-card-foreground rounded-lg">Plan</div>;',
  'export const Logo = () => <img className="dark:invert" src="/logo.svg" alt="Logo" />;',
  'export const Note = () => <p className="text-sm dark:font-medium">Saved</p>;',
  'export const Row = () => <tr className="hover:bg-white/5">x</tr>;',
];
