// @ts-check
// What the project's design system offers, read once per run from its stylesheets and Tailwind config. A ui rule
// only reports a hardcoded value when the project has something to use instead.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const SKIP_DIRS = /^(?:node_modules|dist|build|out|coverage|vendor|Pods|ios|android|\..+)$/;
const STYLE_FILE = /\.(?:css|scss|sass|less|pcss)$|^tailwind\.config\.[cm]?[jt]s$/;
// The project's own form primitives, shadcn-style: ui/button.tsx, ui/input.tsx.
const PRIMITIVE_FILE = /^(button|input|select|textarea)\.[jt]sx$/i;
const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black";
// A custom property holding a colour: a literal, a colour function, or shadcn's bare "222 47% 11%" channels.
const COLOR_VAR = /(--[\w-]+)\s*:\s*(?:#[\da-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color|color-mix)\(|\d+(?:\.\d+)?(?:deg)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%)/gi;
const THEME_COLOR = /--color-([a-z][\w-]*)\s*:/g;
const TYPE_VAR = /(--(?:font|text|type|leading|tracking|font-size|font-weight)[\w-]*)\s*:/g;
const PALETTE_NAME = new RegExp(`^(?:${PALETTE})(?:-\\d+)?$`);

/**
 * `stylesheets` is 0 when none were found (a fixture, or styles kept in JS): rules then assume a system exists.
 * `primitives` maps a raw element (`button`) to the project's own component file for it (`src/components/ui/button.tsx`).
 * @typedef {{ colorVars: string[], themeColors: string[], typeVars: string[], tailwind: boolean, stylesheets: number, primitives: Record<string, string> }} DesignSystem
 * @type {Map<string, DesignSystem>}
 */
const cache = new Map();

/** Stylesheets, Tailwind configs and ui/ primitives under `dir`, skipping dependencies, build output and dot folders. @param {string} dir */
function styleFiles(dir, depth = 0, found = /** @type {string[]} */ ([])) {
  if (depth > 8) return found;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.test(e.name)) styleFiles(join(dir, e.name), depth + 1, found);
    else if (e.isFile() && (STYLE_FILE.test(e.name) || (PRIMITIVE_FILE.test(e.name) && basename(dir) === "ui"))) found.push(join(dir, e.name));
  }
  return found;
}

/** Colour names a Tailwind config's `colors: { ... }` block declares (rough: every key inside the block). @param {string} text */
function configColors(text) {
  const start = text.search(/\bcolors\s*:\s*\{/);
  if (start < 0) return [];
  const open = text.indexOf("{", start);
  let end = open;
  for (let depth = 0; end < text.length; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}" && --depth === 0) break;
  }
  return [...text.slice(open + 1, end).matchAll(/(?:^|[{,])\s*["']?([a-z][\w-]*)["']?\s*:/gim)].map((m) => m[1]).filter((n) => n !== "DEFAULT");
}

/**
 * Stylesheets a stylesheet `@import`s from outside the project folder: a workspace package's tokens
 * (`@import "@acme/ui/globals.css"`), found through the nearest node_modules up the tree.
 * @param {string} file @param {string} text
 */
function importedSheets(file, text) {
  const found = [];
  for (const [, spec] of text.matchAll(/@import\s+(?:url\()?["']([^"']+\.css)["']/g)) {
    if (spec.startsWith(".")) continue; // relative imports are inside the project, so the walk already found them
    for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", spec);
      if (existsSync(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

/** @param {string} cwd @returns {DesignSystem} */
export function designSystem(cwd) {
  const known = cache.get(cwd);
  if (known) return known;
  const colorVars = new Set();
  const themeColors = new Set();
  const typeVars = new Set();
  let tailwind = false;
  /** @type {Record<string, string>} */
  const primitives = {};
  const found = styleFiles(cwd);
  for (const file of found) {
    const element = PRIMITIVE_FILE.exec(basename(file))?.[1].toLowerCase();
    if (element) primitives[element] ??= relative(cwd, file);
  }
  const files = found.filter((f) => !PRIMITIVE_FILE.test(basename(f)));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const sheet of importedSheets(file, text)) if (!files.includes(sheet)) files.push(sheet);
    const isConfig = /tailwind\.config/.test(file);
    tailwind ||= isConfig || /@import\s+["']tailwindcss|@tailwind\s|@theme\b/.test(text);
    for (const m of text.matchAll(COLOR_VAR)) colorVars.add(m[1]);
    for (const m of text.matchAll(THEME_COLOR)) themeColors.add(m[1]);
    for (const m of text.matchAll(TYPE_VAR)) typeVars.add(m[1]);
    if (isConfig) {
      for (const name of configColors(text)) themeColors.add(name);
      if (/\b(?:fontSize|fontFamily)\s*:/.test(text)) typeVars.add("the Tailwind theme");
    }
  }
  const system = {
    colorVars: [...colorVars],
    themeColors: [...themeColors].filter((n) => !PALETTE_NAME.test(n)),
    typeVars: [...typeVars],
    tailwind,
    stylesheets: files.length,
    primitives,
  };
  cache.set(cwd, system);
  return system;
}

/** Up to three names for a message, as " (`--primary`, `--muted`, `--border`)", or "" when there are none. @param {string[]} names */
export const examples = (names) => (names.length ? ` (${names.slice(0, 3).map((n) => `\`${n}\``).join(", ")})` : "");
