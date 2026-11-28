//! References in prose that point at nothing: a doc, a rule or a code comment that names a file, folder, npm script,
//! CI job or code name the repository does not have. Prose goes stale where no compiler looks: a file is deleted or
//! moved, a script renamed, a function removed, and the sentence that sent people there stays; an agent writes a path
//! from memory, or from another project. After Tan, Wagner and Treude ("Detecting outdated code element references in
//! software repository documentation", Empirical Software Engineering, 2024), each reference is resolved against the
//! repository's files, scripts, workflows and code, and only what does not resolve is reported. Git history, which
//! the Node side asks only about those paths, tells a deleted file from one that never was.
//!
//! Judging a change, the lines it added are checked, and so are unchanged docs and comments that name a file the
//! change deleted or moved, or a name it removed from the code. Judging everything, every reference in the project's
//! prose is checked except in records of the past (changelogs, dated notes, decision records, audits, logs,
//! archives); those and plans are judged whole instead: one that says its work is over, or most of whose files are
//! gone, is reported once, for someone to delete or archive.
//!
//! What is checked is what can be checked without guessing. A link resolves or it does not. A path that history
//! knows (deleted, moved, on another branch) is stale and always reported. A path that was never here is reported
//! only where the prose asserts it of this repository: in an agent's standing instructions, or from a folder a
//! reader would look in when it names a doc or a file whose name is elsewhere; not as an example or something to
//! build, and not a code path with no namesake, which is another checkout's far more often than a slip. A code name
//! has no history that is cheap to ask. Judging a change, a name is reported only when the change removed it from
//! the code. Judging everything, a missing name is listed when it is shaped like the repository's own code, camelCase
//! or PascalCase of two words or more: snake case, capitals and acronym-led names are as often columns, settings
//! and other systems' names.

use rayon::prelude::*;
use regex::Regex;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use crate::text::{self, Lines};
use crate::{first_per_key, Answer, Finding, Request};

/// What a reference names, which decides what it is checked against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// A file or folder in code font or a command, or a bare path with a known extension (`core/src/main.rs`).
    Path,
    /// A Markdown link's target, with an optional `#anchor`.
    Link,
    /// A code name in code font, such as a function, a type or a member.
    Name,
    /// An npm script a command runs.
    Script,
    /// A CI job, step or workflow, where the sentence calls it one.
    Job,
}

/// One reference in prose: where it starts (a byte offset in its file), what it says, and what kind it is.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Mention {
    at: usize,
    text: String,
    kind: Kind,
}

// ---------------------------------------------------------------------------------------------------------------
// Which files hold prose, and which hold what prose is checked against.

/// Whether `word` is in a list written as one string, its words a space apart.
fn among(list: &str, word: &str) -> bool {
    list.split(' ').any(|w| w == word)
}

/// The extension of a file's name, lowercase; "" for none.
fn ext(file: &str) -> String {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.rsplit_once('.').map_or(String::new(), |(stem, e)| if stem.is_empty() { String::new() } else { e.to_ascii_lowercase() })
}

fn is_prose(file: &str) -> bool {
    matches!(ext(file).as_str(), "md" | "mdx" | "mdc" | "markdown" | "txt" | "rst" | "adoc")
}

/// Code whose comments are `//` and `/* */` and whose strings are quoted: what text::code_spans reads.
const C_LIKE: [&str; 29] = [
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "swift", "kt", "kts", "java", "rs", "go", "c", "h", "cc", "cpp", "hpp", "cs",
    "scala", "dart", "php", "prisma", "css", "scss", "less", "gradle", "groovy",
];
/// Code and config whose comments start with `#`.
const HASH_LIKE: [&str; 13] = ["py", "rb", "sh", "bash", "zsh", "yml", "yaml", "toml", "r", "pl", "cfg", "ini", "conf"];
/// Data and markup: read for what the code contains, its comments not checked.
const DATA: [&str; 13] = ["json", "jsonc", "sql", "graphql", "gql", "xml", "html", "htm", "vue", "svelte", "astro", "plist", "properties"];
/// Other code and templates, read whole for the names they contain: a doc may name what only they define.
const OTHER_CODE: [&str; 18] =
    ["xs", "liquid", "ejs", "hbs", "erb", "pug", "njk", "twig", "mustache", "tf", "hcl", "proto", "lua", "ex", "exs", "m", "mm", "csv"];

fn is_c_like(file: &str) -> bool {
    C_LIKE.contains(&ext(file).as_str())
}

fn is_hash_like(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    HASH_LIKE.contains(&ext(file).as_str())
        || matches!(name, "Dockerfile" | "Makefile" | "Procfile" | "Gemfile" | "Rakefile")
        || name.starts_with(".env")
}

fn is_data(file: &str) -> bool {
    DATA.contains(&ext(file).as_str())
}

fn is_other_code(file: &str) -> bool {
    OTHER_CODE.contains(&ext(file).as_str())
}

/// Standing instructions an agent reads as true of this repository: what they name is meant to be here.
fn is_instructions(file: &str) -> bool {
    matches!(file.rsplit('/').next().unwrap_or(file), "CLAUDE.md" | "AGENTS.md" | "GEMINI.md" | "copilot-instructions.md")
        || [".cursor/rules/", ".claude/rules/", ".github/instructions/"].iter().any(|d| file.contains(d))
}

/// A test file, or a file in a test folder.
fn is_test(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.contains(".test.")
        || name.contains(".spec.")
        || file.split('/').any(|s| matches!(s, "test" | "tests" | "__tests__" | "e2e" | "spec"))
}

/// Fixtures and snapshots: text kept wrong on purpose, as a tool's test input.
static FIXTURE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|/)(?:__)?(?:test[-_])?fixtures?(?:__)?/|(?:^|/)(?:testdata|__snapshots__)/").unwrap());

/// What a build or a test run writes: what it names is the run's, not the repository's.
const BUILT: &str =
    "test-results playwright-report blob-report storybook-static .next .nuxt .svelte-kit .turbo .expo target DerivedData Pods";

fn is_built(file: &str) -> bool {
    file.split('/').any(|s| among(BUILT, s))
}

/// A date in a path, to the day or the month: `2026-09-04`, `20260904`, `2026-09`.
static DATED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[^0-9])(?:19|20)\d\d(?:[-_]?[01]\d[-_]?[0-3]\d|[-_](?:0[1-9]|1[0-2]))(?:[^0-9]|$)").unwrap());

// ponytail: a record or a plan is known by the words of its path; one named otherwise is judged line by line, and
// one of these that is kept current is not. A config key listing them, if projects need it.
/// Folders that hold records of the past.
const RECORD_FOLDERS: &str = "archive archived archives history changelog changelogs audit audits report reports completion-reports evidence postmortem postmortems incidents retros minutes decisions adr adrs execution executions logs handoffs sessions transcripts notes journal";
/// Words in a doc's name that make it a record of the past.
const RECORD_WORDS: &str =
    "changelog changes history news releases audit audits report postmortem retro retrospective handoff minutes ledger log notes findings";
/// Words in a doc's path that make it a plan.
const PLAN_WORDS: &str = "plan plans spec specs proposal proposals rfc rfcs roadmap draft drafts brainstorm phase phases milestone milestones backlog todo todos wishlist ideas scope future wip";

/// The words of a path, lowercase: its folders and the parts of its file name.
fn path_words(file: &str) -> Vec<String> {
    file.to_ascii_lowercase().split(['/', '.', '-', '_', ' ']).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// Prose that records the past on purpose: a changelog, a dated note, a decision record, an audit, a log, an
/// archive. What it names may be gone; that is what it is about. Code is a record only when dated (a one-off script)
/// or archived: a module may well be called `audit` or `log`.
fn is_record(file: &str) -> bool {
    if DATED.is_match(file) || file.split('/').any(|s| matches!(s.to_ascii_lowercase().as_str(), "archive" | "archived" | "archives")) {
        return true;
    }
    if !is_prose(file) {
        return false;
    }
    let (dirs, name) = file.rsplit_once('/').unwrap_or(("", file));
    let words = path_words(name.rsplit_once('.').map_or(name, |(stem, _)| stem));
    let has = |w: &str| words.iter().any(|x| x == w);
    RECORD_WORDS.split(' ').any(has)
        || (has("release") && has("notes"))
        || dirs.split('/').any(|s| among(RECORD_FOLDERS, &s.to_ascii_lowercase()))
}

/// Prose about what is to be built: a plan, a spec, a proposal, a phase, a backlog. It names code that does not exist
/// yet, or was built under other names; its code names, paths and scripts are not judged.
fn is_plan(file: &str) -> bool {
    is_prose(file) && path_words(file).iter().any(|w| among(PLAN_WORDS, w))
}

/// A plan, survey or dated report named otherwise, known by its first lines: a title with a plan's word (`# Layout
/// move: mapping and move plan`, `# API: target surface`) or a date (`# Browser QA (2026-11-25)`), or `Prepared <date>`
/// under it.
fn planned(src: &str) -> bool {
    src.lines().filter(|l| !l.trim().is_empty()).take(4).any(|l| {
        let t = l.trim_start_matches(['#', '>', '*', '_', ' ']);
        t.starts_with("Prepared ")
            || (l.starts_with('#')
                && (DATED.is_match(t)
                    || t.to_ascii_lowercase()
                        .split(|c: char| !c.is_alphanumeric())
                        .any(|w| among(PLAN_WORDS, w) || among("mapping survey target", w))))
    })
}

/// A record kept on purpose however much of it is gone: a changelog, release notes, or an archive.
fn kept_on_purpose(file: &str) -> bool {
    let words = path_words(file);
    let has = |w: &str| words.iter().any(|x| x == w);
    ["changelog", "changelogs", "changes", "history", "news", "releases", "archive", "archived", "archives"].iter().any(|w| has(w))
        || (has("release") && has("notes"))
}

/// What sort of plan or record a file is, for its finding; `plan` when its first lines say it is one.
fn record_kind(file: &str, plan: bool) -> &'static str {
    const REPORTS: &str = "audit audits report reports findings postmortem postmortems retro retros retrospective evidence incidents";
    const LOGS: &str = "log logs ledger execution executions sessions transcripts handoff handoffs journal minutes notes";
    let words = path_words(file);
    let has = |list: &str| words.iter().any(|w| among(list, w));
    if has("decisions decision adr adrs") {
        "a decision record"
    } else if plan || is_plan(file) {
        "a plan"
    } else if has(REPORTS) {
        "an audit or report"
    } else if has(LOGS) {
        "a log or notes"
    } else {
        "a dated note"
    }
}

/// A status line near the top of a doc, or in its front matter: `Status: Shipped`, `| Status | Superseded |`.
static STATUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?im)^[\s>*_|-]*status\**\s*[:=|-]\s*[\s*_`]*([a-z]+)([^\n]*)").unwrap());
/// A status that qualifies itself: "implemented; not deployed", "complete except the backfill".
static UNFINISHED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:not|pending|partial|partially|in progress|wip|blocked|draft|awaiting|until|except|but)\b").unwrap()
});
/// A doc marked superseded at the start of a line (`> Superseded by ADR 12`), not a sentence that mentions it.
static SUPERSEDED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?im)^[\s>*_|#-]*superseded by\b").unwrap());
static CHECKBOX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]").unwrap());

/// Why a plan or record says its work is over, if it does: a status that says so, or every checkbox ticked. A
/// decision record in force (`Accepted`, `Implemented`) still guides the code; only one superseded or dropped is over.
fn finished(file: &str, src: &str) -> Option<String> {
    let head: String = src.lines().take(40).collect::<Vec<_>>().join("\n");
    let decision = record_kind(file, false) == "a decision record";
    for cap in STATUS.captures_iter(&head) {
        let status = cap[1].to_ascii_lowercase();
        let over = matches!(
            status.as_str(),
            "superseded" | "deprecated" | "abandoned" | "obsolete" | "rejected" | "withdrawn" | "replaced" | "archived"
        ) || (!decision
            && matches!(
                status.as_str(),
                "done" | "complete" | "completed" | "shipped" | "merged" | "implemented" | "released" | "closed" | "finished"
            ));
        if over && !UNFINISHED.is_match(&cap[2]) {
            return Some(format!("its status is {status}"));
        }
    }
    if SUPERSEDED.is_match(&head) {
        return Some("it says it is superseded".to_string());
    }
    let (mut open, mut ticked, mut fence) = (0, 0, false);
    for line in src.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
        } else if let Some(cap) = CHECKBOX.captures(line).filter(|_| !fence) {
            if &cap[1] == " " {
                open += 1;
            } else {
                ticked += 1;
            }
        }
    }
    (ticked >= 3 && open == 0).then(|| format!("all {ticked} of its checkboxes are ticked"))
}

// ---------------------------------------------------------------------------------------------------------------
// Finding references in prose.

/// Extensions that make a bare word a file name: `config.ts`, `README.md`.
const EXTS: [&str; 47] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "md", "mdx", "mdc", "yml", "yaml", "toml", "sql", "prisma",
    "sh", "bash", "zsh", "py", "rb", "go", "rs", "swift", "kt", "kts", "java", "gradle", "css", "scss", "html", "vue", "svelte", "astro",
    "graphql", "txt", "xml", "plist", "png", "jpg", "jpeg", "svg", "pdf", "lock", "csv",
];

static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)"#).unwrap());
static LINK_DEF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?").unwrap());
static BARE: LazyLock<Regex> = LazyLock::new(|| {
    let exts = EXTS.join("|");
    Regex::new(&format!(
        r#"(?:^|[\s(\[,;"'=])((?:\.{{1,2}}/)?[\w@+.-]+(?:/[\w@+.\[\]-]+)+\.(?:{exts}))(?::\d+(?:-\d+)?)?(?:[\s).,;:"'\]]|$)"#
    ))
    .unwrap()
});
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$]*)*(?:\([^)]{0,60}\))?$").unwrap());
static JOB_AFTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:job|jobs|step|steps|workflow|workflows)\b").unwrap());
static JOB_BEFORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(?:job|step|workflow)\s*$").unwrap());
/// A sentence about CI: "job", "step" and "workflow" are also everyday words of the product's own domain.
static CI_CONTEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\b(?:ci|github|pipeline|pr checks|pr-checks|workflow file)\b|\.ya?ml\b").unwrap());
/// An endpoint written like a path: `GET service_areas/geo_json`.
static ROUTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s").unwrap());
/// A sentence that gives a name as an example or a counter-example, or says it is not there.
static EXAMPLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(?:e\.g|for example|such as|i\.e|vs|versus|not|never|avoid|instead of|rather than|like|no|without|bad|wrong|don't|isn't)\b").unwrap()
});
static TAG_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{@link(?:code|plain)?\s+([^}\s|]+)").unwrap());
static SEE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@see\s+([^\s,;]+)").unwrap());
static RUN_IN_STRING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.@/-]+)").unwrap());
/// A setting left commented out in a config file: `# signing_keys_path = "./signing_keys.json"`.
static SETTING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[A-Za-z_][\w.-]*\s*=\s*\S").unwrap());
/// The folder a command line enters before what follows: `cd backend && npm run dev`.
static CD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bcd\s+([\w@+./-]+)").unwrap());
static ENV_ASSIGN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());

/// The same text with every byte but newlines turned into a space, so offsets stay put.
fn blank(s: &str) -> String {
    s.bytes().map(|b| if b == b'\n' { '\n' } else { ' ' }).collect()
}

/// A Markdown line with its HTML comments blanked; `inside` carries a comment that spans lines.
fn hide_html_comments(line: &str, inside: &mut bool) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    loop {
        if *inside {
            let Some(end) = rest.find("-->") else {
                out.push_str(&blank(rest));
                return out;
            };
            out.push_str(&blank(&rest[..end + 3]));
            rest = &rest[end + 3..];
            *inside = false;
        } else {
            let Some(start) = rest.find("<!--") else {
                out.push_str(rest);
                return out;
            };
            out.push_str(&rest[..start]);
            out.push_str("    ");
            rest = &rest[start + 4..];
            *inside = true;
        }
    }
}

/// Words of a line with their offsets.
fn words(line: &str) -> Vec<(usize, &str)> {
    line.split_whitespace().map(|w| (w.as_ptr() as usize - line.as_ptr() as usize, w)).collect()
}

/// Tools whose command lines prose quotes: `ls docs/`, `git log -- src/`. What they are given is not judged.
const SHELL_TOOLS: &str = "ls cat rm cp mv mkdir touch grep rg find git gh open code echo curl tail head less source chmod export docker make cargo go pip pip3 brew sudo fly flyctl supabase vercel netlify eas expo xcrun kubectl terraform direnv tsc eslint vitest jest prisma psql sed";

/// pnpm and yarn commands that are not scripts.
const PM_COMMANDS: [&str; 34] = [
    "add",
    "install",
    "i",
    "remove",
    "rm",
    "up",
    "update",
    "upgrade",
    "dlx",
    "exec",
    "why",
    "workspace",
    "workspaces",
    "create",
    "init",
    "link",
    "unlink",
    "publish",
    "pack",
    "list",
    "ls",
    "outdated",
    "audit",
    "config",
    "dedupe",
    "cache",
    "store",
    "rebuild",
    "prune",
    "import",
    "set",
    "version",
    "info",
    "global",
];

/// The references in one shell command: the script `npm run x` names, the file `bash x.sh` or `node x.mjs` runs, the
/// folder `cd x` enters. Returns whether the text is a command at all, so it is not read as a name.
fn command(segment: &str, at: usize, out: &mut Vec<Mention>) -> bool {
    let mut ws = words(segment);
    while ws.first().is_some_and(|(_, w)| ENV_ASSIGN.is_match(w)) {
        ws.remove(0);
    }
    let Some(&(_, tool)) = ws.first() else { return false };
    let push = |out: &mut Vec<Mention>, (o, w): (usize, &str), kind: Kind| {
        let w = w.trim_end_matches([',', ';', ')', '.']);
        // A one-letter script or file stands for any.
        if w.len() > 1 && !placeholder(w) {
            out.push(Mention { at: at + o, text: w.to_string(), kind });
        }
    };
    match tool {
        "npm" | "pnpm" | "yarn" | "bun" => {
            let second = ws.get(1).map(|(_, w)| *w);
            let script = match (tool, second) {
                (_, Some("run" | "run-script")) => ws.get(2).copied(),
                ("npm", Some("test" | "start" | "stop" | "restart")) => ws.get(1).copied(),
                ("pnpm" | "yarn" | "bun", Some(w)) if !w.starts_with('-') && !PM_COMMANDS.contains(&w) && tool != "bun" => {
                    ws.get(1).copied()
                }
                _ => None,
            };
            if let Some(s) = script.filter(|(_, w)| !w.starts_with('-')) {
                push(out, s, Kind::Script);
            }
            true
        }
        "node" | "tsx" | "ts-node" | "bash" | "sh" | "zsh" | "python" | "python3" | "deno" => {
            if let Some(&file) = ws.iter().skip(1).find(|(_, w)| !w.starts_with('-') && *w != "run") {
                if path_like(file.1) {
                    push(out, file, Kind::Path);
                }
            }
            true
        }
        "npx" | "bunx" | "pnpx" => {
            // What npx runs may itself run a file: `npx tsx scripts/check.ts`.
            if let Some(&(o, _)) = ws.iter().skip(1).find(|(_, w)| !w.starts_with('-')) {
                command(&segment[o..], at + o, out);
            }
            true
        }
        "cd" => {
            if let Some(&dir) = ws.get(1) {
                let d = dir.1;
                if !matches!(d, "-" | ".." | ".")
                    && !d.starts_with(['~', '/', '$', '%', '"', '\''])
                    && d.chars().all(|c| c.is_alphanumeric() || "._-@+/".contains(c))
                {
                    push(out, dir, Kind::Path);
                }
            }
            true
        }
        w if w.starts_with("./") && path_like(w) => {
            push(out, ws[0], Kind::Path);
            true
        }
        // Another tool's command line, with arguments: not a path with spaces in it, nor a name.
        _ => ws.len() > 1 && among(SHELL_TOOLS, tool),
    }
}

/// The commands on a line of a shell block, prompt and trailing comment left out.
fn commands(line: &str, base: usize, out: &mut Vec<Mention>) {
    let trimmed = line.trim_start();
    let mut start = line.len() - trimmed.len();
    for prompt in ["$ ", "% ", "> "] {
        if trimmed.starts_with(prompt) {
            start += prompt.len();
        }
    }
    let mut body = &line[start..];
    if let Some(c) = body.find(" #").or_else(|| body.starts_with('#').then_some(0)) {
        body = &body[..c];
    }
    let mut at = 0;
    for part in body.split(['&', '|', ';']) {
        let lead = part.len() - part.trim_start().len();
        if !part.trim().is_empty() {
            command(part.trim(), base + start + at + lead, out);
        }
        at += part.len() + 1;
    }
}

static GENERIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|/)(?:Any|Some)[A-Z.]|(?:Screen|Component|File|Feature|Module|Hook|Service)Name\b").unwrap());

/// Words that are not references however they are written: placeholders, examples, globs, variables.
fn placeholder(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    t.chars().any(|c| "<>{}$*?|\"'`\\".contains(c))
        || t.contains("...")
        || t.contains("XX")
        || t.contains("YY")
        || t.contains('…')
        || t.contains("://")
        || t.starts_with('-')
        || ["nnn", "xxx", "yyyy", "example", "path/to", "your-", "your_", "my-app", "foo", "/bar", "bar/", "baz"].iter().any(|p| lower.contains(p))
        // A name that stands for any screen, component or file: `app/ScreenName.js`, `components/Any.js`.
        || GENERIC.is_match(t)
        // A one-letter file name stands for any file: `x.ts`, `../../shared/a.js`.
        || t.rsplit('/').next().and_then(|n| n.split_once('.')).is_some_and(|(stem, _)| stem.len() == 1)
}

/// The written path without a line (`:12`, `:12-30`) or an anchor.
fn bare_path(t: &str) -> &str {
    let t = t.split('#').next().unwrap_or(t);
    match t.rsplit_once(':') {
        Some((p, line)) if !p.is_empty() && line.chars().all(|c| c.is_ascii_digit() || c == '-') => p,
        _ => t,
    }
}

/// Whether code-font text is a path: segments of path characters, or a file name with a known extension or a dot
/// file (`.env.example`). URLs, globs, absolute and home paths, aliases (`@/x`, `~/x`) and extensions alone (`.ts`)
/// are not.
fn path_like(t: &str) -> bool {
    let t = bare_path(t);
    // A command's flags, or a file name followed by more words (`profile.ts sendEmailOtp`), is not one path.
    let spaced = |s: &str| s.contains(" -") || s.split(' ').rev().skip(1).any(has_extension);
    if t.is_empty()
        || t.len() > 200
        || t.contains("://")
        || t.starts_with(['/', '~', '$', '%', '\\', '#'])
        || t.starts_with("@/")
        || ROUTE.is_match(t)
        || spaced(t)
    {
        return false;
    }
    if t.contains('/') {
        let segs: Vec<&str> = t.trim_end_matches('/').split('/').collect();
        // A folder named like a source file is two files written with a slash: `inbound.ts/channels.ts`.
        let joined = segs[..segs.len() - 1].iter().any(|s| {
            s.rsplit_once('.').is_some_and(|(_, e)| {
                matches!(e, "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "rb" | "go" | "rs" | "swift" | "kt" | "java")
            })
        });
        return !joined
            && segs.iter().all(|s| {
                !s.is_empty()
                    && !s.starts_with(' ')
                    && !s.ends_with(' ')
                    && s.chars().all(|c| c.is_alphanumeric() || "._-@+[]() ".contains(c))
            })
            && !segs.iter().all(|s| s.chars().all(|c| c.is_ascii_digit()));
    }
    if let Some(rest) = t.strip_prefix('.') {
        return t.len() > 6 && !t.contains('(') && rest.chars().all(|c| c.is_alphanumeric() || "._-".contains(c));
    }
    match t.rsplit_once('.') {
        Some((stem, e)) => {
            !stem.is_empty()
                && EXTS.contains(&e.to_ascii_lowercase().as_str())
                && stem.chars().all(|c| c.is_alphanumeric() || "._-@+".contains(c))
        }
        None => false,
    }
}

/// The name a code-font name is looked up by: `fetchOrders` for `fetchOrders(id)`, `gates` for `config.gates`. None
/// for what is not a code name, or too short or too common to mean one.
fn name_of(t: &str) -> Option<&str> {
    if !NAME.is_match(t) {
        return None;
    }
    let t = t.split('(').next().unwrap_or(t);
    let last = t.rsplit(['.', '#', ':']).next().unwrap_or(t);
    // `useX`, `runX`: a naming pattern, not a name.
    let pattern = last.ends_with('X') && last[..last.len() - 1].chars().all(|c| c.is_ascii_lowercase());
    (last.len() >= 4 && !pattern && !last.chars().all(|c| c.is_ascii_uppercase()) && !KNOWN.contains(last)).then_some(last)
}

// ponytail: shape stands in for history. Asking git whether a name was ever in the code costs seconds a snapshot on
// a large repository, so judging everything a missing name is listed by its shape alone; about a third of those
// were never this repository's (another checkout's field, a library's option), which is why a change is not
// judged on them.
/// Whether a name missing from the code is shaped like the repository's own code, so its absence means something: a
/// camelCase or PascalCase name of two words or more (`fetchOrders`, `AuthError`). Snake case and capitals name
/// columns, payload keys, settings and other systems' error codes as often as code, and an acronym-led name
/// (`UIWindow`) is a platform's; in a Python, Ruby or Rust comment, snake case is the code's own.
fn code_shaped(name: &str, file: &str) -> bool {
    let n = name.trim_start_matches(['_', '$']);
    if n.contains('_') {
        return matches!(ext(file).as_str(), "py" | "rb" | "rs")
            && n.trim_end_matches('_').contains('_')
            && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    }
    let mut chars = n.chars();
    let (Some(first), Some(second)) = (chars.next(), chars.next()) else { return false };
    let humps = n.chars().skip(1).filter(char::is_ascii_uppercase).count();
    // Digits in three places or more make an id (a file key, a hash), not a name: `rstqrLfXy9hi6oLQX3aFHt`.
    let digit_runs = n.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).count();
    digit_runs < 3
        && n.len() >= 6
        && humps >= 1
        && n.chars().any(|c| c.is_ascii_lowercase())
        && (first.is_ascii_lowercase() || (first.is_ascii_uppercase() && second.is_ascii_lowercase()))
}

fn classify(t: &str) -> Option<Kind> {
    if placeholder(t) {
        None
    } else if path_like(t) {
        Some(Kind::Path)
    } else if name_of(t).is_some() {
        Some(Kind::Name)
    } else {
        None
    }
}

/// One code span's reference: a CI job when the sentence calls it one, the references of a command, a path or a name.
fn code_mention(line: &str, (start, end): (usize, usize), content: &str, at: usize, out: &mut Vec<Mention>) {
    if content.is_empty() {
        return;
    }
    if (JOB_AFTER.is_match(&line[end..]) || JOB_BEFORE.is_match(&line[..start]))
        && CI_CONTEXT.is_match(line)
        && !path_like(content)
        && !placeholder(content)
    {
        out.push(Mention { at, text: content.to_string(), kind: Kind::Job });
        return;
    }
    if command(content, at, out) {
        return;
    }
    if let Some(kind) = classify(content) {
        out.push(Mention { at, text: content.to_string(), kind });
    }
}

/// The references in a run of prose (a Markdown line, or a comment): code spans, link targets, bare paths with a
/// known extension, and in comments `{@link X}` and `@see X`. `base` is the text's offset in its file.
fn prose(text: &str, base: usize, md: bool, out: &mut Vec<Mention>) {
    // Most prose names nothing: no code span, path, link or tag, nothing to read further.
    if !text.contains(['`', '/', ']', '@']) {
        return;
    }
    let bytes = text.as_bytes();
    let mut masked = text.to_string();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let n = bytes[i..].iter().take_while(|&&b| b == b'`').count();
        let mut j = i + n;
        let mut close = None;
        while j < bytes.len() {
            if bytes[j] == b'`' {
                let m = bytes[j..].iter().take_while(|&&b| b == b'`').count();
                if m == n {
                    close = Some(j);
                    break;
                }
                j += m;
            } else {
                j += 1;
            }
        }
        let Some(c) = close else {
            i += n;
            continue;
        };
        let raw = &text[i + n..c];
        let lead = raw.len() - raw.trim_start().len();
        code_mention(text, (i, c + n), raw.trim(), base + i + n + lead, out);
        masked.replace_range(i..c + n, &blank(&text[i..c + n]));
        i = c + n;
    }
    if masked.contains("](") || masked.contains("]:") {
        let snapshot = masked.clone();
        for cap in LINK.captures_iter(&snapshot).chain(LINK_DEF.captures_iter(&snapshot)) {
            let m = cap.get(1).unwrap();
            out.push(Mention { at: base + m.start(), text: m.as_str().to_string(), kind: Kind::Link });
            masked.replace_range(m.range(), &blank(m.as_str()));
        }
    }
    if !md && masked.contains('@') {
        for cap in TAG_LINK.captures_iter(&masked) {
            let m = cap.get(1).unwrap();
            if name_of(m.as_str()).is_some() {
                out.push(Mention { at: base + m.start(), text: m.as_str().to_string(), kind: Kind::Name });
            }
        }
        for cap in SEE.captures_iter(&masked) {
            let m = cap.get(1).unwrap();
            if let Some(kind) = classify(m.as_str()) {
                out.push(Mention { at: base + m.start(), text: m.as_str().to_string(), kind });
            }
        }
    }
    if !masked.contains('/') {
        return;
    }
    for cap in BARE.captures_iter(&masked) {
        let m = cap.get(1).unwrap();
        // A comment's usage line (`--out reports/x.md \`) gives the path as an argument someone might pass.
        let line = line_at(&masked, m.start());
        let shown = line.trim_start_matches(['*', '/', '#', ' ', '\t']);
        let usage = !md && (shown.starts_with(['-', '$']) || ENV_ASSIGN.is_match(shown) || line.trim_end().ends_with('\\'));
        if !usage && !placeholder(m.as_str()) {
            out.push(Mention { at: base + m.start(), text: m.as_str().to_string(), kind: Kind::Path });
        }
    }
}

/// Every reference in a Markdown file: in its prose, and the commands in its shell blocks. Other fenced code and HTML
/// comments are left out: an example may name what it likes.
fn markdown(src: &str) -> Vec<Mention> {
    let mut out = vec![];
    let mut fence: Option<(u8, usize, bool)> = None;
    let mut in_comment = false;
    let mut at = 0;
    for line in src.split_inclusive('\n') {
        let start = at;
        at += line.len();
        let trimmed = line.trim_start();
        if let Some((ch, n, shell)) = fence {
            let run = trimmed.bytes().take_while(|&b| b == ch).count();
            if run >= n && trimmed[run..].trim().is_empty() {
                fence = None;
            } else if shell {
                commands(line, start, &mut out);
            }
            continue;
        }
        if let Some(ch @ (b'`' | b'~')) = trimmed.bytes().next() {
            let n = trimmed.bytes().take_while(|&b| b == ch).count();
            if n >= 3 {
                let info = trimmed[n..].trim().split(|c: char| c.is_whitespace() || c == '{').next().unwrap_or("").to_ascii_lowercase();
                fence = Some((ch, n, matches!(info.as_str(), "bash" | "sh" | "shell" | "zsh" | "console" | "terminal" | "fish")));
                continue;
            }
        }
        let visible = hide_html_comments(line, &mut in_comment);
        prose(&visible, start, true, &mut out);
    }
    out
}

/// The references in a code file's comments, and the npm scripts its strings tell people to run.
fn comments(file: &str, src: &str) -> Vec<Mention> {
    let mut out = vec![];
    if is_c_like(file) {
        // A test's strings are its fixtures, and a Rust file is not read from its test module on.
        let tests_from = src.find("#[cfg(test)]").unwrap_or(src.len());
        for (s, e, string) in text::code_spans(src) {
            if s >= tests_from || (string && is_test(file)) {
                continue;
            }
            if string {
                for cap in RUN_IN_STRING.captures_iter(&src[s..e]) {
                    let m = cap.get(1).unwrap();
                    let name = m.as_str().trim_end_matches(['.', ',']);
                    // After `cd`, the script is another folder's, often another checkout's.
                    if name.len() > 1 && !src[s..s + m.start()].contains("cd ") {
                        out.push(Mention { at: s + m.start(), text: name.to_string(), kind: Kind::Script });
                    }
                }
            } else {
                prose(&src[s..e], s, false, &mut out);
            }
        }
    } else if is_hash_like(file) {
        let mut at = 0;
        for line in src.split_inclusive('\n') {
            // A shebang is not prose, nor a setting left commented out (`# path = "./keys.json"`): its value is an example.
            let shebang = at == 0 && line.starts_with("#!");
            if let Some(c) = hash_comment(line).filter(|&c| !shebang && !SETTING.is_match(&line[c + 1..])) {
                prose(&line[c..], at + c, false, &mut out);
            }
            at += line.len();
        }
    }
    out
}

/// Where a `#` comment starts on a line: at its start or after a space, outside quotes.
fn hash_comment(line: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut prev = ' ';
    for (i, c) in line.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' && prev.is_whitespace() => return Some(i),
            None => {}
        }
        prev = c;
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------
// The repository a reference is resolved against.

/// Names every JavaScript runtime, browser and language provides: code font may name them with no code using them.
static KNOWN: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    "true false null undefined this super self async await yield return throw const function class extends implements interface type enum namespace module import export from default typeof instanceof keyof readonly static public private protected abstract declare unknown never void object string number boolean bigint symbol require exports console window document process globalThis Promise Array Object String Number Boolean Map Set WeakMap WeakSet JSON Math Date Error TypeError RegExp Symbol Reflect Proxy Intl fetch Response Request Headers FormData URLSearchParams AbortController AbortSignal setTimeout setInterval clearTimeout clearInterval queueMicrotask structuredClone localStorage sessionStorage navigator location history crypto atob btoa Buffer TextEncoder TextDecoder ReadableStream WritableStream Blob File Event EventTarget CustomEvent MutationObserver IntersectionObserver ResizeObserver requestAnimationFrame cancelAnimationFrame performance isNaN parseInt parseFloat encodeURIComponent decodeURIComponent then catch finally length push slice splice includes indexOf forEach filter reduce some every find findIndex keys values entries assign freeze toString valueOf"
        .split(' ')
        .collect()
});

/// Node's own modules, which docs name in paths (`fs/promises`) with no package behind them.
const NODE_BUILTINS: &str = "fs path os url util crypto stream events http https child_process worker_threads zlib assert buffer net tls dns readline timers perf_hooks module vm querystring";

static REF_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:origin|upstream|refs|feat|feature|fix|bugfix|hotfix|chore|wip|release|releases|dependabot|renovate)/").unwrap()
});
static DOMAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|app|ai|co|sh|so|me|us|uk|xyz|gg|tv|fm|ly|to|cloud|tech|site|page)$").unwrap()
});
// ponytail: whether a sentence is about the past, the future or an example is read from these words on the
// reference's own line (and the line it wraps from); said another way, it is judged as a plain assertion.
/// A sentence about what used to be, or what is elsewhere (on a pull request or branch, in another repository or a
/// library): a reference that does not resolve here belongs in it. A code span the sentence quotes is read as a
/// space, so "in the `api` repo" reads as "in the", three spaces and "repo".
static HISTORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(?:was|were|renamed|former|formerly|previously|originally|replaced|replaces|supersedes|superseded|moved|used to|no longer|anymore|deleted|deletes|deletion|removed|removes|drops|dropped|retired|gone|lived|obsolete|legacy|deprecated|old|had|earlier|ago|instead of|(?:on|in|of|from) the\s+(?:[\w.#-]+\s+){0,3}(?:pr|branch)|in the (?:[\w.-]+ |\s{2,})(?:repo|repository|plugin|package|library|sdk))\b").unwrap()
});
/// A sentence about what is to come: what it names may not be built yet.
static FUTURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(?:new|create|creates|creating|will|would|shall|planned|proposed|propose|future|todo|tbd|to be|upcoming|introduce|introduces|add|adds|adding|write|writes)\b").unwrap()
});

/// Paths as sets, with every file and folder name pointing at the paths that end in it.
#[derive(Default)]
struct Paths {
    files: HashSet<String>,
    dirs: HashSet<String>,
    /// A file or folder's name, and a file's name without its extension, -> the paths that end in it.
    by_name: HashMap<String, Vec<String>>,
    /// Paths with a run of spaces in a name, as prose shows them (Markdown collapses the run) -> the path.
    squashed: HashMap<String, String>,
}

/// Runs of spaces as one, as rendered prose shows a name.
fn squash(s: &str) -> String {
    s.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// What a path written without an extension may be, as module resolution tries it.
const IMPLIED: [&str; 14] =
    [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx", ".json", ".swift", "/index.ts", "/index.tsx", "/index.js", "/README.md"];

/// The TypeScript file an ES module import names with a JavaScript extension: `x.js` -> `x.ts`.
fn ts_for_js(path: &str) -> Option<String> {
    let (stem, e) = path.rsplit_once('.')?;
    let ts = match e {
        "js" => "ts",
        "jsx" => "tsx",
        "mjs" => "mts",
        "cjs" => "cts",
        _ => return None,
    };
    Some(format!("{stem}.{ts}"))
}

/// Whether a written path ends in a file name: `x.ts`, not `src/lib`.
fn has_extension(t: &str) -> bool {
    let last = t.rsplit('/').next().unwrap_or(t);
    last.rsplit_once('.').is_some_and(|(stem, e)| !stem.is_empty() && EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

impl Paths {
    fn new<'a>(paths: impl Iterator<Item = &'a String>) -> Self {
        let mut p = Paths::default();
        for path in paths {
            let name = path.rsplit('/').next().unwrap_or(path);
            p.by_name.entry(name.to_string()).or_default().push(path.clone());
            if let Some((stem, _)) = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()) {
                p.by_name.entry(stem.to_string()).or_default().push(path.clone());
            }
            let mut dir = parent(path);
            while !dir.is_empty() && p.dirs.insert(dir.to_string()) {
                p.by_name.entry(dir.rsplit('/').next().unwrap_or(dir).to_string()).or_default().push(dir.to_string());
                if dir.contains("  ") {
                    p.squashed.insert(squash(dir), dir.to_string());
                }
                dir = parent(dir);
            }
            if path.contains("  ") {
                p.squashed.insert(squash(path), path.clone());
            }
            p.files.insert(path.clone());
        }
        p
    }

    fn has(&self, path: &str) -> bool {
        self.files.contains(path) || self.dirs.contains(path) || self.squashed.contains_key(path)
    }

    /// Whether a folder of this name is beside the file, at the project root or at the repository top: where a
    /// reader would look for a path that starts with it.
    fn near_dir(&self, name: &str, from: &str, prefix: &str) -> bool {
        [parent(from), prefix.trim_end_matches('/'), ""].iter().any(|base| self.dirs.contains(&join(base, name)))
    }

    /// `has`, or a file the written path stands for: written without an extension (`x` -> `x.ts`, `x/index.ts`, or
    /// any file named `x.<ext>` there), or as an ES module import writes a TypeScript file (`x.js` -> `x.ts`).
    fn has_implied(&self, path: &str) -> bool {
        if self.has(path) || ts_for_js(path).is_some_and(|ts| self.has(&ts)) {
            return true;
        }
        if has_extension(path) {
            return false;
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        IMPLIED.iter().any(|e| self.files.contains(&format!("{path}{e}")))
            || self.by_name.get(name).is_some_and(|ps| ps.iter().any(|p| p.rsplit_once('.').is_some_and(|(stem, _)| stem == path)))
    }

    /// Where a file of this name lives, when a written path to it does not resolve: the path sharing the most trailing
    /// folders with the written one. A path written without an extension is matched by a file's stem only with its
    /// folder too (`orders/holds` -> `src/lib/orders/holds.ts`): a stem alone (`search`) is too common to mean that file.
    fn moved(&self, written: &str) -> Option<&String> {
        let t = bare_path(written).trim_end_matches('/');
        let name = t.rsplit('/').next()?;
        let wanted: Vec<&str> = t.split('/').rev().collect();
        let stem = |s: &str| s.rsplit_once('.').map_or(s.to_string(), |(stem, _)| stem.to_string());
        let shared = |p: &String| {
            p.split('/').rev().zip(&wanted).enumerate().take_while(|(i, (a, b))| a == *b || (*i == 0 && stem(a) == **b)).count()
        };
        let same: Vec<&String> = self.by_name.get(name)?.iter().filter(|p| self.files.contains(*p)).collect();
        let best = *same.iter().max_by_key(|p| shared(p))?;
        // The name alone says where the file went only when one file has it: `index.ts` or `SKILL.md` could be any.
        (shared(best) >= 2 || (has_extension(t) && same.len() == 1)).then_some(best)
    }

    /// Whether the path is on disk though git does not list it: a nested checkout's file, or a build's output.
    fn on_disk(root: &str, rel: &str) -> bool {
        !rel.is_empty() && std::path::Path::new(root).join(rel).exists()
    }

    /// The path a written path names, tried as a reader would: from the file it is written in, the project, the
    /// repository top and each folder above the file; then as the tail of a longer path (`lib/errors.ts` for
    /// `src/lib/errors.ts`), or a file name found anywhere. None when nothing matches.
    fn find(&self, written: &str, from: &str, prefix: &str) -> Option<String> {
        let t = bare_path(written).trim_start_matches("./").trim_end_matches('/');
        if t.is_empty() {
            return None;
        }
        let mut bases = vec![parent(from), prefix.trim_end_matches('/'), ""];
        let mut dir = parent(parent(from));
        while !dir.is_empty() {
            bases.push(dir);
            dir = parent(dir);
        }
        for base in bases {
            if let Some(c) = normalize(&join(base, t)) {
                if self.has_implied(&c) {
                    return Some(c);
                }
            }
        }
        // From a package's root, its source folder left out: `core/stats.rs` for `core/src/stats.rs`.
        let segs: Vec<&str> = t.split('/').collect();
        for i in 1..segs.len() {
            let with_src = format!("{}/src/{}", segs[..i].join("/"), segs[i..].join("/"));
            for base in [parent(from), prefix.trim_end_matches('/'), ""] {
                if let Some(c) = normalize(&join(base, &with_src)).filter(|c| self.has_implied(c)) {
                    return Some(c);
                }
            }
        }
        // As the tail of a longer path: an import quoted from code (`../orders/holds.js`) is matched without its climb.
        let t = t.trim_start_matches("../").trim_start_matches("./");
        let ts = ts_for_js(t);
        // The file's own name, the TypeScript name an import's `.js` stands for, or for no extension, the stem.
        [Some(t.to_string()), ts].into_iter().flatten().find_map(|t| {
            let name = t.rsplit('/').next().unwrap_or(&t).to_string();
            let tail = format!("/{t}");
            let ends = |p: &str| {
                p == t
                    || p.ends_with(&tail)
                    || (!has_extension(&t)
                        && (IMPLIED.iter().any(|e| p.ends_with(&format!("{tail}{e}")))
                            || p.rsplit_once('.').is_some_and(|(stem, _)| stem.ends_with(&tail) || stem == t)))
            };
            let implied = |p: &&String| !t.contains('/') || ends(p) || (p.contains("  ") && ends(&squash(p)));
            self.by_name.get(&name)?.iter().find(implied).cloned()
        })
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

fn join(base: &str, rel: &str) -> String {
    if base.is_empty() {
        rel.to_string()
    } else {
        format!("{base}/{rel}")
    }
}

/// `a/./b/../c` as `a/c`; None when it climbs above the repository top.
fn normalize(path: &str) -> Option<String> {
    let mut out: Vec<&str> = vec![];
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(out.join("/"))
}

/// The identifiers in some text.
fn identifiers(text: &str) -> impl Iterator<Item = &str> {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    text.split(move |c: char| !is_ident(c)).filter(|w| !w.is_empty() && !w.starts_with(|c: char| c.is_ascii_digit()))
}

/// Code with its comments blanked and its strings kept: names in strings (event names, keys) are the code's.
fn without_comments(src: &str) -> String {
    let mut out = src.to_string();
    for (s, e, string) in text::code_spans(src) {
        if !string {
            out.replace_range(s..e, &blank(&src[s..e]));
        }
    }
    out
}

/// Every name the repository's code and config contain, file and folder names included.
fn code_names(root: &str, files: &[String]) -> HashSet<String> {
    let mut names = files
        .par_iter()
        .filter(|f| !is_prose(f) && (is_c_like(f) || is_hash_like(f) || is_data(f) || is_other_code(f)))
        .filter_map(|f| {
            let src = text::read(root, f)?;
            let code = if is_c_like(f) { without_comments(&src) } else { src };
            Some(identifiers(&code).map(str::to_string).collect::<HashSet<String>>())
        })
        .reduce(HashSet::new, |mut a, mut b| {
            if a.len() < b.len() {
                std::mem::swap(&mut a, &mut b);
            }
            a.extend(b);
            a
        });
    for f in files {
        for seg in f.split('/') {
            names.extend(identifiers(seg).map(str::to_string));
        }
    }
    names
}

/// What package.json files and workflows declare: npm scripts, package names, and CI job, step and workflow names.
#[derive(Default)]
struct Declared {
    scripts: BTreeSet<String>,
    packages: HashSet<String>,
    jobs: BTreeSet<String>,
}

fn declared(root: &str, files: &[String]) -> Declared {
    let mut d = Declared::default();
    for f in files {
        if f.ends_with("package.json") {
            let Some(json) = text::read(root, f).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) else { continue };
            if let Some(name) = json.get("name").and_then(|n| n.as_str()) {
                d.packages.insert(name.to_string());
            }
            if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                d.scripts.extend(scripts.keys().cloned());
            }
            for field in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
                if let Some(deps) = json.get(field).and_then(|s| s.as_object()) {
                    d.packages.extend(deps.keys().cloned());
                }
            }
        } else if f.contains(".github/workflows/") && matches!(ext(f).as_str(), "yml" | "yaml") {
            let Some(yaml) = text::read(root, f).and_then(|s| serde_yaml::from_str::<serde_yaml::Value>(&s).ok()) else { continue };
            let mut add = |v: Option<&serde_yaml::Value>| {
                if let Some(s) = v.and_then(|v| v.as_str()) {
                    d.jobs.insert(s.to_lowercase());
                }
            };
            add(yaml.get("name"));
            if let Some(jobs) = yaml.get("jobs").and_then(|j| j.as_mapping()) {
                for (id, job) in jobs {
                    add(Some(id));
                    add(job.get("name"));
                    for step in job.get("steps").and_then(|s| s.as_sequence()).into_iter().flatten() {
                        add(step.get("name"));
                    }
                }
            }
        }
    }
    d
}

/// A Markdown file's anchors: GitHub's slug of every heading (`-1`, `-2` on repeats), and `id`/`name` attributes.
fn anchors(src: &str) -> HashSet<String> {
    static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$").unwrap());
    static LINKED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?:\bid|\bname)\s*=\s*["']([^"']+)["']|\{#([\w-]+)\}"#).unwrap());
    let mut out = HashSet::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    // A line under a paragraph line that is all `=` or all `-` makes that line a heading (setext).
    static UNDERLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{0,3}(?:=+|-+)\s*$").unwrap());
    static NOT_PARAGRAPH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:[-*+>|#]|\d+[.)]\s|<)").unwrap());
    let mut fence = false;
    let mut previous = "";
    for line in src.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            previous = "";
            continue;
        }
        if fence {
            continue;
        }
        let above = std::mem::replace(&mut previous, line);
        for cap in ID.captures_iter(line) {
            if let Some(m) = cap.get(1).or_else(|| cap.get(2)) {
                out.insert(m.as_str().to_string());
            }
        }
        let heading = match HEADING.captures(line) {
            Some(cap) => cap.get(1).map_or("", |m| m.as_str()),
            None if UNDERLINE.is_match(line) && !above.trim().is_empty() && !NOT_PARAGRAPH.is_match(above) => {
                previous = "";
                above.trim()
            }
            None => continue,
        };
        let text = LINKED.replace_all(heading, "$1");
        // GitHub drops HTML tags from a heading, but not what a code span shows: `Option<T>` is `optiont`.
        let text: String = text
            .split('`')
            .enumerate()
            .map(|(i, part)| if i % 2 == 0 { TAG.replace_all(part, "").into_owned() } else { part.to_string() })
            .collect();
        let slug: String = text
            .trim()
            .to_lowercase()
            .chars()
            .filter_map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    Some(c)
                } else if c == ' ' {
                    Some('-')
                } else {
                    None
                }
            })
            .collect();
        let n = seen.entry(slug.clone()).or_insert(0);
        out.insert(if *n == 0 { slug.clone() } else { format!("{slug}-{n}") });
        *n += 1;
    }
    out
}

/// The closest of `names` to `name`, when it is near enough to be a slip: "did you mean".
fn nearest<'a>(name: &str, names: impl Iterator<Item = &'a String>) -> Option<&'a String> {
    let limit = (name.chars().count() / 6).max(1);
    names
        .filter(|n| n.len().abs_diff(name.len()) <= limit)
        .map(|n| (text::distance(name, n), n))
        .filter(|(d, _)| *d > 0 && *d <= limit)
        .min_by_key(|(d, _)| *d)
        .map(|(_, n)| n)
}

// ---------------------------------------------------------------------------------------------------------------
// Judging.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// The project's own files, from the repository top: the prose judged, nested projects left out.
    own: Vec<String>,
    /// Files the change deleted or moved: old path -> new path, empty when deleted.
    #[serde(default)]
    gone: HashMap<String, String>,
    /// The base text of each code file the change modified or deleted, for the names it removed.
    #[serde(default)]
    base: HashMap<String, String>,
    /// The change as `git diff -U0 -M`: a name it renamed is the renames gate's.
    #[serde(default)]
    patch: String,
    /// Branch and tag names, which prose puts in code font and are not paths.
    #[serde(default)]
    refs: Vec<String>,
}

/// The names the code and config contain, and the same names by first character and length, for "did you mean".
struct Names {
    all: HashSet<String>,
    shape: HashMap<(char, usize), Vec<String>>,
    /// Each missing name's answer, asked once however often it is written.
    asked: std::sync::Mutex<HashMap<String, Option<String>>>,
}

impl Names {
    fn new(all: HashSet<String>) -> Self {
        let mut shape: HashMap<(char, usize), Vec<String>> = HashMap::new();
        for n in &all {
            if let Some(c) = n.chars().next() {
                shape.entry((c, n.len())).or_default().push(n.clone());
            }
        }
        Names { all, shape, asked: Default::default() }
    }

    /// The name this one is likely a slip of: same first character, a length within reach, and most of its letters.
    fn near(&self, name: &str) -> Option<String> {
        if let Some(known) = self.asked.lock().unwrap().get(name) {
            return known.clone();
        }
        let c = name.chars().next()?;
        let limit = (name.chars().count() / 6).max(1);
        let letters = letter_counts(name);
        let close = (name.len().saturating_sub(limit)..=name.len() + limit)
            .filter_map(|l| self.shape.get(&(c, l)))
            .flatten()
            .filter(|n| letter_counts(n).iter().zip(&letters).map(|(a, b)| a.abs_diff(*b) as usize).sum::<usize>() <= 2 * limit);
        let found = nearest(name, close).cloned();
        self.asked.lock().unwrap().insert(name.to_string(), found.clone());
        found
    }
}

/// How often each letter and digit is in a name, lowercase: two names an edit or two apart differ little here.
fn letter_counts(name: &str) -> [u8; 36] {
    let mut counts = [0u8; 36];
    for c in name.chars() {
        if let Some(d) = c.to_ascii_lowercase().to_digit(36) {
            counts[d as usize] = counts[d as usize].saturating_add(1);
        }
    }
    counts
}

/// Worked out the first time it is needed.
type Later<'a> = LazyLock<Names, Box<dyn FnOnce() -> Names + Send + 'a>>;

struct Judge<'a> {
    request: &'a Request,
    paths: Paths,
    gone: &'a HashMap<String, String>,
    gone_paths: Paths,
    declared: Declared,
    refs: HashSet<&'a str>,
    /// Filled only when a name has to be checked: reading every code file is the expensive part.
    names: Later<'a>,
    removed: HashSet<String>,
    /// Each Markdown file's anchors, read once however many links point into it.
    anchors: std::sync::Mutex<HashMap<String, std::sync::Arc<HashSet<String>>>>,
}

/// What became of one reference.
enum Verdict {
    Fine,
    /// Not there: the message, and for a path the one git history is asked about.
    Missing(String, Option<String>),
}

impl Judge<'_> {
    /// A path that is not one of this repository's: an npm package, a Node module, a branch, a web address.
    fn foreign(&self, t: &str) -> bool {
        let t = t.trim_start_matches("./");
        let first = t.split('/').next().unwrap_or("");
        let package = if first.starts_with('@') { t.splitn(3, '/').take(2).collect::<Vec<_>>().join("/") } else { first.to_string() };
        // An installed package's files, a scoped package or an alias (`@scope/x`), what a build or test run writes, a
        // Node module, a branch, a domain.
        t.starts_with("node:")
            || first.starts_with('@')
            || t.split('/').any(|s| s == "node_modules")
            || matches!(
                first,
                "dist"
                    | "build"
                    | "out"
                    | "coverage"
                    | "tmp"
                    | ".cache"
                    | ".next"
                    | ".nuxt"
                    | ".turbo"
                    | ".expo"
                    | "target"
                    | "DerivedData"
                    | "Pods"
                    | "test-results"
                    | "playwright-report"
            )
            || among(NODE_BUILTINS, first)
            || self.declared.packages.contains(&package)
            || self.refs.contains(t)
            || REF_PREFIX.is_match(t)
            || DOMAIN.is_match(first)
    }

    /// Whether a path that does not resolve is still surely a path: it names a file (`x.ts`), it climbs or ends in a
    /// slash, or it starts at a folder beside the file, at the project root or at the top. A route (`user/get_details`)
    /// or someone else's working files start at no such folder.
    fn plausible(&self, written: &str, file: &str) -> bool {
        let t = bare_path(written).trim_start_matches("./");
        t.starts_with("../")
            || t.ends_with('/')
            || has_extension(t)
            || (t.contains('/') && self.paths.near_dir(t.split('/').next().unwrap_or(""), file, &self.request.prefix))
    }

    /// Whether a relative path climbs out of the repository from the file it is in: it names another checkout's file,
    /// which this one cannot judge.
    fn outside(written: &str, file: &str) -> bool {
        written.starts_with("../") && normalize(&join(parent(file), bare_path(written))).is_none()
    }

    /// Whether a path that is not there, and by history never was, is written where the prose does not assert it of
    /// this repository. It is asserted in an agent's standing instructions, and where it starts at a folder a reader
    /// would look in and names a doc, or a file whose name is elsewhere in the repository (the path is wrong). Not as
    /// an example or something to build, and not a path that starts nowhere here or a code path with no namesake:
    /// those are another checkout's (a comment on what the backend's file does) far more often than a slip.
    fn soft(&self, written: &str, file: &str, sentence: &str) -> bool {
        if EXAMPLE.is_match(sentence) || FUTURE.is_match(sentence) {
            return true;
        }
        if is_instructions(file) {
            return false;
        }
        let t = bare_path(written).trim_start_matches('@').trim_start_matches("./").trim_end_matches('/');
        let segs: Vec<&str> = t.split('/').filter(|s| !s.is_empty()).collect();
        // It starts at a folder beside the file, at the project root or at the top: a place in this repository.
        let placed = segs.len() > 1 && (t.starts_with("../") || self.paths.near_dir(segs[0], file, &self.request.prefix));
        !placed || is_test(file) || !(is_prose(t) || self.paths.moved(written).is_some())
    }

    fn check(&self, file: &str, m: &Mention, place: &str) -> Verdict {
        let prefix = &self.request.prefix;
        match m.kind {
            Kind::Path => {
                // `@path` is an import in agent instructions (`@AGENTS.md`); `@scope/x` is a package or an alias.
                let raw = m.text.strip_prefix("mdc:").unwrap_or(&m.text);
                let text = raw
                    .strip_prefix('@')
                    .filter(|rest| rest.starts_with('.') || self.paths.find(rest, file, prefix).is_some())
                    .unwrap_or(raw);
                let bare = bare_path(text).trim_start_matches("./");
                if self.foreign(text)
                    || Self::outside(text, file)
                    || self.paths.find(text, file, prefix).is_some()
                    || !self.plausible(text, file)
                    || [parent(file), prefix.trim_end_matches('/'), ""]
                        .iter()
                        .any(|base| normalize(&join(base, bare)).is_some_and(|p| Paths::on_disk(&self.request.root, &p)))
                {
                    return Verdict::Fine;
                }
                let moved =
                    self.paths.moved(text).map_or(String::new(), |p| format!(" (a file of that name is at `{}`)", crate::rel(prefix, p)));
                Verdict::Missing(
                    format!("{place} names `{}`, which is not in the repository{moved}", m.text),
                    Some(bare_path(text).trim_start_matches("./").trim_end_matches('/').to_string()),
                )
            }
            Kind::Link => self.link(file, &m.text, place),
            Kind::Name => {
                let name = name_of(&m.text).unwrap_or(&m.text);
                if !code_shaped(name, file) || self.names.all.contains(name) {
                    return Verdict::Fine;
                }
                let near = self.names.near(name);
                Verdict::Missing(format!("{place} names `{}`, which no code or config file in the repository contains{}: a name that was removed or renamed, a typo, or another project's; name what the code calls it now, or drop it", m.text, near.map_or(String::new(), |n| format!(" (did you mean `{n}`?)"))), None)
            }
            // pnpm and yarn also run a dependency's binary: `pnpm prisma generate`, `yarn tsc`.
            Kind::Script
                if self.declared.scripts.contains(&m.text)
                    || among(SHELL_TOOLS, &m.text)
                    || self.declared.packages.iter().any(|p| p.rsplit('/').next() == Some(m.text.as_str())) =>
            {
                Verdict::Fine
            }
            Kind::Script => {
                let near = nearest(&m.text, self.declared.scripts.iter());
                Verdict::Missing(format!("{place} says to run the `{}` npm script, but no package.json in the repository has one{}: name a script that exists", m.text, near.map_or(String::new(), |n| format!(" (did you mean `{n}`?)"))), None)
            }
            Kind::Job if self.declared.jobs.is_empty() || self.declared.jobs.contains(&m.text.to_lowercase()) => Verdict::Fine,
            Kind::Job => {
                let near = nearest(&m.text.to_lowercase(), self.declared.jobs.iter());
                Verdict::Missing(
                    format!(
                        "{place} names the `{}` job, but no workflow in .github/workflows has a job, step or workflow by that name{}",
                        m.text,
                        near.map_or(String::new(), |n| format!(" (did you mean `{n}`?)"))
                    ),
                    None,
                )
            }
        }
    }

    fn link(&self, file: &str, target: &str, place: &str) -> Verdict {
        // Cursor's link to a file of the repository, from its top: `[x](mdc:.cursor/rules/x.mdc)`.
        let rooted = target.strip_prefix("mdc:").map(|t| format!("/{}", t.trim_start_matches("./")));
        let target = rooted.as_deref().unwrap_or(target);
        let lower = target.to_ascii_lowercase();
        if lower.contains("://")
            || lower.starts_with("mailto:")
            || lower.starts_with("tel:")
            || lower.starts_with("data:")
            || placeholder(target)
        {
            return Verdict::Fine;
        }
        let (path, anchor) = target.split_once('#').unwrap_or((target, ""));
        let path = path.replace("%20", " ");
        // A site's own route (`/policies/terms/`), a file on someone's machine (`/Users/…`), another checkout's file.
        let machine = ["/Users/", "/home/", "/tmp/", "/private/", "/var/", "/opt/", "/etc/", "/usr/", "/Volumes/", "/mnt/"]
            .iter()
            .any(|r| path.starts_with(r));
        // In a web app's own pages (a folder above the file holds `public/` or `pages/`), every link from its root is a
        // route the app serves, `/llms.txt` included.
        let mut above = parent(file);
        let mut site = false;
        while !above.is_empty() && !site {
            site = ["public", "pages", "src/pages"].iter().any(|d| self.paths.dirs.contains(&join(above, d)));
            above = parent(above);
        }
        if (path.starts_with('/') && (!has_extension(&path) || site)) || machine || Self::outside(&path, file) {
            return Verdict::Fine;
        }
        let resolved = if path.is_empty() {
            Some(file.to_string())
        } else if let Some(top) = path.strip_prefix('/') {
            // From the repository top, or from a docs site's root: a folder above the file (`/plans/x.mdx` in
            // `docs/implementation/plans/y.mdx`).
            let mut roots = vec![parent(file)];
            while let Some(&dir) = roots.last().filter(|d| !d.is_empty()) {
                roots.push(parent(dir));
            }
            roots.iter().rev().filter_map(|dir| normalize(&join(dir, top))).find(|r| self.paths.has_implied(r)).or_else(|| normalize(top))
        } else {
            normalize(&join(parent(file), &path))
        };
        let Some(resolved) = resolved.filter(|r| self.paths.has_implied(r)) else {
            if self.foreign(&path) || resolved_on_disk(&self.request.root, file, &path) {
                return Verdict::Fine;
            }
            let moved = self
                .paths
                .moved(&path)
                .map_or(String::new(), |p| format!(" (a file of that name is at `{}`)", crate::rel(&self.request.prefix, p)));
            return Verdict::Missing(
                format!("{place} links to `{target}`, which is not in the repository{moved}"),
                Some(path.trim_start_matches(['.', '/']).to_string()),
            );
        };
        if anchor.is_empty() || !matches!(ext(&resolved).as_str(), "md" | "mdx" | "markdown") {
            return Verdict::Fine;
        }
        let cached = self.anchors.lock().unwrap().get(&resolved).cloned();
        let known = match cached {
            Some(known) => known,
            None => {
                let Some(src) = text::read(&self.request.root, &resolved) else { return Verdict::Fine };
                let known = std::sync::Arc::new(anchors(&src));
                self.anchors.lock().unwrap().insert(resolved.clone(), known.clone());
                known
            }
        };
        if known.contains(anchor) || known.contains(&anchor.to_lowercase()) {
            return Verdict::Fine;
        }
        let near = nearest(anchor, known.iter());
        Verdict::Missing(
            format!(
                "{place} links to `{target}`, but {resolved} has no heading for `#{anchor}`{}: link a heading that is there",
                near.map_or(String::new(), |n| format!(" (did you mean `#{n}`?)"))
            ),
            None,
        )
    }

    /// Whether a path or link a plan or record gives is there: Ok when it is, Err with the path history is asked about
    /// when it is not, None when it is not this repository's path to judge (a URL, a package, another checkout).
    fn standing(&self, file: &str, m: &Mention) -> Option<Result<(), String>> {
        match self.check(file, m, "") {
            Verdict::Missing(_, Some(path)) => Some(Err(path)),
            Verdict::Missing(_, None) => Some(Ok(())), // a link to a heading that is not there: its file is
            Verdict::Fine => {
                let there = match m.kind {
                    Kind::Path => {
                        let raw = m.text.strip_prefix("mdc:").unwrap_or(&m.text);
                        self.paths.find(raw.strip_prefix('@').unwrap_or(raw), file, &self.request.prefix).is_some()
                    }
                    Kind::Link => {
                        let rooted = m.text.strip_prefix("mdc:").map(|t| format!("/{}", t.trim_start_matches("./")));
                        let target = rooted.as_deref().unwrap_or(&m.text);
                        let path = target.split('#').next().unwrap_or("").replace("%20", " ");
                        let resolved = match path.strip_prefix('/') {
                            Some(top) => normalize(top),
                            None if !path.is_empty() => normalize(&join(parent(file), &path)),
                            None => None,
                        };
                        resolved.is_some_and(|r| self.paths.has_implied(&r))
                    }
                    _ => false,
                };
                there.then_some(Ok(()))
            }
        }
    }

    /// For an unchanged reference, judging a change: the file this change deleted or moved, or the name it removed,
    /// that the reference names.
    fn broken_by_change(&self, file: &str, m: &Mention, place: &str) -> Option<String> {
        match m.kind {
            Kind::Path | Kind::Link if !self.gone.is_empty() => {
                if self.paths.find(&m.text, file, &self.request.prefix).is_some() {
                    return None;
                }
                let old = self.gone_paths.find(&m.text, file, &self.request.prefix)?;
                let new = self.gone.get(&old).filter(|n| !n.is_empty());
                Some(match new {
                    Some(new) => format!("{place} names `{}`, which this change moves to `{new}`: name `{new}`", m.text),
                    None => format!(
                        "{place} names `{}`, which this change deletes: point it at where that code lives now, or drop the mention",
                        m.text
                    ),
                })
            }
            Kind::Name => {
                let name = name_of(&m.text)?;
                self.removed.contains(name).then(|| {
                    format!(
                        "{place} names `{}`, which this change removes from the code: name what replaced it, or drop the mention",
                        m.text
                    )
                })
            }
            _ => None,
        }
    }
}

/// Whether a link's target is on disk though git does not list it: a nested checkout's file.
fn resolved_on_disk(root: &str, file: &str, path: &str) -> bool {
    let rel = match path.strip_prefix('/') {
        Some(top) => normalize(top),
        None => normalize(&join(parent(file), path)),
    };
    rel.is_some_and(|r| Paths::on_disk(root, &r))
}

/// The line a byte offset is on, as text.
fn line_at(src: &str, at: usize) -> &str {
    let start = src[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = src[at..].find('\n').map_or(src.len(), |i| at + i);
    &src[start..end]
}

/// A sentence without what it quotes: code font and paths blanked, so that a file called `old-api.ts` or
/// `not-found.tsx` does not make its own sentence read as history or as a counter-example.
fn wording(sentence: &str) -> String {
    static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`|\S*/\S*").unwrap());
    QUOTED.replace_all(sentence, " ").into_owned()
}

/// The line a reference is on, with the lines before it when the reference opens its line or the line carries on a
/// wrapped list (it starts with code font): wrapped prose says "never copy it into" or "Release 2a deletes" on one
/// line and the paths on the next.
fn sentence_at(src: &str, at: usize) -> &str {
    let start = src[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = src[at..].find('\n').map_or(src.len(), |i| at + i);
    let carries = |line: usize| src[line..].trim_start().starts_with('`');
    let mut from = start;
    // ponytail: a wrapped sentence is followed back three lines at most, not parsed.
    for _ in 0..3 {
        let opens = from == start && src[start..at].chars().all(|c| c.is_whitespace() || "`*_>([-/#".contains(c));
        if from == 0 || !(opens || carries(from)) {
            break;
        }
        from = src[..from - 1].rfind('\n').map_or(0, |i| i + 1);
    }
    &src[from..end]
}

/// Whether a name is specific enough that its absence from all code means it was removed: `fetchOrders`,
/// `MAX_RETRIES`, not `data`.
fn specific(name: &str) -> bool {
    let multiword = name.chars().skip(1).any(|c| c.is_ascii_uppercase()) || name.trim_matches('_').contains('_');
    name.len() >= 4 && (multiword || name.len() >= 8)
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { own, gone, base, patch, refs } = request.options()?;
    let whole = request.added.is_none();
    let root = request.root.clone();
    let files = request.files.clone();
    // Names removed by this change: in the code before it, in no code now. Renamed ones are the renames gate's.
    let renamed = crate::renames::renamed(&patch);
    let candidates: HashSet<String> = base
        .iter()
        .filter(|(f, _)| is_c_like(f))
        .flat_map(|(_, src)| identifiers(&without_comments(src)).filter(|n| specific(n)).map(str::to_string).collect::<Vec<_>>())
        .collect();
    let judge = Judge {
        request,
        paths: Paths::new(request.files.iter()),
        gone: &gone,
        gone_paths: Paths::new(gone.keys()),
        declared: declared(&request.root, &request.files),
        refs: refs.iter().map(String::as_str).collect(),
        names: LazyLock::new(Box::new(move || Names::new(code_names(&root, &files)))),
        removed: HashSet::new(),
        anchors: Default::default(),
    };
    let removed: HashSet<String> = if candidates.is_empty() {
        HashSet::new()
    } else {
        candidates.into_iter().filter(|n| !renamed.contains(n) && !judge.names.all.contains(n)).collect()
    };
    let judge = Judge { removed, ..judge };
    // The code's names are read here, before the parallel judging, whenever any file judged could need them: forced
    // from inside it, the reading's own parallel work could hand this thread a file that waits on the same reading.
    if whole || request.added.as_ref().is_some_and(|a| a.keys().any(|f| is_prose(f) || is_c_like(f) || is_hash_like(f))) {
        LazyLock::force(&judge.names);
    }
    // Judging a change, an unchanged file is read only when it could name what the change took away.
    let gone_words: Vec<&str> =
        gone.keys().map(|g| g.rsplit('/').next().unwrap_or(g)).chain(judge.removed.iter().map(String::as_str)).collect();
    let added_files: HashSet<&String> = request.added.as_ref().map(|a| a.keys().collect()).unwrap_or_default();
    let read: Vec<Vec<Found>> = own
        .par_iter()
        .filter(|f| (is_prose(f) || is_c_like(f) || is_hash_like(f)) && !FIXTURE.is_match(f) && !is_built(f))
        .filter(|f| !(whole && is_record(f)))
        .filter_map(|f| {
            let src = text::read(&request.root, f)?;
            let touched = added_files.contains(f);
            if !whole && !touched && !gone_words.iter().any(|w| src.contains(w)) {
                return None;
            }
            let mentions = if is_prose(f) { markdown(&src) } else { comments(f, &src) };
            let lines = Lines::new(&src);
            let (record, plan) = (is_record(f), is_plan(f) || is_prose(f) && planned(&src));
            let mut out = vec![];
            // The code names the file's judged references give, and those the repository lacks.
            let (mut names, mut unknown) = (HashSet::new(), HashSet::new());
            // How many paths and links it gives are judged.
            let mut paths = 0;
            for m in &mentions {
                let line = lines.line(m.at);
                let judged = whole || request.changed(f, line);
                if (!judged && record) || (plan && matches!(m.kind, Kind::Name | Kind::Path | Kind::Script | Kind::Job)) {
                    continue;
                }
                let place = format!("{f}:{line}");
                let sentence = sentence_at(&src, m.at);
                let mut soft = false;
                // A code name is judged on a change only when the change removed it from the code: that is history
                // saying it was the code's. Every other missing name is listed when judging everything.
                let message = if judged && (whole || m.kind != Kind::Name) {
                    let verdict = judge.check(f, m, &place);
                    paths += usize::from(matches!(m.kind, Kind::Path | Kind::Link));
                    match verdict {
                        Verdict::Missing(message, path) => {
                            if m.kind == Kind::Name {
                                unknown.insert(name_of(&m.text).unwrap_or(&m.text).to_string());
                            }
                            // The sentence is about the past, or gives the name as an example or something to build:
                            // what it names may be gone, or not there yet. A path's history says which, on the Node side.
                            // After `cd` into a folder that is not here, the script is another checkout's.
                            if m.kind == Kind::Script
                                && CD.captures(sentence).is_some_and(|c| judge.paths.find(&c[1], f, &request.prefix).is_none())
                            {
                                continue;
                            }
                            // A table row or a line that maps a name to other code (another library's name to this
                            // one's, the old to the new, a name to its file) is about one side, and which only the
                            // reader knows.
                            let row = line_at(&src, m.at);
                            let at = m.at - (row.as_ptr() as usize - src.as_ptr() as usize);
                            let cell = row[..at].matches('|').count();
                            let mapped = row.trim_start().starts_with('|')
                                && row.split('|').enumerate().any(|(i, c)| i != cell && c.contains('`'))
                                || row.contains("` → `")
                                || row.contains("` -> `");
                            if m.kind == Kind::Name && mapped {
                                continue;
                            }
                            let said = wording(sentence);
                            let excused = m.kind != Kind::Link && HISTORY.is_match(&said)
                                || m.kind == Kind::Name && (EXAMPLE.is_match(&said) || FUTURE.is_match(&said));
                            soft = m.kind == Kind::Path && judge.soft(&m.text, f, &said);
                            (!excused).then_some((message, path))
                        }
                        Verdict::Fine => None,
                    }
                } else {
                    judge.broken_by_change(f, m, &place).filter(|_| !HISTORY.is_match(&wording(sentence))).map(|message| (message, None))
                };
                if m.kind == Kind::Name && judged && code_shaped(name_of(&m.text).unwrap_or(&m.text), f) {
                    names.insert(name_of(&m.text).unwrap_or(&m.text).to_string());
                }
                if let Some((message, path)) = message {
                    let target = format!("references:{f}:{}", m.text);
                    out.push(Found {
                        target: target.clone(),
                        finding: Finding { file: f.clone(), line, target, message },
                        path,
                        kind: m.kind,
                        soft,
                        paths: 0,
                    });
                }
            }
            // Two in five of its code names or more are not this repository's: the file is about something else (a
            // vendor's API, another project, a naming convention), and its names are not judged one by one.
            if names.len() >= 8 && unknown.len() * 5 > names.len() * 2 {
                out.retain(|found| found.kind != Kind::Name);
            }
            // How many paths it gives, for the Node side: one whose paths are mostly stale gets one finding.
            for found in &mut out {
                found.paths = paths;
            }
            Some(out)
        })
        .collect();
    let files_read = read.len();
    let found: Vec<Found> = read.into_iter().flatten().collect();
    // Judging everything, each plan and record is judged whole: what it says of itself, and how much of what it names
    // is still there. Its lines are not judged one by one (what it named was true when it was written).
    let docs: serde_json::Map<String, serde_json::Value> = if !whole {
        serde_json::Map::new()
    } else {
        own.par_iter()
            // A folder's README or index lists its records; it is not one of them.
            .filter(|f| {
                !matches!(
                    f.rsplit('/').next().unwrap_or(f).to_ascii_lowercase().as_str(),
                    "readme.md" | "readme.mdx" | "index.md" | "index.mdx"
                )
            })
            .filter(|f| is_prose(f) && !kept_on_purpose(f) && !FIXTURE.is_match(f) && !is_built(f))
            .filter_map(|f| {
                let src = text::read(&request.root, f)?;
                let planned = planned(&src);
                if !(is_record(f) || is_plan(f) || planned) {
                    return None;
                }
                let (mut there, mut missing) = (BTreeSet::new(), BTreeSet::new());
                for m in markdown(&src).iter().filter(|m| matches!(m.kind, Kind::Path | Kind::Link)) {
                    match judge.standing(f, m) {
                        Some(Ok(())) => {
                            there.insert(m.text.clone());
                        }
                        Some(Err(path)) => {
                            missing.insert(path);
                        }
                        None => {}
                    }
                }
                let done = finished(f, &src);
                (done.is_some() || missing.len() >= 3).then(|| {
                    (
                        f.clone(),
                        serde_json::json!({ "kind": record_kind(f, planned), "there": there.len(), "missing": missing, "done": done }),
                    )
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .collect()
    };
    // For the Node side: each reference's count and, for a path, the path git history is asked about, whether the
    // prose asserts it, and how many paths its file gives.
    let mut refs = serde_json::Map::new();
    let mut merged = vec![];
    for f in found {
        let entry = refs.entry(f.target.clone()).or_insert_with(|| serde_json::json!({ "count": 0 }));
        entry["count"] = (entry["count"].as_u64().unwrap_or(0) + 1).into();
        if let Some(path) = &f.path {
            entry["path"] = path.clone().into();
            entry["link"] = (f.kind == Kind::Link).into();
            entry["soft"] = f.soft.into();
            entry["paths"] = f.paths.into();
        }
        merged.push((f.target, f.finding));
    }
    let findings = first_per_key(merged, |message, more| format!("{message} (and {more} more in this file)"));
    let mut answer = Answer::new(findings, format!("{files_read} files of prose and comments read"));
    answer.data = Some(serde_json::json!({ "refs": refs, "docs": docs }));
    Ok(answer)
}

/// One reference that points at nothing, before findings of the same target in a file are merged.
struct Found {
    target: String,
    finding: Finding,
    /// For a path or link, the path git history is asked about.
    path: Option<String>,
    kind: Kind,
    /// A path the prose does not assert (an example, something to build, a dot folder the repository lacks).
    soft: bool,
    /// How many paths and links its file gives that were judged.
    paths: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(found: &[Mention]) -> Vec<(&str, Kind)> {
        found.iter().map(|m| (m.text.as_str(), m.kind)).collect()
    }

    #[test]
    fn markdown_reads_code_spans_links_bare_paths_and_shell_blocks_but_not_examples() {
        let src = "# Setup\n\nRun `npm run build`, then read `docs/setup.md` and [the guide](guide/start.md#install).\nSee src/lib/errors.ts:12 and call `fetchOrders()`.\n<!-- `hidden/path.md` -->\n\n```bash\n$ cd backend && bash scripts/check.sh\n```\n\n```ts\nimport x from './made-up.ts';\n```\n";
        let got = markdown(src);
        assert_eq!(
            texts(&got),
            vec![
                ("build", Kind::Script),
                ("docs/setup.md", Kind::Path),
                ("guide/start.md#install", Kind::Link),
                ("fetchOrders()", Kind::Name),
                ("src/lib/errors.ts", Kind::Path),
                ("backend", Kind::Path),
                ("scripts/check.sh", Kind::Path),
            ]
        );
        assert_eq!(&src[got[1].at..got[1].at + 13], "docs/setup.md");
    }

    #[test]
    fn a_job_is_what_the_sentence_calls_one() {
        let got = markdown("The `Intersite backend lint and gates` job in pr-checks.yml runs it, and so does job `gate`.\nA customer's `pending` job waits for a Pro.\nFailed actions add one `client_error_reported` step to the event.\n");
        assert_eq!(
            texts(&got),
            vec![
                ("Intersite backend lint and gates", Kind::Job),
                ("gate", Kind::Job),
                ("pending", Kind::Name),
                ("client_error_reported", Kind::Name)
            ]
        );
    }

    #[test]
    fn comments_give_their_references_and_strings_their_scripts() {
        let src = "// See `src/lib/errors.ts` and {@link loadOrders}.\nconst a = '// not a comment';\nthrow new Error('run npm run db:generate first');\n";
        assert_eq!(
            texts(&comments("a.ts", src)),
            vec![("src/lib/errors.ts", Kind::Path), ("loadOrders", Kind::Name), ("db:generate", Kind::Script)]
        );
        assert_eq!(texts(&comments("a.yml", "on: push # runs scripts/ci.sh\nname: '#not'\n")), vec![("scripts/ci.sh", Kind::Path)]);
    }

    #[test]
    fn placeholders_urls_globs_and_aliases_are_not_paths() {
        for t in [
            "https://x.com/a.md",
            "src/**/*.ts",
            "<file>.md",
            "path/to/file.ts",
            "@/components/x",
            "~/Desktop/a.md",
            "/usr/bin/env",
            ".ts",
            "1/2",
        ] {
            assert!(!path_like(t) || placeholder(t), "{t}");
        }
        for t in ["src/lib/errors.ts", "docs/", "Internal Dashboard/src/x.tsx", "README.md", ".env.example", "app/[id]/page.tsx"] {
            assert!(path_like(t), "{t}");
        }
    }

    #[test]
    fn a_path_resolves_from_its_file_the_project_the_top_or_as_a_tail() {
        let files: Vec<String> = ["app/src/lib/errors.ts", "app/docs/guide.md", "README.md"].iter().map(|s| s.to_string()).collect();
        let p = Paths::new(files.iter());
        assert_eq!(p.find("../src/lib/errors.ts", "app/docs/guide.md", "app/"), Some("app/src/lib/errors.ts".into()));
        assert_eq!(p.find("src/lib/errors.ts", "README.md", "app/"), Some("app/src/lib/errors.ts".into()));
        assert_eq!(p.find("lib/errors.ts:12", "README.md", ""), Some("app/src/lib/errors.ts".into()));
        assert_eq!(p.find("lib", "README.md", ""), Some("app/src/lib".into()));
        assert_eq!(p.find("errors.ts", "README.md", ""), Some("app/src/lib/errors.ts".into()));
        assert_eq!(p.find("src/lib/missing.ts", "README.md", "app/"), None);
        assert_eq!(p.find("rc/lib/errors.ts", "README.md", ""), None);
    }

    #[test]
    fn anchors_are_github_slugs() {
        let a = anchors("# Getting `started`\n## The [API](x.md) & more\n## Setup\n## Setup\n<a name=\"custom\"></a>\n\nOverview\n========\n\nUsage <b>now</b>\n---\n\n## `Option<T>`\n\n- a list\n---\n");
        assert!(!a.contains("a-list") && !a.contains("-a-list"), "{a:?}");
        for s in ["getting-started", "the-api--more", "setup", "setup-1", "custom", "overview", "usage-now", "optiont"] {
            assert!(a.contains(s), "{s}: {a:?}");
        }
    }

    #[test]
    fn records_are_changelogs_dated_notes_decisions_audits_and_archives() {
        for f in [
            "CHANGELOG.md",
            "docs/plans/PLAN_2026-09-04.md",
            "docs/archive/old.md",
            "notes/20260904-sync.md",
            "docs/decisions/005-gates.md",
            "docs/TIMEZONE_AUDIT_2026-07.md",
            "docs/RELEASE_NOTES.md",
            "scripts/2026-09-04-backfill.ts",
        ] {
            assert!(is_record(f), "{f}");
        }
        for f in ["README.md", ".cursor/rules/a.mdc", "docs/RELEASE.md", "src/lib/audit/log.ts", "docs/v2/setup.md"] {
            assert!(!is_record(f), "{f}");
        }
        assert!(is_plan("docs/phase-5b/02-web-funnel.md") && is_plan("docs/todo/inbox.md") && !is_plan("docs/architecture.md"));
        // Named otherwise, a plan, survey or dated report is known by its first lines.
        for src in [
            "# Repository layout move: mapping, change list and move plan\n",
            "# Layout\n\nPrepared 2026-11-24 on branch `shipmas` (read-only survey).\n",
            "# Lucra API — target surface\n",
            "# Shipmas browser QA (2026-11-25)\n",
        ] {
            assert!(planned(src), "{src}");
        }
        assert!(!planned("# Architecture\n\nThe plan below is how requests flow.\n") && !planned("# Icons\n"));
    }

    #[test]
    fn a_plan_or_record_says_when_its_work_is_over() {
        assert_eq!(finished("docs/plans/x.md", "# X\n**Status:** shipped\n").as_deref(), Some("its status is shipped"));
        assert_eq!(finished("docs/plans/x.md", "# X\nStatus: implemented; not deployed\n"), None);
        assert_eq!(finished("docs/decisions/005-x.md", "# X\nStatus: implemented\n"), None, "a decision in force still guides the code");
        assert_eq!(finished("docs/decisions/005-x.md", "# X\n> Superseded by ADR 12\n").as_deref(), Some("it says it is superseded"));
        assert_eq!(finished("docs/plans/x.md", "# X\nThe old flow was superseded by the queue.\n"), None);
        assert_eq!(finished("docs/plans/x.md", "- [x] a\n- [x] b\n1. [X] c\n").as_deref(), Some("all 3 of its checkboxes are ticked"));
        assert_eq!(finished("docs/plans/x.md", "- [x] a\n- [x] b\n- [x] c\n- [ ] d\n"), None);
        assert!(kept_on_purpose("CHANGELOG.md") && kept_on_purpose("docs/archive/2026-01-plan.md") && !kept_on_purpose("docs/audits/x.md"));
        assert_eq!(record_kind("docs/decisions/005-x.md", false), "a decision record");
        assert_eq!(record_kind("docs/audits/STORE_AUDIT_2026-09-05.md", false), "an audit or report");
    }

    #[test]
    fn commands_usage_lines_and_commented_settings_are_not_references() {
        let got = markdown("Run `npx tsx scripts/check.ts`, `ls docs/` and `git log -- src/lib`.\n");
        assert_eq!(texts(&got), vec![("scripts/check.ts", Kind::Path)]);
        assert!(comments("a.ts", "/**\n * Usage:\n *   --out reports/2026/run.md \\\n */\n").is_empty());
        assert!(comments("config.toml", "# keys_path = \"./keys/signing.json\"\n").is_empty());
        assert!(comments("a.ts", "throw new Error('cd backend && npm run dev');\n").is_empty());
    }

    #[test]
    fn a_sentence_is_read_without_what_it_quotes_and_with_the_line_it_wraps_from() {
        assert!(!HISTORY.is_match(&wording("See `src/lib/old.ts` and src/legacy/gone.ts.")));
        assert!(HISTORY.is_match(&wording("`parse()` was in `src/lib/parser.ts`.")));
        let wrapped = "never copy the schema into\n`supabase/migrations`.\n";
        assert_eq!(sentence_at(wrapped, wrapped.find('`').unwrap()), wrapped.trim_end());
        assert_eq!(sentence_at("a\nsee `x/y.md` here\n", 6), "see `x/y.md` here");
        assert!(is_instructions("CLAUDE.md") && is_instructions(".cursor/rules/api.mdc") && !is_instructions("docs/guide.md"));
        // A list wrapped over lines is read from the line its sentence starts on.
        let list = "Release 2a deletes the schema files: `a.ts`,\n`b.ts`, `c.ts`,\n`d.ts` and `e.ts`.\n";
        assert!(HISTORY.is_match(&wording(sentence_at(list, list.find("`e.ts`").unwrap()))));
        // What is elsewhere: on a pull request or branch, in another repository or a library.
        for said in [
            "- **`IMPROVE.md` deletion:** merged.",
            "The register (`docs/decisions.md` on the docs PR) wins.",
            "First take training out of the docs PR: the page `docs/training.mdx`.",
            "The wiring plan is `docs/WIRING.md` in the Urbanmount repo.",
            "It reads `src/x.ts` in the `backend` repo.",
            "Set `merchantIdentifier` in the Stripe plugin.",
        ] {
            assert!(HISTORY.is_match(&wording(said)), "{said}");
        }
        assert!(!HISTORY.is_match(&wording("Settings are in the repo root: `config/app.ts`.")));
    }

    #[test]
    fn only_names_shaped_like_the_codes_own_are_judged() {
        for n in ["fetchOrders", "isPlayableUrl", "AuthError", "LavaLampBackground"] {
            assert!(code_shaped(n, "docs/a.md"), "{n}");
        }
        for n in ["user_id", "MAX_RETRIES", "UIWindow", "Button", "partner", "getId"] {
            assert!(!code_shaped(n, "docs/a.md"), "{n}");
        }
        assert!(code_shaped("load_orders", "app/main.py") && !code_shaped("load_orders", "app/main.ts"));
        // An id is not a name: a Figma file key.
        assert!(!code_shaped("rstqrLfXy9hi6oLQX3aFHt", "docs/a.md") && code_shaped("Notification01Icon", "docs/a.md"));
    }

    #[test]
    fn a_path_is_judged_only_where_a_reader_would_look_for_it() {
        let files: Vec<String> = [
            "app/src/lib/orders/holds.ts",
            "app/src/lib/user/admin.ts",
            "app/docs/guide.md",
            "legacy/apis/Admin  Web App/get.xs",
            "README.md",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let p = Paths::new(files.iter());
        // A route starts at no folder near the file; a path from the project root does.
        assert!(
            !p.near_dir("user", "app/src/lib/user/admin.ts", "app/")
                && p.near_dir("src", "app/docs/guide.md", "app/")
                && p.near_dir("orders", "app/src/lib/list.ts", "app/")
        );
        // Prose collapses a run of spaces; the file is still found.
        assert_eq!(p.find("apis/Admin Web App/get.xs", "README.md", ""), Some("legacy/apis/Admin  Web App/get.xs".into()));
        // A stem alone is no sign of where a file went; a stem with its folder is.
        assert_eq!(p.moved("orders/holds"), Some(&"app/src/lib/orders/holds.ts".to_string()));
        assert_eq!(p.moved("knowledge/holds"), None);
        assert!(Judge::outside("../../other/x.md", "docs/a.md") && !Judge::outside("../src/x.ts", "docs/a.md"));
        assert!(!path_like("intersite replay --metrics-out .intersite/m.json") && !path_like("contractor/profile.ts sendEmailOtp"));
    }
}
