// @ts-check
import { defineRule } from "@oxlint/plugins";

import { COLOR_FN, HEX, arbitrary, eachClass, eachStyleObject, keyName, literalValue, skipFile, withoutVars } from "./classes.mjs";
import { designSystem, examples } from "./project.mjs";

const COLOR_KEY = /^(?:color|background|backgroundColor|border(?:Top|Right|Bottom|Left|Block|Inline)?Color|fill|stroke|outlineColor|caretColor|accentColor|textDecorationColor)$/;
const NAMED = /^(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|crimson|tomato|coral|salmon|indigo|violet|brown|beige|ivory|khaki|lavender)$/i;

/**
 * The colour literal inside a value, after token references are removed: `hsl(var(--primary))` and
 * `rgb(var(--x) / 0.5)` wrap a token, so a colour function left with no channels of its own is not a literal.
 * @param {string} value
 */
const colorIn = (value) => {
  // url(/sprite.svg#add) holds a fragment, not a colour.
  const bare = withoutVars(value).replace(/url\([^)]*\)/gi, "").replace(/[a-z]+\([\s_]*(?:\/[\s_]*[\d.]+%?)?[\s_]*\)/gi, "");
  return HEX.exec(bare)?.[0] ?? COLOR_FN.exec(bare)?.[0].replace("(", "()");
};

export const id = "no-hardcoded-color";
export const pack = "ui";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      found: "`{{ value }}` is a hardcoded colour, and this project has colour tokens{{ tokens }}. Use the token's theme class or `var(--token)` so theme and dark-mode changes reach it; if no token fits, add one to the theme instead of inlining the value.",
    },
  },
  createOnce(context) {
    let tokens = "";
    /** @param {any} node @param {string} value */
    const report = (node, value) => context.report({ node, messageId: "found", data: { value, tokens } });
    return {
      before() {
        const { colorVars, stylesheets } = designSystem(context.cwd);
        if ((stylesheets && colorVars.length < 3) || skipFile(context)) return false;
        tokens = examples(colorVars);
      },
      ...eachClass(/\[/, (utility, word, node) => {
        // `[--brand:#0af]` defines a custom property, as a `--brand` key in a style object does.
        const [, value] = arbitrary(utility) ?? (/^\[(?!--)[a-z-]+:(.+)\]$/.exec(utility) ?? []);
        if (value && colorIn(value)) report(node, word);
      }),
      ...eachStyleObject(context, (object) => {
        for (const p of object.properties) {
          const key = keyName(p);
          const value = key && !key.startsWith("--") ? literalValue(p.value) : undefined;
          if (value === undefined) continue;
          if (colorIn(value) || (COLOR_KEY.test(key ?? "") && NAMED.test(value.trim()))) report(p.value, value);
        }
      }),
    };
  },
});

export const bad = [
  'export const Tag = () => <span className="rounded bg-[#1a1a1a] px-2 text-white">New</span>;',
  "export const Error = ({ text }: { text: string }) => <p className=\"text-sm\" style={{ color: '#ff4444', marginTop: 4 }}>{text}</p>;",
  'export const glow = cn("shadow-[0_0_3px_1px_rgba(255,255,255,0.3)]", "rounded-lg");',
  "export const Panel = () => <div className=\"p-4\" style={{ background: 'white', border: '1px solid #e5e5e5' }} />;",
  "const card: React.CSSProperties = { backgroundColor: 'hsl(220 14% 96%)' };\nexport const Card = () => <div className=\"p-4\" style={card} />;",
];

export const good = [
  'export const Tag = () => <span className="rounded bg-muted px-2 text-muted-foreground">New</span>;',
  'export const Chip = () => <span className="bg-[color:var(--ui-surface)] text-[color-mix(in_oklch,var(--foreground)_75%,transparent)]" />;',
  'export const Ring = () => <div className="ring-[hsl(var(--ring))] bg-[rgb(var(--surface)_/_0.5)]" />;',
  "export const Fill = ({ hue }: { hue: string }) => <div style={{ background: hue, color: 'var(--fg, #111)' }} />;",
  'export const Swatch = () => <svg><circle fill="#ff0000" r="4" /></svg>;',
  "export const Clear = () => <div style={{ background: 'transparent', color: 'currentColor', '--accent': '#0af' }} />;",
  'export const Icon = () => <i className="bg-[url(/sprite.svg#add)] [--accent:#0af]" />;',
  'export const TAGS = { vip: "#22c55e" };',
  "export const OgCard = () => <div style={{ display: 'flex', background: '#ffffff', color: '#111827' }}>Lucra</div>;",
];
