// @ts-check
// Fails when prose names something that is not there: a doc, a rule or a code comment that names a file, folder, npm
// script, CI job or code name the repository does not have. Lines the change added are judged, and so are unchanged
// docs and comments that name what the change deleted, moved or removed. Judging everything, a plan or record
// whose work is over is reported whole. The work is in core/src/references.rs; git history, asked only about the
// paths that did not resolve, tells a deleted file (stale, always reported) from one that never was (reported only
// where the prose asserts it of this repository).
import { spawnSync } from "node:child_process";

import { fromEngine, runCore } from "./core.mjs";
import { EMPTY_TREE, SKIP, addedLines, git, listFiles, parseNameStatus, projectPrefix, projectSpec, resolveBase, showMany, topLevel, withStdin, workingDiff } from "./lib.mjs";

/** Code whose text before the change tells which names the change removed. */
const CODE = /\.(?:[cm]?[jt]sx?|swift|kts?|java|rs|go)$/;

/**
 * One reference the engine found pointing at nothing: how often the file names it, and for a path, the path asked
 * about, whether it is a Markdown link, whether the prose gives it as an example or something to build, and how many
 * paths its file gives.
 * @typedef {{ count: number, path?: string, link?: boolean, soft?: boolean, paths?: number }} Ref
 */

/**
 * A plan or record judged whole: its sort, how many of the paths it names are there, those that are not (for history),
 * and why it says its work is over, if it does.
 * @typedef {{ kind: string, there: number, missing: string[], done: string | null }} Doc
 */

/** What history knows of a path that is not there. @typedef {{ path: string, sha: string, date: string, deleted: boolean }} Was */

/** History's answers: what became of a path, and each file's last commit date. @typedef {{ of: (path: string) => Was | undefined, edited: Map<string, string> }} Past */

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function references({ cwd, base }) {
  const sha = resolveBase(cwd, base);
  const whole = sha === EMPTY_TREE;
  const prefix = projectPrefix(cwd);
  const top = topLevel(cwd);
  // Judging everything, there is no change to read: a diff against the empty tree would be the whole repository.
  const change = whole ? { patch: "", added: {}, gone: {}, base: {} } : readChange(cwd, sha, prefix);
  if (!whole && !change.patch.trim()) return { findings: [], summary: "no changes" };
  const files = filesThere(top);
  const refs = git(top, ["for-each-ref", "--format=%(refname:short)"]).split("\n").filter(Boolean);
  const options = { own: ownFiles(cwd, prefix, files), gone: change.gone, base: change.base, patch: change.patch, refs };
  const answer = runCore({ command: "references", root: top, files, added: whole ? undefined : change.added, prefix, options });
  const found = /** @type {Record<string, Ref>} */ (answer.data?.refs ?? {});
  const docs = /** @type {Record<string, Doc>} */ (answer.data?.docs ?? {});
  const asked = [...new Set([...Object.values(found).flatMap((r) => (r.path === undefined ? [] : [r.path])), ...Object.values(docs).flatMap((d) => d.missing)])];
  const ignored = ignoredPaths(top, asked);
  const shallow = git(top, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const past = history(top, asked.filter((p) => !ignored.has(p)), shallow, files);
  const kept = capped(answer.findings.filter((f) => asserted(found[f.target], ignored, past)), found);
  const findings = kept.map((f) => ({ ...f, message: f.message + whyMissing(found[f.target], past, shallow) }));
  const ended = finishedDocs(docs, ignored, past);
  const count = kept.reduce((n, f) => n + (found[f.target]?.count ?? 1), 0);
  const tail = ended.length ? `, ${ended.length} plans and records whose work looks over` : "";
  return { findings: fromEngine([...findings, ...ended], prefix), summary: `${answer.summary}, ${count} references that point at nothing${tail}` };
}

/**
 * The change, as the engine reads it: its patch, the lines it added, the files it deleted or moved (old path -> new
 * path, empty when deleted), and the text before the change of the code it modified, for the names it removed.
 * @param {string} cwd @param {string} sha @param {string} prefix
 */
function readChange(cwd, sha, prefix) {
  const [patch, status] = workingDiff(cwd, [["-U0", "-M", sha], ["--name-status", "-M", "-z", sha]]);
  const list = parseNameStatus(status);
  const added = Object.fromEntries([...addedLines(patch)].map(([file, lines]) => [prefix + file, [...lines]]));
  const gone = Object.fromEntries(list.filter((c) => c.status === "D" || c.status === "R").map((c) => [prefix + c.from, c.status === "R" ? prefix + c.path : ""]));
  const modified = list.filter((c) => c.status !== "A" && CODE.test(c.from));
  const before = showMany(cwd, sha, modified.map((c) => c.from));
  return { patch, added, gone, base: Object.fromEntries(modified.map((c) => [prefix + c.from, before.get(c.from) ?? ""])) };
}

/**
 * The repository's files that are there. `git ls-files --cached` still lists one removed from the working tree and not
 * staged, so those are taken out.
 * @param {string} top
 */
function filesThere(top) {
  const unstaged = new Set(git(top, ["ls-files", "-z", "--deleted"]).split("\0"));
  return listFiles(top).filter((f) => !unstaged.has(f));
}

/**
 * The project's own files, taken from the repository-wide list: `listFiles(cwd, projectSpec(cwd))` can come back
 * nearly empty in a subfolder (git 2.50 drops tracked files there under the top-anchored node_modules exclude).
 * @param {string} cwd @param {string} prefix @param {string[]} files
 */
function ownFiles(cwd, prefix, files) {
  const marker = ":(exclude,literal)";
  const nested = projectSpec(cwd).filter((s) => s.startsWith(marker)).map((s) => `${prefix}${s.slice(marker.length)}/`);
  return files.filter((f) => f.startsWith(prefix) && !SKIP.test(f) && !nested.some((n) => f.startsWith(n)));
}

/**
 * Whether a finding stands. One that is not a path does. A path git ignores does not. A path history deleted, or a
 * link, does: it is stale or broken. A path history only added does not: it is on another branch, or removed and not
 * committed. A path that never was stands only where the prose asserts it.
 * @param {Ref | undefined} ref @param {Set<string>} ignored @param {Past} past
 */
function asserted(ref, ignored, past) {
  if (ref?.path === undefined) return true;
  if (ignored.has(ref.path)) return false;
  const was = past.of(ref.path);
  return ref.link || was?.deleted || (!was && !ref.soft);
}

/**
 * One finding for a file most of whose paths are stale: a plan or survey named otherwise, or a file about another
 * checkout. Its first stale path stands for the rest, as the engine lets a file whose code names are mostly not this
 * repository's go unjudged.
 * @param {{ file: string, line: number, target: string, message: string }[]} findings @param {Record<string, Ref>} found
 */
function capped(findings, found) {
  /** @type {Map<string, number>} */
  const stale = new Map();
  for (const f of findings) if (found[f.target]?.path !== undefined) stale.set(f.file, (stale.get(f.file) ?? 0) + (found[f.target]?.count ?? 1));
  /** @type {Set<string>} */
  const first = new Set();
  return findings.flatMap((f) => {
    const ref = found[f.target];
    const n = stale.get(f.file) ?? 0;
    const of = ref?.paths ?? 0;
    if (ref?.path === undefined || n <= ref.count || of < 8 || n * 10 <= of * 6) return [f];
    if (first.has(f.file)) return [];
    first.add(f.file);
    return [{ ...f, message: `${f.message} (${n} of the ${of} paths this file gives are not here, this one first)` }];
  });
}

/**
 * How a missing path's message ends: when it was deleted, that it is on another branch or removed and not committed,
 * or that nothing was ever there. A shallow clone cannot say which.
 * @param {Ref | undefined} ref @param {Past} past @param {boolean} shallow
 */
function whyMissing(ref, past, shallow) {
  if (ref?.path === undefined) return "";
  const was = past.of(ref.path);
  if (was?.deleted) return `: ${was.path} was deleted in ${was.sha} (${was.date}); point it at where that lives now, or drop it`;
  if (was) return `: ${was.path} was added in ${was.sha} (${was.date}) and is not in this checkout (removed and not committed yet, or on another branch); point it at where that lives now, or drop it`;
  if (shallow) return ": point it at the real file, or drop it";
  return ": nothing at that path was ever in this repository (a typo, or a path from another project); point it at the real file, or drop it";
}

/**
 * Judging everything, each plan and record judged whole: one that says its work is over, or half or more of whose
 * files (three at least) are gone from the checkout though history had them, is reported once, for someone to delete
 * or archive. What it named was true when it was written; it is the doc itself that may be dead weight.
 * @param {Record<string, Doc>} docs @param {Set<string>} ignored @param {Past} past
 */
function finishedDocs(docs, ignored, past) {
  return Object.entries(docs).flatMap(([file, doc]) => {
    const gone = doc.missing.filter((p) => !ignored.has(p) && past.of(p));
    const named = doc.there + gone.length;
    const first = gone.length >= 3 && gone.length * 2 >= named ? past.of(gone[0]) : undefined;
    const lost = first ? `${gone.length} of the ${named} files and folders it names are gone from this checkout (\`${first.path}\` was ${first.deleted ? "deleted" : "last added"} in ${first.sha}, ${first.date})` : "";
    const why = [doc.done ?? "", lost].filter(Boolean).join("; ");
    if (!why) return [];
    const when = past.edited.has(file) ? `; last edited ${past.edited.get(file)}` : "";
    const message = `${file} is ${doc.kind} whose work looks over: ${why}${when}. If nothing still needs it, delete it (git keeps it) or move it to an archive folder; if it still guides work, update it`;
    return [{ file, line: 1, target: `references:${file}`, message }];
  });
}

/**
 * The paths git ignores: a local file (`.env.local`) or a build's output, which a doc may name and a checkout lacks.
 * Each is asked as a folder too: `/.recovery/` ignores `.recovery/` and not `.recovery`, which git cannot tell is a
 * folder when it is not there.
 * @param {string} top @param {string[]} paths
 */
function ignoredPaths(top, paths) {
  if (!paths.length) return new Set();
  const asked = paths.flatMap((p) => [p, `${p}/`]).join("\n") + "\n";
  const run = withStdin(asked, (fd) => spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: top, stdio: [fd, "pipe", "pipe"], encoding: "utf8" }));
  return new Set(run.stdout.split("\n").filter(Boolean).map((p) => p.replace(/\/$/, "")));
}

/**
 * Every addition and deletion on every branch, newest first, by the last segment of each path and of each folder
 * above it, and each file's last commit date. One walk with no pathspec: a walk limited to many glob pathspecs
 * matches each pattern against every commit, which took minutes on a 4,000-commit repository.
 * @param {string} top
 */
function walkHistory(top) {
  /** @type {Map<string, Map<string, { commit: string, deleted: boolean }>>} last segment -> path or folder -> its latest change */
  const byName = new Map();
  /** @type {Map<string, string>} */
  const edited = new Map();
  const log = spawnSync("git", ["log", "--all", "--no-renames", "--name-status", "--format=@@%h %as"], { cwd: top, encoding: "utf8", maxBuffer: 1 << 30 });
  let commit = "";
  for (const line of (log.stdout ?? "").split("\n")) {
    const tab = line.indexOf("\t");
    if (line.startsWith("@@")) commit = line.slice(2);
    else if (tab > 0) recordChange(byName, edited, commit, line[0], line.slice(tab + 1));
  }
  return { byName, edited };
}

/**
 * One changed file of the walk. The first commit seen for a file is its last edit. A path's first deletion seen is
 * its latest; an addition counts only where no deletion is known.
 * @param {Map<string, Map<string, { commit: string, deleted: boolean }>>} byName @param {Map<string, string>} edited
 * @param {string} commit `<sha> <date>` @param {string} status @param {string} file
 */
function recordChange(byName, edited, commit, status, file) {
  if (!edited.has(file)) edited.set(file, commit.slice(commit.indexOf(" ") + 1));
  if (status !== "D" && status !== "A") return;
  const deleted = status === "D";
  const parts = file.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join("/");
    const seen = byName.get(parts[i - 1]) ?? new Map();
    const had = seen.get(at);
    if (!had || (deleted && !had.deleted)) seen.set(at, { commit, deleted });
    byName.set(parts[i - 1], seen);
  }
}

/**
 * What history knows of each missing path: when it was deleted, else when it was added (it is on another branch, or
 * removed in the working tree and not committed yet), else undefined: nothing at it ever was. A longer path that ends
 * in it matches too, the closest first, and one cut short at a space (`App/src/x.js` for `Mobile App/src/x.js`); a
 * file name alone only when history had one file of that name (`client.ts` could be any). A path that is there now is
 * not what the prose meant. A shallow clone has no history to tell, so every path reads as never there: only what
 * the prose asserts is reported.
 * @param {string} top @param {string[]} paths @param {boolean} shallow @param {string[]} files @returns {Past}
 */
function history(top, paths, shallow, files) {
  if (!paths.length || shallow) return { of: () => undefined, edited: new Map() };
  const here = new Set(files.flatMap((f) => f.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const { byName, edited } = walkHistory(top);
  /** @type {Map<string, Was | undefined>} */
  const known = new Map();
  /** @param {string} path */
  const of = (path) => {
    if (known.has(path)) return known.get(path);
    const seen = byName.get(path.split("/").pop() ?? "") ?? new Map();
    const others = [...seen.keys()].filter((p) => !here.has(p));
    const ends = others.filter((p) => p === path || p.endsWith(`/${path}`) || p.endsWith(` ${path}`)).sort((a, b) => a.length - b.length);
    const matches = path.includes("/") || ends.length === 1 ? ends : ends.filter((p) => p === path);
    const hit = matches.find((p) => seen.get(p)?.deleted) ?? matches[0];
    const change = seen.get(hit);
    const [sha, date] = change ? change.commit.split(" ") : [];
    const answer = change ? { path: hit, sha, date, deleted: change.deleted } : undefined;
    known.set(path, answer);
    return answer;
  };
  return { of, edited };
}
