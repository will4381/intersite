// @ts-check
// Fails when a file or folder the change adds breaks a naming convention its siblings already keep: casing, a shared
// suffix (`*.service.ts`), the test-name pattern, or file names that match their main export. Nothing is configured:
// a convention is whatever a clear majority of enough siblings already do, measured per folder and per kind of file.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { changes, listFiles, matches, resolveBase, topLevel } from "./lib.mjs";

// What the casing inference looks at: code and style files. Data, docs, assets and migrations name files by other rules.
const CODE = /\.(?:[cm]?[jt]sx?|swift|py|rb|go|rs|kts?|java|vue|svelte|astro|css|scss|less)$/;
const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__|migrations|drizzle|Pods|DerivedData)\/|\.min\.|\.d\.[cm]?ts$/;
// Names a framework or tool chooses: routes, entry points, special files. Never reported, never counted.
const RESERVED = /^(?:index|page|layout|route|loading|error|not-found|global-error|template|default|head|middleware|proxy|instrumentation|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest|main|app|App|mod|lib|setup|conftest|__init__|__main__|vite-env|env|global|globals|styles?|types?|constants|utils|helpers|README|LICENSE|CHANGELOG|Package|ContentView)$/;
// A first character a framework gives meaning to: `[id]`, `(group)`, `@slot`, `_private`, `__root`, `$param`, `+page`, dotfiles.
const SPECIAL = /^[^A-Za-z]/;
const MIN_AGREE = 5;
const SHARE = 0.9;

/** @typedef {"kebab" | "snake" | "camel" | "Pascal"} Style */
const STYLE_NAME = { kebab: "kebab-case", snake: "snake_case", camel: "camelCase", Pascal: "PascalCase" };

/**
 * The casing of a bare name: one lowercase word ("word") fits kebab, snake and camel alike.
 * @param {string} stem
 * @returns {Style | "word" | undefined}
 */
export function styleOf(stem) {
  if (/^[a-z][a-z0-9]*$/.test(stem)) return "word";
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(stem)) return "kebab";
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(stem)) return "snake";
  if (/^[a-z][a-z0-9]*(?:[A-Z]+[a-z0-9]*)+$/.test(stem)) return "camel";
  if (/^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(stem)) return "Pascal";
  return undefined;
}

/** @param {Style | "word" | undefined} style @param {Style} wanted */
const fits = (style, wanted) => style === wanted || (style === "word" && wanted !== "Pascal");

/** A name in another casing: `user_card` as Pascal is `UserCard`. @param {string} stem @param {Style} style */
export function restyle(stem, style) {
  const words = stem.split(/[-_]|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean).map((w) => w.toLowerCase());
  const cap = (/** @type {string} */ w) => w[0].toUpperCase() + w.slice(1);
  if (style === "kebab") return words.join("-");
  if (style === "snake") return words.join("_");
  if (style === "Pascal") return words.map(cap).join("");
  return words[0] + words.slice(1).map(cap).join("");
}

/**
 * A file name split into its stem, its middle parts (`service` in `user.service.ts`) and its extension.
 * @param {string} name
 */
export function parts(name) {
  const dots = name.split(".");
  const ext = dots.length > 1 ? dots.pop() ?? "" : "";
  return { stem: dots[0], middle: dots.slice(1), ext };
}

/** The test-name pattern a file follows, or undefined. @param {string} name */
function testPattern(name) {
  const { stem, middle } = parts(name);
  if (middle.includes("test")) return ".test";
  if (middle.includes("spec")) return ".spec";
  if (stem.startsWith("test_")) return "test_*";
  if (stem.endsWith("_test")) return "*_test";
  return undefined;
}

/** The kind of file a name is compared within: hooks, tests and each language family keep their own casing. @param {string} name */
function kindOf(name) {
  const { stem, ext } = parts(name);
  if (testPattern(name)) return "test";
  if (/^use(?:[A-Z0-9]|[-_][a-z])/.test(stem)) return "hook";
  if (/^[jt]sx$/.test(ext)) return "jsx";
  if (/^[cm]?[jt]s$/.test(ext)) return "js";
  if (/^(?:s?css|less)$/.test(ext)) return "css";
  return ext;
}

/**
 * The convention a group of sibling names keeps, when a clear majority of enough of them agree.
 * @param {string[]} names bare stems
 * @returns {{ style: Style, agree: number, total: number } | undefined}
 */
export function convention(names) {
  const styles = names.map(styleOf).filter((s) => s !== undefined);
  /** @type {Style[]} */
  const candidates = ["kebab", "snake", "camel", "Pascal"];
  for (const style of candidates) {
    const agree = styles.filter((s) => fits(s, style)).length;
    const decisive = styles.filter((s) => s === style).length;
    // ponytail: thresholds tuned on a corpus of 22 repositories; make them config if a project needs looser ones
    if (agree >= MIN_AGREE && decisive >= 3 && agree >= SHARE * styles.length) return { style, agree, total: styles.length };
  }
  return undefined;
}

/** @param {string} stem */
const checkable = (stem) => stem !== "" && !SPECIAL.test(stem) && !RESERVED.test(stem);

/**
 * Every folder's children, by kind: files of each kind and the sub-folders, so one pass serves every added name.
 * @param {string[]} files
 * @param {Set<string>} fresh paths the change added, left out so they do not vote for themselves
 */
export function siblingIndex(files, fresh) {
  /** @type {Map<string, string[]>} "dir\0kind" -> names */
  const groups = new Map();
  /** @type {Set<string>} */
  const seenDirs = new Set();
  const add = (/** @type {string} */ key, /** @type {string} */ name) => {
    const list = groups.get(key);
    if (list) list.push(name);
    else groups.set(key, [name]);
  };
  for (const file of files) {
    if (SKIP.test(file)) continue;
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      if (seenDirs.has(dir) || fresh.has(dir)) continue;
      seenDirs.add(dir);
      add(`${segments.slice(0, i - 1).join("/") || "."}\0dir`, segments[i - 1]);
    }
    if (fresh.has(file) || !CODE.test(file)) continue;
    const name = segments[segments.length - 1];
    add(`${posix.dirname(file)}\0${kindOf(name)}`, name);
  }
  return groups;
}

/**
 * Casing and suffix findings for one added file name, against its siblings of the same kind. A file whose main export
 * is a lowercase value (`options.tsx` exporting `petOptions`) is not a component, so a PascalCase folder does not bind it.
 * @param {string} path
 * @param {{ get(key: string): string[] | undefined }} groups
 * @param {{ exports?: string[], subjects?: Set<string> }} [known] the file's export names; every `dir/stem` in the
 *   repository, so a test named after its subject (`captionPreview.test.ts` for `captionPreview.ts`) is left alone
 */
export function checkFileName(path, groups, known = {}) {
  const dir = posix.dirname(path);
  const name = posix.basename(path);
  const { stem, middle, ext } = parts(name);
  if (!checkable(stem) || middle.includes("config")) return [];
  const kind = kindOf(name);
  const own = groups.get(`${dir}\0${kind}`) ?? [];
  /** @type {string[]} */
  const findings = [];
  const rule = convention(own.map((n) => parts(n).stem).filter(checkable));
  const style = styleOf(stem);
  const valueFile = rule?.style === "Pascal" && !!known.exports?.length && !known.exports.some((n) => /^[A-Z][a-z]/.test(n));
  const subject = kind === "test" && [dir, posix.dirname(dir)].some((d) => known.subjects?.has(`${d}/${stem}`));
  // A digit-led word (`p100-1-switcher`) has no unambiguous form in another casing.
  if (rule && !fits(style, rule.style) && !valueFile && !subject && !/(?:^|[-_])\d/.test(stem)) {
    const fixed = [restyle(stem, rule.style), ...middle, ext].filter(Boolean).join(".");
    findings.push(`${path}: this folder names ${kind === "test" ? "tests" : kind === "hook" ? "hooks" : "files"} in ${STYLE_NAME[rule.style]} (${rule.agree} of ${rule.total}): rename to ${fixed}`);
  }
  if (kind !== "test") {
    const suffix = sharedSuffix(own.filter((n) => parts(n).ext === ext));
    if (suffix && !middle.includes(suffix.suffix)) {
      findings.push(`${path}: files in this folder end in .${suffix.suffix}.${ext} (${suffix.agree} of ${suffix.total}): rename to ${stem}.${suffix.suffix}.${ext}`);
    }
  }
  return findings;
}

/** The middle part (`service`) almost every name in the list shares. @param {string[]} names */
function sharedSuffix(names) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const n of names) for (const m of new Set(parts(n).middle)) counts.set(m, (counts.get(m) ?? 0) + 1);
  for (const [suffix, agree] of counts) {
    if (!/^[a-z]+$/.test(suffix) || /^(?:module|stories|story|d|test|spec)$/.test(suffix)) continue;
    if (agree >= MIN_AGREE && agree >= SHARE * names.length) return { suffix, agree, total: names.length };
  }
  return undefined;
}

/**
 * The name a file is about: the default export's name, or its only exported function, class or const. Swift: its only
 * top-level type.
 * @param {string} text
 * @param {string} ext
 */
export function mainExport(text, ext) {
  if (ext === "swift") {
    const types = [...text.matchAll(/^(?:(?:public|internal|private|fileprivate|open|final)\s+)*(?:struct|class|enum|protocol|actor)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
    // A file that also extends other types (`AppEnvironment.swift`: a key plus an EnvironmentValues extension) is about the whole.
    return types.length === 1 && !/^(?:(?:public|private|fileprivate|internal)\s+)?extension\s/m.test(text) ? types[0] : undefined;
  }
  const named = /^export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)|^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(text);
  if (named) return named[1] ?? named[2];
  if (/^export\s+default\b/m.test(text)) return undefined;
  const runtime = [...text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  return runtime.length === 1 ? runtime[0] : undefined;
}

/** The words of a name, lowercased and singular. @param {string} name */
const wordsOf = (name) => restyle(name, "kebab").split("-").map((w) => w.replace(/(?<=[a-z]{2})ies$/, "y").replace(/(?<=ss|x|sh|ch)es$/, "").replace(/(?<=[a-z]{2}[^s])s$/, ""));
const VERB = /^(?:register|create|make|build|get|with|to)$/;
const KIND = /^(?:route|rule|page|sheet|view|screen|component|provider|schema|service|handler|controller|store|extension)$/;

/**
 * Whether a file is named after its export: the same letters (`oauth-consent-form`, `OAuthConsentForm`), or every word
 * of one, leaving out kind words and the export's leading verb, is in the other, in any order: `staff-schedule.routes.ts`
 * exporting `registerStaffTodayScheduleRoutes` and `create.ts` exporting `createDaycareSubscription` both count.
 * @param {string} stem @param {string} name
 */
function namedAfter(stem, name) {
  const [a, b] = [wordsOf(stem), wordsOf(name)];
  if (a.join("").includes(b.join("")) || b.join("").includes(a.join(""))) return true;
  const fileCore = a.filter((w) => !KIND.test(w));
  const exportCore = b.filter((w, i) => !KIND.test(w) && !(i === 0 && VERB.test(w)));
  return fileCore.every((w) => b.includes(w)) || exportCore.every((w) => a.includes(w));
}

/** Every exported name in a JS or TS file. @param {string} text */
export const exportNames = (text) => [...text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);

/**
 * The export-name finding for one added file: reported when the folder's other files are named after their main export.
 * @param {string} path
 * @param {(file: string) => string} read
 * @param {{ get(key: string): string[] | undefined }} groups
 */
export function checkExportName(path, read, groups) {
  const { stem, ext } = parts(posix.basename(path));
  if (!checkable(stem) || !/^(?:[cm]?[jt]sx?|swift)$/.test(ext)) return undefined;
  const name = mainExport(read(path), ext);
  if (!name || name === "default" || namedAfter(stem, name)) return undefined;
  const dir = posix.dirname(path);
  let agree = 0;
  let total = 0;
  for (const sibling of groups.get(`${dir}\0${kindOf(posix.basename(path))}`) ?? []) {
    const p = parts(sibling);
    if (!checkable(p.stem)) continue;
    const theirs = mainExport(read(posix.join(dir, sibling)), p.ext);
    if (!theirs) continue;
    total++;
    if (namedAfter(p.stem, theirs)) agree++;
  }
  if (agree < MIN_AGREE || agree < SHARE * total) return undefined;
  const style = styleOf(stem);
  const fixed = style && style !== "word" ? restyle(name, style) : name;
  return `${path}: its main export is ${name}, and files in this folder are named after theirs (${agree} of ${total}): rename the file to ${posix.basename(path).replace(stem, fixed)}, or the export to match the file`;
}

/**
 * The test-name finding for one added test: `.spec` among `.test` files, or `test_*` among `*_test`.
 * @param {string} path
 * @param {Map<string, string[]>} groups
 */
function checkTestName(path, groups) {
  const mine = testPattern(posix.basename(path));
  if (!mine) return undefined;
  const tests = (groups.get(`${posix.dirname(path)}\0test`) ?? []).map(testPattern);
  for (const pattern of new Set(tests)) {
    const agree = tests.filter((t) => t === pattern).length;
    if (pattern === mine || agree < MIN_AGREE || agree < SHARE * tests.length) continue;
    const fixed = posix.basename(path).replace(/\.(?:test|spec)\./, `${pattern}.`).replace(/^test_(.*?)(\.\w+)$/, pattern === "*_test" ? "$1_test$2" : "test_$1$2").replace(/^(.*?)_test(\.\w+)$/, pattern === "test_*" ? "test_$1$2" : "$1_test$2");
    return `${path}: tests in this folder are named ${pattern === ".test" || pattern === ".spec" ? `*${pattern}.*` : pattern} (${agree} of ${tests.length}): rename to ${fixed}`;
  }
  return undefined;
}

/**
 * Findings for added folders: a folder name whose siblings keep one casing.
 * @param {string[]} dirs
 * @param {Map<string, string[]>} groups
 */
function checkDirs(dirs, groups) {
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  for (const dir of dirs) {
    const name = posix.basename(dir);
    if (!checkable(name) || /\./.test(name)) continue;
    const rule = convention((groups.get(`${posix.dirname(dir)}\0dir`) ?? []).filter(checkable));
    if (rule && !fits(styleOf(name), rule.style)) {
      findings.push({ target: dir, message: `${dir}/: folders beside it are named in ${STYLE_NAME[rule.style]} (${rule.agree} of ${rule.total}): rename to ${restyle(name, rule.style)}` });
    }
  }
  return findings;
}

/** Every folder above a path: `a/b/c.ts` gives `a` and `a/b`. @param {string} path */
const ancestors = (path) => path.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"));

/** A file's text (its first 200 KB), or "" when a tracked file was deleted from the working tree. @param {string} path */
function readText(path) {
  try {
    return readFileSync(path, "utf8").slice(0, 200_000);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" || /** @type {NodeJS.ErrnoException} */ (error).code === "EISDIR") return "";
    throw error;
  }
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function naming({ cwd, base, testPaths }) {
  const sha = resolveBase(cwd, base);
  const top = topLevel(cwd);
  const added = changes(cwd, sha).filter((c) => (c.status === "A" || (c.status === "R" && posix.basename(c.from) !== posix.basename(c.path))) && !SKIP.test(c.path)).map((c) => c.path);
  if (!added.length) return { findings: [], summary: "0 added files checked" };
  const files = listFiles(top);
  const fresh = new Set(added);
  const before = new Set(files.filter((f) => !fresh.has(f)).flatMap(ancestors));
  const newDirs = [...new Set(added.flatMap(ancestors))].filter((d) => !before.has(d) && !SKIP.test(`${d}/`));
  const groups = siblingIndex(files, new Set([...added, ...newDirs]));
  // What a test can be named after: any other file's stem, or a folder (`Table.test.tsx` for `Table/`).
  const subjects = new Set([...files.filter((f) => !testPattern(posix.basename(f))).map((f) => `${posix.dirname(f)}/${parts(posix.basename(f)).stem}`), ...before]);
  /** @type {Map<string, string>} */
  const cache = new Map();
  const read = (/** @type {string} */ file) => {
    if (!cache.has(file)) cache.set(file, readText(join(top, file)));
    return /** @type {string} */ (cache.get(file));
  };
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = checkDirs(newDirs, groups);
  // An added file inside an added folder has no siblings that voted, so only its folder is judged.
  const addedDirs = new Set(newDirs);
  for (const path of added.filter((f) => CODE.test(f) && !addedDirs.has(posix.dirname(f)))) {
    const isTest = matches(path, testPaths) || testPattern(posix.basename(path));
    const exports = /\.[cm]?[jt]sx?$/.test(path) ? exportNames(read(path)) : undefined;
    const messages = [...checkFileName(path, groups, { exports, subjects }), isTest ? checkTestName(path, groups) : checkExportName(path, read, groups)];
    for (const message of messages) if (message) findings.push({ target: path, message });
  }
  return { findings, summary: `${added.length} added files and ${newDirs.length} added folders checked` };
}
