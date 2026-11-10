// @ts-check
// Fails when the change adds a styling value that is almost, but not exactly, one the project already has: a colour a
// hair off an existing one, a font size or spacing value a pixel off the scale, a literal that is a token's value, a
// value off a scale the project keeps closed, or a new token that duplicates an existing one. The inventory of what
// the project uses is read from the repository itself; nothing is configured.
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { addedLines, listFiles, matches, resolveBase, topLevel, workingDiff } from "./lib.mjs";
import { blankComments, colourDistance, isNeutral, valuesOf } from "./style-values.mjs";

const STYLED = /\.(?:css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|astro|html|swift)$/;
// Not shipped styling: tests, stories, fixtures, mocks, generated and vendored files, minified bundles, and SVG and data
// files (which are not in STYLED at all).
const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__|__mocks__|__fixtures__|fixtures?|mocks?|stories|storybook|e2e|docs?|\.[^/]+)\/|\.min\.|(?:^|\/)seeds?\/|(?:^|[/.-])seeds?\.[cm]?[jt]s$|\.(?:stories|story|fixture|mock)\.|\.d\.ts$|\.config\.[cm]?[jt]s$(?<!tailwind\.config\.[cm]?[jt]s)/;
const THEME = /(?:^|\/)(?:tailwind\.config\.[cm]?[jt]s|[\w-]*(?:tokens?|theme|colou?rs|palette)[\w-]*\.[cm]?[jt]s)$/i;
const MARKUP = /\.(?:[jt]sx|vue|svelte|astro|html)$/;
const MAX_BYTES = 512 * 1024;
/** OKLab distance under which two colours read as the same: about the just-noticeable difference (0.02). */
const NEAR_COLOUR = 0.02;
/** How far a number may sit from an existing one and still be a near miss, per category and unit. */
const NEAR = { "font size": { px: 1 }, radius: { px: 1 }, spacing: { px: 1 }, "line height": { px: 1, "": 0.05 }, "letter spacing": { em: 0.005, px: 0.25 } };
/** A near miss must also be within this share of the value it misses, so 2.5px is not "nearly 2px". */
const NEAR_SHARE = 0.15;
/** Uses an existing value needs before a new one is called a near miss of it. */
const POPULAR = 5;
/** References a numeric token needs before a literal with its value is sent to it: 400 or 1.2 match tokens by chance. */
const NUMBER_TOKEN_REFS = 10;
/** Categories where a literal equal to a token is that token: 16px padding equals a gutter token by coincidence. */
const TOKENISED = new Set(["font size", "radius"]);
/** Categories whose scale can be closed: a far-off font size, weight or radius is a new step, a line height often is not. */
const CLOSABLE = new Set(["font size", "font weight", "radius"]);
const SHARED_PKG = /^(?:|packages\/[^/]+|shared|libs?\/[^/]+|design-system|ui)$/;

/** @typedef {import("./style-values.mjs").Value} Value */
/** @typedef {Value & { file: string, line: number, pkg: string }} Seen */
/** @typedef {{ values: Map<string, { count: number, value: Value }>, tokens: Seen[] }} Inventory */

/**
 * The folder of the nearest package.json above each file (the repository top is ""), so one app's tokens and palette
 * are not offered to another.
 * @param {string} top @param {string[]} files
 */
function packageOf(top, files) {
  const roots = new Set(files.filter((f) => posix.basename(f) === "package.json" && existsSync(join(top, f))).map((f) => posix.dirname(f)).map((d) => (d === "." ? "" : d)));
  return (/** @type {string} */ file) => {
    for (let dir = posix.dirname(file); dir !== "." && dir !== "/"; dir = posix.dirname(dir)) if (roots.has(dir)) return dir;
    return "";
  };
}

/** Whether a value or token in package `from` is in reach of a file in package `to`. @param {string} from @param {string} to */
const inReach = (from, to) => from === to || SHARED_PKG.test(from) || to.startsWith(`${from}/`);

/** Files that can reference a CSS token: stylesheets and markup. A plain script or Swift file cannot, so no token is offered there. @param {Seen} v */
const canUseTokens = (v) => /\.(?:css|scss|sass|less|[jt]sx|vue|svelte|astro|html)$/.test(v.file);

/** @param {string} path */
const kindOf = (path) => (THEME.test(path) ? "theme" : /\.(?:css|scss|sass|less)$/.test(path) ? "css" : path.endsWith(".swift") ? "swift" : MARKUP.test(path) ? "markup" : "js");

/**
 * Every styling value and token in the repository, split into what the change added and what was already there, plus
 * how often each token is referenced (`var(--x)`, or a Tailwind class such as `bg-x` for `--color-x`).
 * @param {string} top @param {string[]} files @param {Map<string, Set<number>>} added
 */
export function scan(top, files, added) {
  const pkg = packageOf(top, files);
  /** @type {Seen[]} */ const fresh = [];
  /** @type {Seen[]} */ const old = [];
  /** @type {Map<string, number>} */ const refs = new Map();
  const ref = (/** @type {string} */ name) => refs.set(name, (refs.get(name) ?? 0) + 1);
  for (const file of files) {
    if (!STYLED.test(file) || SKIP.test(file)) continue;
    let text;
    try {
      text = readFileSync(join(top, file), "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" || /** @type {NodeJS.ErrnoException} */ (error).code === "EISDIR") continue;
      throw error;
    }
    if (text.length > MAX_BYTES || text.includes("\0")) continue;
    const kind = kindOf(file);
    const mine = added.get(file);
    blankComments(text).split("\n").forEach((line, i) => {
      if (line.includes("var(")) for (const [, name] of line.matchAll(/var\((--[\w-]+)/g)) ref(name);
      if (kind === "markup") for (const [, name] of line.matchAll(/(?<![\w-])(?:bg|text|border|fill|stroke|ring|outline|from|via|to|decoration|divide|caret|accent|shadow)-([a-z][\w-]*)/g)) ref(`--color-${name}`);
      for (const v of valuesOf(line, kind)) (mine?.has(i + 1) ? fresh : old).push({ ...v, file, line: i + 1, pkg: pkg(file) });
    });
  }
  return { fresh, old, refs };
}

/**
 * What a package can see: every existing value with its count, and the tokens, from its own package, the packages
 * above it and shared ones.
 * @param {Seen[]} old @param {string} target
 * @returns {Inventory}
 */
export function inventoryFor(old, target) {
  /** @type {Inventory["values"]} */
  const values = new Map();
  /** @type {Seen[]} */
  const tokens = [];
  for (const v of old) {
    if (!inReach(v.pkg, target)) continue;
    if (v.token) tokens.push(v);
    else {
      const id = `${v.cat}\0${v.key}`;
      const entry = values.get(id);
      if (entry) entry.count++;
      else values.set(id, { count: 1, value: v });
    }
  }
  return { values, tokens };
}

/**
 * The finding for one added colour literal, if any.
 * @param {Seen} v @param {Inventory} inv @param {Map<string, number>} refs
 */
function colourFinding(v, inv, refs) {
  if (!canUseTokens(v)) inv = { values: inv.values, tokens: [] };
  const holders = [...new Set(inv.tokens.filter((t) => t.cat === "colour" && t.key === v.key).map((t) => t.token))];
  if (holders.length === 1 && !isNeutral(v.key)) return `colour ${v.raw} is the value of ${holders[0]}${uses(refs.get(holders[0] ?? ""))}: use the token`;
  if (holders.length || inv.values.has(`colour\0${v.key}`) || isNeutral(v.key)) return undefined;
  /** @type {{ name: string, key: string, count: number, d: number } | undefined} */
  let best;
  for (const t of inv.tokens) {
    const d = t.cat === "colour" && t.rgba && v.rgba && !isNeutral(t.key) ? colourDistance(v.rgba, t.rgba) : Infinity;
    if (d < NEAR_COLOUR && (!best || d < best.d)) best = { name: /** @type {string} */ (t.token), key: t.key, count: refs.get(t.token ?? "") ?? 0, d };
  }
  if (!best) {
    for (const { count, value } of inv.values.values()) {
      const d = value.cat === "colour" && value.rgba && v.rgba && count >= POPULAR && !isNeutral(value.key) ? colourDistance(v.rgba, value.rgba) : Infinity;
      if (d < NEAR_COLOUR && (!best || d < best.d)) best = { name: "", key: value.key, count, d };
    }
  }
  if (!best) return undefined;
  return best.name ? `colour ${v.raw} is nearly ${best.key} (${best.name}${uses(best.count, ", ")}): use the token` : `colour ${v.raw} is nearly ${best.key} (used ${best.count} times): use ${best.key}`;
}

/** @param {number | undefined} count @param {string} [lead] */
const uses = (count, lead = " (") => (count ? `${lead}used ${count} time${count === 1 ? "" : "s"}${lead === " (" ? ")" : ""}` : "");

/**
 * The scale a category keeps: its existing values by count, and whether it is closed (a dozen values or fewer
 * covering almost every use).
 * @param {Inventory} inv @param {string} cat @param {string} unit
 */
function scaleOf(inv, cat, unit) {
  const list = [...inv.values.values()].filter((e) => e.value.cat === cat && e.value.unit === unit).sort((a, b) => b.count - a.count);
  const total = list.reduce((n, e) => n + e.count, 0);
  const steps = list.filter((e) => e.count >= 2);
  const covered = steps.slice(0, 12).reduce((n, e) => n + e.count, 0);
  // ponytail: "closed" means at most 12 values cover 97% of at least 40 uses; tuned on the corpus, not configurable
  const closed = total >= 40 && steps.length <= 12 && covered >= 0.97 * total;
  return { list, total, closed, steps: steps.slice(0, 12) };
}

/**
 * The finding for one added number, if any: a near miss of a popular value, a token's exact value, or a value off a
 * closed scale.
 * @param {Seen} v @param {Inventory} inv @param {Map<string, number>} refs
 */
function numberFinding(v, inv, refs) {
  if (!canUseTokens(v)) inv = { values: inv.values, tokens: [] };
  const holders = [...new Set(inv.tokens.filter((t) => t.cat === v.cat && t.key === v.key).map((t) => t.token))];
  if (holders.length === 1 && TOKENISED.has(v.cat) && (refs.get(holders[0] ?? "") ?? 0) >= NUMBER_TOKEN_REFS) return `${v.cat} ${v.raw} is the value of ${holders[0]}${uses(refs.get(holders[0] ?? ""))}: use the token`;
  if (holders.length || inv.values.has(`${v.cat}\0${v.key}`)) return undefined;
  const scale = scaleOf(inv, v.cat, v.unit ?? "");
  const tolerance = /** @type {Record<string, number> | undefined} */ (NEAR[/** @type {keyof typeof NEAR} */ (v.cat)])?.[v.unit ?? ""];
  const num = /** @type {number} */ (v.num);
  const close = (/** @type {number} */ n) => tolerance !== undefined && Math.abs(n - num) <= tolerance + 1e-9 && Math.abs(n - num) <= NEAR_SHARE * Math.abs(n);
  const near = scale.list.filter((e) => e.count >= POPULAR && close(/** @type {number} */ (e.value.num)));
  if (near.length) {
    return `${v.cat} ${v.raw} is nearly ${near.map((e) => `${e.value.key} (used ${e.count} times)`).join(" or ")}: use ${near.length === 1 ? near[0].value.key : "one of those"}`;
  }
  if (!scale.closed || !CLOSABLE.has(v.cat)) return undefined;
  const sorted = scale.steps.map((e) => /** @type {number} */ (e.value.num)).sort((a, b) => a - b);
  const share = Math.round((100 * scale.steps.reduce((n, e) => n + e.count, 0)) / scale.total);
  const below = sorted.filter((n) => n < num).pop();
  const above = sorted.find((n) => n > num);
  const pick = [below, above].filter((n) => n !== undefined).map((n) => `${n}${v.unit}`).join(" or ");
  return `${v.cat} ${v.raw} is off this project's scale (${sorted.map((n) => `${n}${v.unit}`).join(", ")}: ${share}% of ${scale.total} uses): use ${pick}`;
}

/** The family a token belongs to: its name without the last segment (`--gray-750` is `--gray`). @param {string} name */
const family = (name) => name.replace(/-[^-]+$/, "");

/**
 * The finding for one token the change defines for the first time, if it duplicates or nearly duplicates another.
 * @param {Seen} t @param {Inventory} inv
 */
function tokenFinding(t, inv) {
  if (inv.tokens.some((o) => o.token === t.token)) return undefined;
  // Semantic tokens share and nearly share values on purpose (--muted and --secondary); only a sibling in the same
  // family (--gray-750 beside --gray-700) is a duplicate.
  for (const o of inv.tokens) {
    if (o.cat !== t.cat || o.unit !== t.unit || family(/** @type {string} */ (o.token)) !== family(/** @type {string} */ (t.token))) continue;
    if (o.key === t.key) return `token ${t.token} (${t.raw}) duplicates ${o.token}: use ${o.token}`;
    const d = t.cat === "colour" ? colourDistance(/** @type {number[]} */ (t.rgba), /** @type {number[]} */ (o.rgba)) : Math.abs(/** @type {number} */ (t.num) - /** @type {number} */ (o.num));
    const tolerance = t.cat === "colour" ? NEAR_COLOUR : /** @type {Record<string, number> | undefined} */ (NEAR[/** @type {keyof typeof NEAR} */ (t.cat)])?.[t.unit ?? ""] ?? -1;
    if (d < tolerance + 1e-9) return `token ${t.token} (${t.raw}) is nearly ${o.token} (${o.raw}): use ${o.token}, or make the two clearly different`;
  }
  return undefined;
}

/**
 * The finding for one added value against what its package can see, if any.
 * @param {Seen} v @param {Inventory} inv @param {Map<string, number>} refs
 */
export function findingFor(v, inv, refs) {
  if (v.token) return tokenFinding(v, inv);
  if (v.cat === "colour") return colourFinding(v, inv, refs);
  // A style object in a plain script is usually for someone else's API (Stripe appearance, a chart library, an email).
  return /\.[cm]?[jt]s$/.test(v.file) ? undefined : numberFinding(v, inv, refs);
}

/**
 * Findings for added values, each against what its package can see.
 * @param {Seen[]} fresh @param {Seen[]} old @param {Map<string, number>} refs
 */
export function drift(fresh, old, refs) {
  /** @type {Map<string, Inventory>} */
  const byPkg = new Map();
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  const seen = new Set();
  for (const v of fresh) {
    if (!byPkg.has(v.pkg)) byPkg.set(v.pkg, inventoryFor(old, v.pkg));
    const inv = /** @type {Inventory} */ (byPkg.get(v.pkg));
    const message = findingFor(v, inv, refs);
    const target = `${v.file}:${v.token ?? v.key}`;
    if (!message || seen.has(target)) continue;
    seen.add(target);
    findings.push({ target, message: `${v.file}:${v.line} ${message}` });
  }
  return findings;
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function styleDrift({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const top = topLevel(cwd);
  const [patch] = workingDiff(cwd, [["-U0", "-M", sha]]);
  const added = new Map([...addedLines(patch)].filter(([file]) => STYLED.test(file) && !SKIP.test(file) && !matches(file, testPaths)));
  if (!added.size) return { findings: [], summary: "0 added styling lines checked" };
  const { fresh, old, refs } = scan(top, listFiles(top).filter((f) => !matches(f, testPaths)), added);
  const findings = drift(fresh, old, refs);
  return { findings, summary: `${fresh.length} added styling values checked against ${old.length} in the repository` };
}
