// @ts-check
// Reading styling values out of source lines, for the style-drift gate: colours, font sizes and weights, line
// heights, letter spacing, radii, spacing, z-indexes and durations, from CSS, style objects, Tailwind classes and
// SwiftUI modifiers; and CSS custom properties, SCSS variables and theme-module colours as named tokens.

/** @typedef {"colour" | "font size" | "font weight" | "line height" | "letter spacing" | "radius" | "spacing" | "z-index" | "duration"} Category */
/**
 * One value on one line. `key` is the comparable form (`#333333`, `14px`); `rgba` is set for colours, `num` and
 * `unit` for numbers; `token` names the token a definition line defines.
 * @typedef {{ cat: Category, key: string, raw: string, num?: number, unit?: string, rgba?: number[], token?: string }} Value
 */

const HEX = /(?<![\w&#$-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNC = /(?<![\w-])(?:rgba?|hsla?)\(\s*[\d.]+(?:deg)?%?\s*[,\s]\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)/g;
const CSS_PROPS = /(?<![\w-])(font-size|font-weight|line-height|letter-spacing|border(?:-[a-z]+)*-radius|padding(?:-[a-z]+)*|margin(?:-[a-z]+)*|gap|row-gap|column-gap|z-index|transition-duration|animation-duration)\s*:\s*([^;{}]+)/g;
const JS_PROPS = /(?<![\w$])(fontSize|fontWeight|lineHeight|letterSpacing|border\w*Radius|padding\w*|margin\w*|gap|rowGap|columnGap|zIndex)\s*:\s*(?:(['"`])([^'"`\n]+)\2|(-?[\d.]+)(?![\w.(]))/g;
const TW_ARBITRARY = /(?<![\w-])(text|leading|tracking|font|rounded(?:-[a-z]{1,2})?|p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|z|duration|bg|border(?:-[xytrbl])?|ring|fill|stroke|outline|from|via|to|decoration|caret|accent)-\[([^\]\s]+)\]/g;
const SWIFT = /\.font\(\.system\(size:\s*([\d.]+)|\.padding\((?:\.[a-zA-Z]+,\s*)?([\d.]+)\)|cornerRadius(?::\s*|\()([\d.]+)/g;
const CUSTOM_PROP = /(?<![\w-])(--[\w-]+|\$[\w-]+)\s*:\s*([^;{}]+)/g;
/** Colour keywords that are not a palette choice. */
/** Pure black or white, at any opacity: shades and scrims, not a palette choice. @param {string} key */
export const isNeutral = (key) => /^#(?:000000|ffffff)/.test(key);

/** @param {number} n */
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/**
 * A colour literal as `#rrggbb` (or `#rrggbbaa` when not opaque) and its channels, or undefined.
 * @param {string} raw
 * @returns {{ key: string, rgba: number[] } | undefined}
 */
export function parseColour(raw) {
  let r, g, b, a = 1;
  if (raw.startsWith("#")) {
    const h = raw.length <= 5 ? raw.slice(1).replace(/./g, "$&$&") : raw.slice(1);
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (h.length === 8) a = parseInt(h.slice(6), 16) / 255;
  } else {
    const nums = [...raw.matchAll(/[\d.]+%?/g)].map((m) => m[0]);
    // A function colour built from variables (`hsl(var(--ring))`) has no channels to read, so it is not a literal.
    if (nums.length < 3) return undefined;
    const val = (/** @type {string} */ s, /** @type {number} */ max) => (s.endsWith("%") ? (parseFloat(s) / 100) * max : parseFloat(s));
    if (raw.startsWith("hsl")) [r, g, b] = hslToRgb(parseFloat(nums[0]), val(nums[1], 1) * (nums[1].endsWith("%") ? 1 : 0.01), val(nums[2], 1) * (nums[2].endsWith("%") ? 1 : 0.01));
    else [r, g, b] = nums.slice(0, 3).map((s) => val(s, 255));
    if (nums[3] !== undefined) a = val(nums[3], 1);
  }
  if ([r, g, b, a].some((n) => !Number.isFinite(n))) return undefined;
  const alpha = a >= 0.999 ? "" : hex2(a * 255);
  return { key: `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha}`, rgba: [r, g, b, a] };
}

/** @param {number} h @param {number} s @param {number} l */
function hslToRgb(h, s, l) {
  const k = (/** @type {number} */ n) => (n + h / 30) % 12;
  const f = (/** @type {number} */ n) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * Perceptual distance between two colours in OKLab (Ottosson 2020), where about 0.02 is just noticeable. Colours whose
 * opacity differs are never near.
 * @param {number[]} x @param {number[]} y
 */
export function colourDistance(x, y) {
  if (Math.abs(x[3] - y[3]) > 0.02) return Infinity;
  const [a, b] = [oklab(x), oklab(y)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** @param {number[]} rgba */
function oklab([r, g, b]) {
  const lin = (/** @type {number} */ c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/**
 * A length, number or duration as `{ num, unit }`: rem becomes px (at 16px), s becomes ms, a bare number keeps no unit.
 * Anything else (percentages, `auto`, `calc()`) is undefined.
 * @param {string} raw
 */
export function parseNumber(raw) {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|ms|s|pt)?$/.exec(raw.trim());
  if (!m) return undefined;
  let num = parseFloat(m[1]);
  let unit = m[2] ?? "";
  if (unit === "rem") [num, unit] = [num * 16, "px"];
  if (unit === "s") [num, unit] = [num * 1000, "ms"];
  if (unit === "pt") unit = "px";
  return { num: Math.round(num * 1000) / 1000, unit };
}

/** @param {string} prop a CSS or JS property name @returns {Category | undefined} */
function categoryOf(prop) {
  const p = prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  if (p === "font-size") return "font size";
  if (p === "font-weight") return "font weight";
  if (p === "line-height") return "line height";
  if (p === "letter-spacing") return "letter spacing";
  if (p.endsWith("radius")) return "radius";
  if (/^(?:padding|margin|gap|row-gap|column-gap)/.test(p)) return "spacing";
  if (p === "z-index") return "z-index";
  if (p.endsWith("duration")) return "duration";
  return undefined;
}

/** The category a token's name says it holds, for a numeric token. @param {string} name @returns {Category | undefined} */
function tokenCategory(name) {
  if (/radius|rounded/.test(name)) return "radius";
  if (/font-size|^--text-|^\$text-|-fs-|^--fs-/.test(name)) return "font size";
  if (/weight/.test(name)) return "font weight";
  if (/leading|line-height/.test(name)) return "line height";
  if (/tracking|letter-spacing/.test(name)) return "letter spacing";
  if (/spacing|space|gap|gutter/.test(name)) return "spacing";
  if (/z-?index|^--z-/.test(name)) return "z-index";
  if (/duration/.test(name)) return "duration";
  return undefined;
}

/**
 * Numeric values of one property declaration: `padding: 4px 8px` gives two. Zero, `auto` and expressions are skipped.
 * @param {Category} cat @param {string} text
 * @returns {Value[]}
 */
function numbers(cat, text) {
  /** @type {Value[]} */
  const out = [];
  if (/var\(|calc\(|\$|\{/.test(text)) return out;
  for (const part of text.trim().split(/\s+/)) {
    const n = parseNumber(part);
    // Negative margins and offsets are positioning, not spacing; a weight pair (`100 900`) is a font-face range.
    if (!n || n.num === 0 || (n.num < 0 && cat === "spacing") || (cat === "font weight" && text.trim().includes(" "))) continue;
    // A bare number is pixels in a style object, but a ratio for line height and a step for weight or z-index.
    const unit = n.unit === "" && (cat === "font size" || cat === "radius" || cat === "spacing") ? "px" : n.unit;
    out.push({ cat, key: `${n.num}${unit}`, raw: part, num: n.num, unit });
  }
  return out;
}

/** Every colour literal in a stretch of text. @param {string} text @returns {Value[]} */
function colours(text) {
  /** @type {Value[]} */
  const out = [];
  for (const m of [...text.matchAll(HEX), ...text.matchAll(FUNC)]) {
    const c = parseColour(m[0]);
    if (c) out.push({ cat: "colour", key: c.key, raw: m[0], rgba: c.rgba });
  }
  return out;
}

/**
 * A token definition on this line (`--color-ink: #333;`, `$space-2: 8px;`), with its value when that is a single
 * colour or a number of a category its name gives.
 * @param {string} line
 * @returns {Value[]}
 */
function tokens(line) {
  /** @type {Value[]} */
  const out = [];
  for (const [, name, value] of line.matchAll(CUSTOM_PROP)) {
    const v = value.trim();
    const colour = colours(v);
    if (colour.length === 1 && colour[0].raw.length === v.length) out.push({ ...colour[0], token: name });
    const cat = tokenCategory(name);
    const n = cat && parseNumber(v);
    if (cat && n && n.num !== 0) out.push({ cat, key: `${n.num}${n.unit}`, raw: v, num: n.num, unit: n.unit, token: name });
    if (!out.length) out.push({ cat: "colour", key: "", raw: v, token: name });
  }
  return out;
}

/**
 * The styling values one source line uses, and the tokens it defines. `kind` is the file's family: css, js, markup
 * (JSX and template files, where Tailwind classes live), swift, or theme (a JS theme or token module, where every
 * literal is a definition).
 * @param {string} line
 * @param {"css" | "js" | "markup" | "swift" | "theme"} kind
 * @returns {Value[]}
 */
export function valuesOf(line, kind) {
  // Every value has a digit or a `#`; most lines have neither, and this one test skips them.
  if (!/[\d#]/.test(line)) return [];
  const code = line.replace(/<!--.*?-->/g, "").replace(/(?:^|\s)\/\/.*$/, "");
  if (kind === "css" || /--[\w-]+\s*:/.test(code)) {
    const defined = tokens(code);
    if (defined.length) return defined.filter((v) => v.key);
  }
  /** @type {Value[]} */
  const out = [];
  if (kind === "theme") return out;
  if (kind === "css") for (const [, prop, text] of code.matchAll(CSS_PROPS)) out.push(...numbers(/** @type {Category} */ (categoryOf(prop)), text));
  if (kind === "js" || kind === "markup") {
    for (const m of code.matchAll(JS_PROPS)) out.push(...numbers(/** @type {Category} */ (categoryOf(m[1])), m[3] ?? m[4]));
    out.push(...tailwind(code));
  }
  if (kind === "swift") {
    for (const m of code.matchAll(SWIFT)) {
      const cat = m[1] ? "font size" : m[2] ? "spacing" : "radius";
      out.push(...numbers(cat, `${m[1] ?? m[2] ?? m[3]}`));
    }
  }
  if (!paletteLine(code)) out.push(...colours(code).filter((c) => !out.some((v) => v.raw === c.raw)));
  return out;
}

/**
 * Lines whose colours are data or artwork rather than styling choices: gradient stops (shades of one another on
 * purpose), inline SVG, palette lists (a bare quoted colour, three or more on a line) and records such as
 * `{ hex: '#3B82F6', name: 'Blue' }`.
 * @param {string} code
 */
function paletteLine(code) {
  if (/gradient\(|<(?:svg|path|circle|rect|ellipse|polygon|polyline|line|stop|g)\b|\b(?:fill|stroke|stopColor|stop-color)=/.test(code)) return true;
  if (/^\s*["'`]#[0-9a-fA-F]+["'`]\s*,?\s*$/.test(code) || /\b(?:name|label|title)\s*:\s*["'`]/.test(code)) return true;
  return (code.match(HEX) ?? []).length >= 3;
}


// ponytail: named Tailwind steps (`text-sm`, `p-4`) are not counted, since a theme can remap them; read the theme's
// scale if Tailwind-only projects need the counts
/** Values in arbitrary Tailwind classes: `text-[13px]`, `bg-[#333]`. @param {string} code */
function tailwind(code) {
  /** @type {Value[]} */
  const out = [];
  for (const [, prefix, inner] of code.matchAll(TW_ARBITRARY)) {
    const c = parseColour(inner);
    if (c && /^(?:#|rgb|hsl)/.test(inner)) {
      out.push({ cat: "colour", key: c.key, raw: inner, rgba: c.rgba });
      continue;
    }
    const cat = twCategory(prefix);
    if (cat) out.push(...numbers(cat, inner));
  }
  return out;
}

/** @param {string} prefix @returns {Category | undefined} */
function twCategory(prefix) {
  if (prefix === "text") return "font size";
  if (prefix === "leading") return "line height";
  if (prefix === "tracking") return "letter spacing";
  if (prefix === "font") return "font weight";
  if (prefix.startsWith("rounded")) return "radius";
  if (/^(?:p|m|gap|space)/.test(prefix)) return "spacing";
  if (prefix === "z") return "z-index";
  if (prefix === "duration") return "duration";
  return undefined;
}

/**
 * The text with block comments blanked, newlines kept, so line numbers still hold. A `/*` counts only after
 * whitespace or punctuation, so a glob such as `src/**` followed by `/*.ts` in a string is left alone.
 * @param {string} text
 */
export const blankComments = (text) => text.replace(/(^|[\s;{}(,])\/\*[\s\S]*?\*\//g, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, " "));


