// @ts-check
// Fails when the change leaves code nothing uses: an added file nothing references, an added export nothing uses, or
// a file whose last import the change removed. Text only: a file is referenced when another file names its stem.
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { listFiles, matches, parseNameStatus, resolveBase, topLevel, workingDiff } from "./lib.mjs";

// ponytail: Go and Swift link every file of a package or module without naming it, so they are not checked; a
// per-language symbol table if that matters
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rb|rs|kts?|java|cs|php|vue|svelte|astro|css|scss)$/;
const JS = /\.[cm]?[jt]sx?$/;
// Files whose references count. In these, only quoted text names a file (imports are strings); elsewhere any word.
const CORPUS = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|astro|scala|sh|sql|css|scss|html|json|jsonc|json5|ya?ml|toml)$|(?:^|\/)(?:Dockerfile|Makefile|Procfile)$/;
// ponytail: a file counts as referenced when any other file quotes its stem, so a generic stem (`utils`, `types`) is
// always referenced and never reported; resolve each import to a path if those misses matter
const QUOTED_ONLY = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss)$/;
const SKIP = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__)\/|\.min\.|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const MAX_BYTES = 1024 * 1024;
// Loaded by convention, never imported: folders that route by file name, entry names, dotfiles, configs, types,
// tests and fixtures, and components/ui, where kits like shadcn/ui add whole components at once.
const CONVENTION_DIR = /(?:^|\/)(?:components\/ui|\.[^/]+|routes|pages|app|api|migrations|scripts|bin|public|skills|templates|functions|convex|fixtures|__fixtures__|__mocks__|tests?|__tests__|e2e)\//;
const CONVENTION_NAME = /^(?:main|server|worker|cli|middleware|instrumentation|instrumentation-client|mdx-components|__main__|conftest|manage|setup)$|^\.|\.(?:config|d|stories|typetest|bench)$|^test_|_test$/;
const TOKEN = /[\w$][\w$.-]*/g;
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const EXPORT_DECL = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|type|interface|enum|const\s+enum|namespace)\s+([\w$]+)/;
// ponytail: one-line `export { a, b }` only; a multi-line list or `export const { a } =` is not seen, a tokenizer if it matters
const EXPORT_LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*;?\s*$/;
// Relative specifiers, and the common source-root aliases (`@/x`, `~/x`, `#/x`).
const LOCAL_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']((?:\.\.?|[@~#])\/[^"']*)["']/g;
const RESOLVE = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".css", ".scss", ".json"];

const noExt = (/** @type {string} */ path) => path.replace(/(?<=[^/])\.[^./]+$/, "");
/** The name other files use for `path`: its name without extension, or its folder's name for an index. */
const stem = (/** @type {string} */ path) => {
  const name = noExt(posix.basename(path));
  return /^(?:index|__init__)$/.test(name) ? posix.basename(posix.dirname(path)) : name;
};

/**
 * Every word in `text`, plus the parts of dotted and dashed words, so `./user-card.js` yields `user-card` and
 * `app.utils.format` yields `format`.
 * @param {string} text
 * @param {(word: string) => void} see
 */
function words(text, see) {
  for (const token of text.match(TOKEN) ?? []) {
    see(token);
    if (!/[.-]/.test(token)) continue;
    const dotted = token.split(".");
    for (let i = 1; i < dotted.length; i++) see(dotted.slice(0, i).join("."));
    for (const part of token.split(/[.-]/)) see(part);
  }
}

/**
 * Paths named in any package.json (main, module, types, bin, exports, scripts), without extension, and the folders of
 * published packages (not private, with exports, module, files or publishConfig), whose exports are for outside consumers.
 * @param {string} top
 * @param {string[]} files
 */
function packageEntries(top, files) {
  /** @type {Set<string>} */
  const named = new Set();
  /** @type {string[]} */
  const published = [];
  /** @type {(v: unknown) => string[]} */
  const strings = (v) => (typeof v === "string" ? v.split(/\s+/) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  for (const file of files) {
    if (posix.basename(file) !== "package.json" || SKIP.test(file)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(top, file), "utf8"));
    } catch (error) {
      // An unreadable or invalid package.json names no entries; new-deps reports invalid JSON.
      if (!(error instanceof SyntaxError) && /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      continue;
    }
    const dir = posix.dirname(file);
    for (const s of strings([pkg.main, pkg.module, pkg.types, pkg.bin, pkg.exports, pkg.scripts])) named.add(noExt(posix.join(dir, s)));
    // `main` alone is what npm init writes, so it does not mark a package as published.
    if (!pkg.private && (pkg.exports || pkg.module || pkg.files || pkg.publishConfig)) published.push(dir === "." ? "" : `${dir}/`);
  }
  return { named, published };
}

/**
 * Added and removed lines of a `-U0` patch: added by new path and line number, removed by old path.
 * @param {string} patch
 */
function patchLines(patch) {
  /** @type {Map<string, string[]>} */ const added = new Map();
  /** @type {Map<string, string[]>} */ const removed = new Map();
  let header = false;
  /** @type {string[] | undefined} */ let plus;
  /** @type {string[] | undefined} */ let minus;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) header = true;
    else if (line.startsWith("@@")) header = false;
    // ponytail: paths with spaces or quotes come quoted by git and are not unquoted, use -z output if that matters
    else if (header && line.startsWith("--- ")) minus = line === "--- /dev/null" ? undefined : removed.set(line.slice(6), []).get(line.slice(6));
    else if (header && line.startsWith("+++ ")) plus = line === "+++ /dev/null" ? undefined : added.set(line.slice(6), []).get(line.slice(6));
    else if (!header && line.startsWith("+")) plus?.push(line.slice(1));
    else if (!header && line.startsWith("-")) minus?.push(line.slice(1));
  }
  return { added, removed };
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function unused({ cwd, base, testPaths, entryPaths }) {
  const sha = resolveBase(cwd, base);
  const top = topLevel(cwd);
  const [status, patch] = workingDiff(cwd, [["--name-status", "-M", "-z", sha], ["-U0", "-M", sha]]);
  const changed = parseNameStatus(status);
  const { added, removed } = patchLines(patch);
  const all = listFiles(top).filter((f) => statSync(join(top, f), { throwIfNoEntry: false })?.isFile());
  const exists = new Set(all);
  const { named, published } = packageEntries(top, all);
  const conventional = (/** @type {string} */ f) =>
    matches(f, testPaths) || matches(f, entryPaths) || CONVENTION_DIR.test(f) || CONVENTION_NAME.test(noExt(posix.basename(f))) || named.has(noExt(f)) || SKIP.test(f);
  const fresh = new Set(changed.filter((c) => c.status === "A").map((c) => c.path));

  // 1. Added source files.
  const newFiles = [...fresh].filter((f) => SOURCE.test(f) && !conventional(f) && stem(f) !== ".");

  // 2. Added exports in files that are not loaded by convention.
  /** @type {{ file: string, name: string }[]} */
  const exports = [];
  for (const [file, lines] of added) {
    if (!JS.test(file) || !exists.has(file) || conventional(file) || published.some((dir) => file.startsWith(dir))) continue;
    for (const line of lines) {
      const decl = EXPORT_DECL.exec(line)?.[1];
      const list = decl ? [decl] : (EXPORT_LIST.exec(line)?.[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop() ?? "") ?? []);
      for (const name of list) if (/^[\w$]+$/.test(name) && name !== "default") exports.push({ file, name });
    }
  }

  // 3. Files that lost a local import and existed before the change.
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  for (const f of all) {
    const list = byName.get(posix.basename(f));
    if (list) list.push(f);
    else byName.set(posix.basename(f), [f]);
  }
  /** @type {Set<string>} */
  const orphans = new Set();
  for (const [from, lines] of removed) {
    if (!JS.test(from)) continue;
    for (const line of lines) {
      for (const [, spec] of line.matchAll(LOCAL_IMPORT)) {
        // ponytail: an alias is resolved as the one file whose path ends with the rest of the specifier, not through
        // tsconfig paths; read compilerOptions.paths if two source roots share file names
        const alias = /^[@~#]\//.test(spec);
        const path = alias ? spec.slice(2) : posix.normalize(posix.join(posix.dirname(from), spec));
        const bare = path.replace(/\.[cm]?js$/, "");
        const names = [...RESOLVE.map((ext) => path + ext), ...RESOLVE.slice(1).map((ext) => bare + ext), ...RESOLVE.slice(1).map((ext) => `${path}/index${ext}`)];
        const found = alias ? [...new Set(names.flatMap((n) => (byName.get(posix.basename(n)) ?? []).filter((f) => f.endsWith(`/${n}`))))] : names.filter((p) => exists.has(p));
        const target = found.length === 1 || !alias ? found[0] : undefined;
        if (target && !fresh.has(target) && SOURCE.test(target) && !conventional(target)) orphans.add(target);
      }
    }
  }

  // One pass over the repository records which files mention each stem and each export name.
  const stems = new Set([...newFiles, ...orphans].map(stem));
  const names = new Set(exports.map((e) => e.name));
  const exporting = new Set(exports.map((e) => e.file));
  /** @type {Map<string, Set<string>>} */ const pathHits = new Map();
  /** @type {Map<string, Set<string>>} */ const wordHits = new Map();
  const hit = (/** @type {Map<string, Set<string>>} */ map, /** @type {string} */ word, /** @type {string} */ file) => {
    const set = map.get(word);
    if (set) set.add(file);
    else map.set(word, new Set([file]));
  };
  /** @type {Map<string, string>} */
  const texts = new Map();
  let scanned = 0;
  if (stems.size || names.size) {
    for (const file of all) {
      if (!CORPUS.test(file) || SKIP.test(file)) continue;
      const text = readFileSync(join(top, file), "utf8");
      if (text.length > MAX_BYTES || text.includes("\0")) continue;
      scanned++;
      if (names.size) {
        words(text, (w) => names.has(w) && hit(wordHits, w, file));
        if (exporting.has(file)) texts.set(file, text);
      }
      if (!stems.size) continue;
      if (QUOTED_ONLY.test(file)) for (const [, , inner] of text.matchAll(QUOTED)) words(inner, (w) => stems.has(w) && hit(pathHits, w, file));
      else words(text, (w) => stems.has(w) && hit(pathHits, w, file));
    }
  }
  const referenced = (/** @type {string} */ file) => [...(pathHits.get(stem(file)) ?? [])].some((f) => f !== file);

  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  const unreferenced = new Set(newFiles.filter((f) => !referenced(f)));
  for (const file of unreferenced) {
    findings.push({ target: file, message: `${file} is added but no other file imports or names it: wire it in, or delete it` });
  }
  for (const { file, name } of exports) {
    if (unreferenced.has(file) || [...(wordHits.get(name) ?? [])].some((f) => f !== file)) continue;
    // Uses inside the file are the name's occurrences beyond its declarations and export list entries. Raw text, not
    // stripCode: a use inside a template literal's ${} is still a use, and a mention in a comment errs towards quiet.
    const lines = (texts.get(file) ?? "").split("\n");
    const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    let expected = 0;
    let seen = 0;
    for (const line of lines) {
      seen += line.match(word)?.length ?? 0;
      if (EXPORT_DECL.exec(line)?.[1] === name) expected++;
      else if (EXPORT_LIST.test(line) && word.test(line)) expected += 2;
      word.lastIndex = 0;
    }
    if (seen <= expected) findings.push({ target: `${file}:${name}`, message: `${file}: export ${name} is used nowhere: delete it` });
  }
  for (const file of orphans) {
    if (!referenced(file)) findings.push({ target: file, message: `${file} is no longer imported by anything after this change: delete it` });
  }
  const summary = `${newFiles.length} added files, ${exports.length} added exports and ${orphans.size} removed imports checked against ${scanned} files`;
  return { findings, summary };
}
