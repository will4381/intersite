// @ts-check
// Fails when the change adds a leftover file: a backup or versioned copy, a scratch script, a log or dump, or an
// agent's working note. Only files the change added count; anything that existed on base is the project's business.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { changes, git, listFiles, matches, projectSpec, resolveBase, show } from "./lib.mjs";

const BACKUP_EXT = /\.(?:bak|orig|rej|tmp|swp)$|~$/;
// A copy's name: the plain name plus a suffix. Reported only when a file with the plain name exists or existed and
// shares most of its lines, so `api-v2.ts` with no `api.ts`, or `campaign-copy.ts` (marketing copy) beside an
// unrelated `campaign.ts`, is a real file.
const COPY = /^(.+?)(?:[._ -](?:old|backup|bak|copy|orig|new|final|fixed|v\d+)| copy(?: \d+)?| \(\d+\))$/i;
// ponytail: scratch names and output dumps count only at the project's top, so one at the root of a package inside
// the project is missed; treat every folder holding a package.json as a root if that matters
const SCRATCH = /^(?:scratch|(?:tmp|temp|debug|try)(?![a-z]))|^test-.*\.(?:[cm]?[jt]s|py|sh)$/i;
const SCRATCH_DIR = /(?:^|\/)(?:tmp|temp|scratch)\//;
const LOG = /\.(?:log|dump)$/;
const ROOT_OUTPUT = /^(?:output.*\.txt|out\.json|response.*\.json)$/i;
const NOTE = /^(?:plan|summary|notes|todo|analysis|findings|report|changes|migration[_-]guide|(?:implementation|refactor)[\w-]*|fix(?:es)?(?![a-z])[\w-]*|[\w-]+[_-](?:summary|plan|report))\.(?:md|markdown)$/i;
const DOC_DIR = /^(?:docs?|documentation|wiki|adrs?|rfcs?|notes|specs?)$/i;

const noExt = (/** @type {string} */ path) => path.replace(/(?<=[^/])\.[^./]+$/, "");
const lines = (/** @type {string} */ text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Whether most of `text`, by characters of its non-blank lines, appears line for line in one of `originals`, so shared
 * boilerplate (an XML header, imports) does not make two different files copies. An empty file counts as a copy.
 * @param {string} text
 * @param {string[]} originals
 */
function copies(text, originals) {
  // ponytail: binary files are never called copies, compare bytes if copied images matter
  if (text.includes("\0")) return false;
  const mine = lines(text);
  const size = (/** @type {string[]} */ list) => list.reduce((n, l) => n + l.length, 0);
  return originals.some((o) => {
    const theirs = new Set(lines(o));
    return theirs.size > 0 && size(mine.filter((l) => theirs.has(l))) * 2 >= size(mine);
  });
}

/**
 * @param {import("./lib.mjs").GateOptions} options
 * @returns {Promise<import("./lib.mjs").GateResult>}
 */
export async function artifacts({ cwd, base, testPaths, artifacts: extra }) {
  const sha = resolveBase(cwd, base);
  const spec = projectSpec(cwd);
  const added = changes(cwd, sha, spec).filter((c) => c.status === "A" || c.status === "R" || c.status === "C");
  /** @type {import("./lib.mjs").Finding[]} */
  const findings = [];
  if (!added.length) return { findings, summary: "0 added files checked" };

  // Run from the project folder, ls-tree lists only that folder, relative to it.
  const was = git(cwd, ["ls-tree", "-r", "-z", "--name-only", sha]).split("\0").filter(Boolean);
  const now = listFiles(cwd, spec);
  const current = new Set(now);
  const existed = new Set(was);
  /** @type {Map<string, string>} plain path without extension to a file with that name, now or on base */
  const plainNames = new Map([...was, ...now].map((f) => [noExt(f), f]));
  const docs = was.map((f) => f.split("/")).find((parts) => parts.length > 1 && DOC_DIR.test(parts[0]))?.[0];

  for (const { path } of added) {
    const dir = posix.dirname(path);
    const name = posix.basename(path);
    const plain = COPY.exec(noExt(name))?.[1];
    const same = plain === undefined ? undefined : posix.join(dir, plain + posix.extname(name));
    const sibling = same && (current.has(same) || existed.has(same) ? same : plainNames.get(posix.join(dir, /** @type {string} */ (plain))));
    const copy = () => {
      if (sibling === undefined) return false;
      const original = current.has(sibling) ? readFileSync(join(cwd, sibling), "utf8") : "";
      // Code split out of a file and imported back by it is a new module, not a copy.
      return !original.includes(noExt(name)) && copies(readFileSync(join(cwd, path), "utf8"), [original, show(cwd, sha, sibling)]);
    };
    // ponytail: any folder named like docs counts, even one the change created, because projects keep plans there
    // on purpose; require it on base if agents start hiding notes in new docs folders
    const inDocs = path.split("/").slice(0, -1).some((seg) => DOC_DIR.test(seg));
    let message;
    if (BACKUP_EXT.test(name)) message = `${path} is a backup file: delete it, git keeps the history`;
    else if (!inDocs && copy()) message = `${path} is a copy of ${sibling}: delete it, git keeps the history`;
    else if (name !== ".gitkeep" && SCRATCH_DIR.test(path)) message = `${path} is in a scratch folder: delete it, or move it where the project keeps real code`;
    else if ((LOG.test(name) && !inDocs && !matches(path, testPaths)) || (dir === "." && ROOT_OUTPUT.test(name))) message = `${path} is a log or output dump: delete it`;
    else if (dir === "." && SCRATCH.test(name)) message = `${path} is a scratch or debug file: delete it, or turn it into a real script or test`;
    else if (NOTE.test(name) && !inDocs) message = `${path} looks like a working note: delete it, or move what should last into ${docs ? `${docs}/` : "the README"}`;
    else if (matches(path, extra)) message = `${path} matches gates.artifacts: delete it`;
    if (message) findings.push({ target: path, message });
  }
  return { findings, summary: `${added.length} added files checked` };
}
