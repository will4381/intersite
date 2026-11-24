//! Change hygiene: leftover files a change added (backups, copies, scratch scripts, logs, working notes), test files
//! that lost tests or assertions or gained skips, and dependencies a package.json gained. The Node side lists the
//! changes and matches the config's globs; the reading and judging is here.

use fancy_regex::Regex as Fancy;
use regex::Regex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::{Answer, Finding, Request};

/// The same text with the inside of comments and string literals replaced by spaces, newlines and columns kept.
pub fn strip_code(text: &str) -> String {
    // ponytail: regex literals and template ${} expressions are not understood, a tokenizer if that bites
    let chars: Vec<char> = text.chars().collect();
    // Each UTF-16 unit becomes a space, as JavaScript blanks them, so columns agree with the JavaScript's offsets.
    let blank = |s: &[char]| s.iter().map(|&c| if c == '\n' { "\n".to_string() } else { " ".repeat(c.len_utf16()) }).collect::<String>();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let (mut end, mut keep) = (None, 0);
        if c == '/' && next == Some('/') {
            end = Some(chars[i..].iter().position(|&x| x == '\n').map_or(chars.len(), |p| i + p));
        } else if c == '/' && next == Some('*') {
            let close = (i + 2..chars.len().saturating_sub(1)).find(|&j| chars[j] == '*' && chars[j + 1] == '/');
            end = Some(close.map_or(chars.len(), |j| j + 2));
        } else if c == '"' || c == '\'' || c == '`' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != c && (c == '`' || chars[j] != '\n') {
                j += if chars[j] == '\\' { 2 } else { 1 };
            }
            end = Some((j + 1).min(chars.len()));
            keep = 1;
        }
        match end {
            None => {
                out.push(c);
                i += 1;
            }
            Some(e) => {
                let closes = keep == 1 && e > 0 && chars[e - 1] == c && e - 1 > i;
                let inner_end = if keep == 1 && chars[e - 1] == c { e - 1 } else { e };
                if keep == 1 {
                    out.push(c);
                }
                out.push_str(&blank(&chars[(i + keep).min(inner_end)..inner_end]));
                if closes {
                    out.push(c);
                }
                i = e;
            }
        }
    }
    out
}

static TESTS: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?<![.\w$])(?:t\.)?(?:it|test)(?:\.(?:each|only|concurrent|skip|todo))?\s*\(").unwrap());
static ASSERTS: LazyLock<Fancy> = LazyLock::new(|| {
    Fancy::new(r"(?<![.\w$])(?:expect|assert)\s*\(|(?<![.\w$])fc\.assert\s*\(|(?<![.\w$])assert\.\w+\s*\(|(?<![.\w$])t\.(?:is|not|true|false|truthy|falsy|deepEqual|notDeepEqual|like|regex|throws|throwsAsync|notThrows|notThrowsAsync|snapshot|pass|fail|assert|equal|ok)\b").unwrap()
});
/// Tests that will not run, or not as written: skipped, todo, focused (`.only` runs nothing else), skipped on a
/// condition, or inverted (`it.fails` passes when its body fails).
static SKIPS: LazyLock<Fancy> = LazyLock::new(|| {
    Fancy::new(r"(?<![.\w$])(?:(?:it|test|describe|suite|context|t)\.(?:skip|todo|only|fixme|fails|skipIf|runIf)\b|[xf](?:it|test|describe)\s*\(|(?:skip|todo|only)\s*:)").unwrap()
});

fn count(re: &Fancy, text: &str) -> usize {
    re.find_iter(text).filter(|m| m.is_ok()).count()
}

/// Tests, assertions, and skips or todos in a test file.
pub fn test_counts(text: &str) -> (usize, usize, usize) {
    let code = strip_code(text);
    (count(&TESTS, &code), count(&ASSERTS, &code), count(&SKIPS, &code))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestChange {
    path: String,
    status: String,
    before: Option<String>,
    now: Option<String>,
}

/// Test files that lost tests or assertions, or gained skips, or were deleted.
pub fn tests(request: &Request) -> Result<Answer, String> {
    let changes: Vec<TestChange> = serde_json::from_value(request.options["changes"].clone()).map_err(|e| e.to_string())?;
    let since = request.options["since"].as_str().unwrap_or("base");
    let mut findings = Vec::new();
    for c in &changes {
        if c.status == "D" {
            findings.push(Finding { file: c.path.clone(), line: 0, target: c.path.clone(), message: format!("{}: test file deleted", c.path) });
            continue;
        }
        let was = test_counts(c.before.as_deref().unwrap_or(""));
        let now = test_counts(c.now.as_deref().unwrap_or(""));
        let mut lost = Vec::new();
        if now.0 < was.0 {
            lost.push(format!("tests {} → {}", was.0, now.0));
        }
        if now.1 < was.1 {
            lost.push(format!("assertions {} → {}", was.1, now.1));
        }
        if now.2 > was.2 {
            lost.push(format!("skipped, focused or inverted tests {} → {}", was.2, now.2));
        }
        if !lost.is_empty() {
            findings.push(Finding { file: c.path.clone(), line: 0, target: c.path.clone(), message: format!("{}: {} since {since}", c.path, lost.join(", ")) });
        }
    }
    Ok(Answer { findings, summary: format!("{} changed test files checked", changes.len()), data: None })
}

/// Every dependency name in any `*dependencies` section of a package.json.
fn dependency_names(text: &str, place: &str) -> Result<Vec<String>, String> {
    Ok(dependencies(text, place)?.into_iter().map(|(name, _)| name).collect())
}

/// Every dependency in any `*dependencies` section of a package.json, with its version spec, first mention kept.
fn dependencies(text: &str, place: &str) -> Result<Vec<(String, String)>, String> {
    if text.is_empty() {
        return Ok(vec![]);
    }
    let pkg: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("{place} is not valid JSON: {e}"))?;
    let mut out: Vec<(String, String)> = Vec::new();
    for (key, value) in pkg.as_object().into_iter().flatten() {
        if key.to_lowercase().ends_with("dependencies") {
            for (name, spec) in value.as_object().into_iter().flatten() {
                if !out.iter().any(|(n, _)| n == name) {
                    out.push((name.clone(), spec.as_str().unwrap_or("").to_string()));
                }
            }
        }
    }
    Ok(out)
}

/// The npm package a dependency installs, or None when it comes from elsewhere (the workspace, a path, git, a URL)
/// or from a scope a private registry serves. `npm:` aliases install the aliased name.
fn npm_name(name: &str, spec: &str, private: &[String]) -> Option<String> {
    let real = match spec.strip_prefix("npm:") {
        Some(alias) => alias.rsplit_once('@').filter(|(n, _)| !n.is_empty()).map_or(alias, |(n, _)| n).to_string(),
        None if ["workspace:", "file:", "link:", "portal:", "patch:", "git", "github:", "gitlab:", "bitbucket:", "http:", "https:"].iter().any(|p| spec.starts_with(p)) || spec.contains('/') => return None,
        None => name.to_string(),
    };
    (!private.iter().any(|scope| real.starts_with(&format!("{scope}/")))).then_some(real)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageChange {
    path: String,
    before_place: String,
    before: String,
    now: String,
}

/// Dependencies a package.json gained, each checked against the npm registry when one is given: a name the registry
/// has never heard of is invented, and a package days old or with a version or two deserves a second look.
pub fn new_deps(request: &Request) -> Result<Answer, String> {
    let changes: Vec<PackageChange> = serde_json::from_value(request.options["changes"].clone()).map_err(|e| e.to_string())?;
    let registry = request.options["registry"].as_str().unwrap_or("");
    let private: Vec<String> = serde_json::from_value(request.options["privateScopes"].clone()).unwrap_or_default();
    let mut added = Vec::new();
    for c in &changes {
        let was: HashSet<String> = dependency_names(&c.before, &c.before_place)?.into_iter().collect();
        for (name, spec) in dependencies(&c.now, &c.path)? {
            if !was.contains(&name) {
                added.push((c.path.clone(), npm_name(&name, &spec, &private), name));
            }
        }
    }
    let mut asked: Vec<String> = added.iter().filter_map(|(_, npm, _)| npm.clone()).collect();
    asked.sort();
    asked.dedup();
    let known = crate::registry::lookup_all(registry, &asked);
    let mut findings = Vec::new();
    for (path, npm, name) in added {
        let message = match npm.as_ref().and_then(|n| known.get(n).map(|k| (n, k))) {
            Some((real, crate::registry::Known::Missing)) => {
                findings.push(Finding { file: path.clone(), line: 0, target: format!("npm-missing:{real}"), message: format!("{path}: \"{real}\" does not exist on npm: an invented package name that anyone can register later with malware; remove it, and find the real package or write the few lines yourself") });
                continue;
            }
            Some((_, crate::registry::Known::Found { versions, days })) if *versions <= 3 || days.is_some_and(|d| d < 60) => {
                let age = days.map_or(String::new(), |d| format!("first published {d} days ago, "));
                format!("{path}: new dependency \"{name}\" ({age}{versions} version{}): make sure it is the package you meant and that it is needed, or use what is already installed", if *versions == 1 { "" } else { "s" })
            }
            _ => format!("{path}: new dependency \"{name}\": check it exists and is needed, or use what is already installed"),
        };
        findings.push(Finding { file: path, line: 0, target: name, message });
    }
    let summary = if registry.is_empty() || asked.is_empty() { String::new() } else { format!("{} of {} new npm packages checked against the registry", known.len(), asked.len()) };
    Ok(Answer { findings, summary, data: None })
}

/// A semantic mutant as the gate applies it: the cut's text replaced, offsets in UTF-16 units.
fn cut_json(path: &str, text: &str, c: &crate::functions::Cut, shown: String, within: Vec<String>) -> serde_json::Value {
    let at = crate::functions::utf16(text, c.start);
    let length = text[c.start as usize..c.end as usize].encode_utf16().count();
    serde_json::json!({ "kind": "cut", "label": c.label, "path": path, "line": c.line, "at": at, "length": length, "from": shown, "to": c.to, "within": within })
}

/// Takes one item from each list in turn, so the first items are spread across every list.
fn interleave<T: Clone>(lists: &[Vec<T>]) -> Vec<T> {
    let mut out = Vec::new();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
    for i in 0..longest {
        for l in lists {
            if let Some(x) = l.get(i) {
                out.push(x.clone());
            }
        }
    }
    out
}

/// The mutants to try, after Google's mutation testing in code review: for each changed function, its body removed (a
/// function no test notices losing is covered but not checked), then one mutant per added line: a semantic cut (an
/// access check, a tenant filter, an idempotency or state guard, a cache invalidation) before an operator flip, and a
/// plain guard or an error fallback rethrown after it, never inside logging, telemetry, thrown errors, joined text or
/// types. Bodies first, spread across files, at most `max`. Each
/// mutant names the functions around it, so once one's body survives nothing inside it is tried. Offsets and lengths
/// are in UTF-16 units, as the JavaScript that applies them counts.
pub fn mutants(request: &Request) -> Result<Answer, String> {
    let files: Vec<(String, Vec<u32>)> = serde_json::from_value(request.options["files"].clone()).map_err(|e| e.to_string())?;
    let max = request.options["max"].as_u64().unwrap_or(10) as usize;
    let mut per_file: Vec<Vec<serde_json::Value>> = Vec::new();
    for (path, lines) in &files {
        let text = std::fs::read_to_string(std::path::Path::new(&request.root).join(path)).unwrap_or_default();
        let Some(shape) = crate::functions::read(path, &text) else { continue };
        let wanted: HashSet<u32> = lines.iter().copied().collect();
        let key = |i: usize| format!("{path}:{i}");
        let within = |at: u32, skip: Option<usize>| -> Vec<String> {
            shape.funcs.iter().enumerate().filter(|(j, f)| Some(*j) != skip && f.body.0 <= at && at < f.body.1).map(|(j, _)| key(j)).collect()
        };
        let mut list = Vec::new();
        for (i, f) in shape.funcs.iter().enumerate() {
            if f.empty || !(f.line..=f.end_line).any(|l| wanted.contains(&l)) {
                continue;
            }
            let at = crate::functions::utf16(&text, f.body.0);
            let length = text[f.body.0 as usize..f.body.1 as usize].encode_utf16().count();
            let to = if f.expression_body { "undefined" } else { "{}" };
            list.push(serde_json::json!({ "kind": "body", "path": path, "line": f.line, "name": f.name, "at": at, "length": length, "from": "", "to": to, "key": key(i), "within": within(f.body.0, Some(i)) }));
        }
        // One mutant per line: a semantic cut first, then the best operator flip, then a plain guard or error fallback.
        let snippet = |start: usize, end: usize| -> String { text[start..end].lines().next().unwrap_or("").trim().chars().take(80).collect() };
        let mut taken: HashSet<u32> = HashSet::new();
        let mut later = Vec::new();
        let cuts: Vec<&crate::functions::Cut> = shape.cuts.iter().filter(|c| wanted.contains(&c.line)).collect();
        for c in cuts.iter().filter(|c| c.first()) {
            if taken.insert(c.line) {
                list.push(cut_json(path, &text, c, snippet(c.start as usize, c.end as usize), within(c.start, None)));
            }
        }
        let mut best: HashMap<u32, &crate::functions::Site> = HashMap::new();
        for site in shape.sites.iter().filter(|s| wanted.contains(&s.line) && !taken.contains(&s.line)) {
            let slot = best.entry(site.line).or_insert(site);
            if site.rank < slot.rank {
                *slot = site;
            }
        }
        let mut sites: Vec<&crate::functions::Site> = best.into_values().collect();
        sites.sort_by_key(|s| s.start);
        for s in sites {
            taken.insert(s.line);
            let line_start = text[..s.start as usize].rfind('\n').map_or(0, |i| i + 1);
            let line_end = text[s.start as usize..].find('\n').map_or(text.len(), |i| s.start as usize + i);
            let mutated = format!("{}{}{}", &text[line_start..s.start as usize], s.to, &text[s.start as usize + s.from.len()..line_end]);
            let shown: String = mutated.trim().chars().take(100).collect();
            let at = crate::functions::utf16(&text, s.start);
            list.push(serde_json::json!({ "kind": "operator", "path": path, "line": s.line, "at": at, "length": s.from.encode_utf16().count(), "from": s.from, "to": s.to, "text": shown, "within": within(s.start, None) }));
        }
        for c in cuts.iter().filter(|c| !c.first()) {
            if taken.insert(c.line) {
                later.push(cut_json(path, &text, c, snippet(c.start as usize, c.end as usize), within(c.start, None)));
            }
        }
        list.extend(later);
        per_file.push(list);
    }
    let chosen: Vec<serde_json::Value> = interleave(&per_file).into_iter().take(max).collect();
    Ok(Answer { findings: vec![], summary: String::new(), data: Some(serde_json::Value::Array(chosen)) })
}

static BACKUP_EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:bak|orig|rej|tmp|swp)$|~$").unwrap());
/// A copy's name: the plain name plus a suffix, reported only when a file with the plain name shares most of its lines.
static COPY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(.+?)(?:[._ -](?:old|backup|bak|copy|orig|new|final|fixed|v\d+)| copy(?: \d+)?| \(\d+\))$").unwrap());
// ponytail: scratch names and output dumps count only at the project's top; treat every package root as one if needed
static SCRATCH: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?i)^(?:scratch|(?:tmp|temp|debug|try)(?![a-z]))|^test-.*\.(?:[cm]?[jt]s|py|sh)$").unwrap());
static SCRATCH_DIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:tmp|temp|scratch)/").unwrap());
static LOG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:log|dump)$").unwrap());
static ROOT_OUTPUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:output.*\.txt|out\.json|response.*\.json)$").unwrap());
static NOTE: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?i)^(?:plan|summary|notes|todo|analysis|findings|report|changes|migration[_-]guide|(?:implementation|refactor)[\w-]*|fix(?:es)?(?![a-z])[\w-]*|[\w-]+[_-](?:summary|plan|report))\.(?:md|markdown)$").unwrap());
static DOC_DIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:docs?|documentation|wiki|adrs?|rfcs?|notes|specs?)$").unwrap());

fn no_ext(path: &str) -> &str {
    let start = path.rfind('/').map_or(0, |i| i + 1);
    match path[start..].rfind('.') {
        Some(i) if i > 0 && start + i + 1 < path.len() => &path[..start + i],
        _ => path,
    }
}

fn lines(text: &str) -> Vec<&str> {
    text.split('\n').map(str::trim).filter(|l| !l.is_empty()).collect()
}

/// Whether most of `text`, by characters of its non-blank lines, appears line for line in one of `originals`.
fn copies(text: &str, originals: &[String]) -> bool {
    // ponytail: binary files are never called copies, compare bytes if copied images matter
    if text.contains('\0') {
        return false;
    }
    let mine = lines(text);
    let size = |list: &[&str]| list.iter().map(|l| l.encode_utf16().count()).sum::<usize>();
    originals.iter().any(|o| {
        let theirs: HashSet<&str> = lines(o).into_iter().collect();
        !theirs.is_empty() && size(&mine.iter().copied().filter(|l| theirs.contains(l)).collect::<Vec<_>>()) * 2 >= size(&mine)
    })
}

fn git_show(cwd: &str, sha: &str, path: &str) -> String {
    std::process::Command::new("git").args(["show", &format!("{sha}:./{path}")]).current_dir(cwd).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

fn fancy(re: &Fancy, s: &str) -> bool {
    re.is_match(s).unwrap_or(false)
}

/// Leftover files the change added.
pub fn artifacts(request: &Request) -> Result<Answer, String> {
    let get = |k: &str| -> Vec<String> { serde_json::from_value(request.options[k].clone()).unwrap_or_default() };
    let (added, was, now) = (get("added"), get("was"), get("now"));
    let in_tests: HashSet<String> = get("inTests").into_iter().collect();
    let extra: HashSet<String> = get("matchesExtra").into_iter().collect();
    let sha = request.options["sha"].as_str().unwrap_or("");
    let root = &request.root;
    let current: HashSet<&str> = now.iter().map(String::as_str).collect();
    let existed: HashSet<&str> = was.iter().map(String::as_str).collect();
    let plain_names: HashMap<&str, &str> = was.iter().chain(now.iter()).map(|f| (no_ext(f), f.as_str())).collect();
    let docs = was.iter().map(|f| f.split('/').collect::<Vec<_>>()).find(|p| p.len() > 1 && DOC_DIR.is_match(p[0])).map(|p| p[0].to_string());
    let read = |p: &str| std::fs::read_to_string(std::path::Path::new(root).join(p)).unwrap_or_default();
    let mut findings = Vec::new();
    for path in &added {
        let (dir, name) = match path.rfind('/') {
            Some(i) => (&path[..i], &path[i + 1..]),
            None => (".", path.as_str()),
        };
        let join = |d: &str, n: &str| if d == "." { n.to_string() } else { format!("{d}/{n}") };
        let ext = name.rfind('.').filter(|&i| i > 0).map_or("", |i| &name[i..]);
        let plain = COPY.captures(no_ext(name)).map(|c| c[1].to_string());
        let sibling: Option<String> = plain.as_ref().and_then(|p| {
            let same = join(dir, &format!("{p}{ext}"));
            if current.contains(same.as_str()) || existed.contains(same.as_str()) { Some(same) } else { plain_names.get(join(dir, p).as_str()).map(|s| s.to_string()) }
        });
        let copy = || {
            let Some(sib) = &sibling else { return false };
            let original = if current.contains(sib.as_str()) { read(sib) } else { String::new() };
            // Code split out of a file and imported back by it is a new module, not a copy.
            !original.contains(no_ext(name)) && copies(&read(path), &[original.clone(), git_show(root, sha, sib)])
        };
        // ponytail: any folder named like docs counts, even one the change created, because projects keep plans there
        let in_docs = path.split('/').rev().skip(1).any(|seg| DOC_DIR.is_match(seg));
        let message = if BACKUP_EXT.is_match(name) {
            Some(format!("{path} is a backup file: delete it, git keeps the history"))
        } else if !in_docs && copy() {
            Some(format!("{path} is a copy of {}: delete it, git keeps the history", sibling.clone().unwrap_or_default()))
        } else if name != ".gitkeep" && SCRATCH_DIR.is_match(path) {
            Some(format!("{path} is in a scratch folder: delete it, or move it where the project keeps real code"))
        } else if (LOG.is_match(name) && !in_docs && !in_tests.contains(path)) || (dir == "." && ROOT_OUTPUT.is_match(name)) {
            Some(format!("{path} is a log or output dump: delete it"))
        } else if dir == "." && fancy(&SCRATCH, name) {
            Some(format!("{path} is a scratch or debug file: delete it, or turn it into a real script or test"))
        } else if fancy(&NOTE, name) && !in_docs {
            Some(format!("{path} looks like a working note: delete it, or move what should last into {}", docs.as_ref().map_or("the README".to_string(), |d| format!("{d}/"))))
        } else if extra.contains(path) {
            Some(format!("{path} matches gates.artifacts: delete it"))
        } else {
            None
        };
        if let Some(message) = message {
            findings.push(Finding { file: path.clone(), line: 0, target: path.clone(), message });
        }
    }
    Ok(Answer { findings, summary: format!("{} added files checked", added.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_and_counts() {
        assert_eq!(strip_code("a('x // y') // z\nb"), "a('      ')     \nb");
        assert_eq!(strip_code("f('😀') + 1").encode_utf16().count(), "f('😀') + 1".encode_utf16().count());
        assert_eq!(test_counts("test('a', () => { expect(1).toBe(1); assert.equal(1, 1); });\nit.skip('b', () => {});"), (2, 2, 1));
        assert_eq!(no_ext("a/b.test.ts"), "a/b.test");
        assert!(copies("a\nb\nc", &["a\nb\nx".into()]));
        assert_eq!(dependency_names(r#"{"dependencies":{"a":"1"},"devDependencies":{"b":"2"}}"#, "p").unwrap(), vec!["a", "b"]);
        let private = vec!["@acme".to_string()];
        assert_eq!(npm_name("x", "^1.0.0", &private), Some("x".into()));
        assert_eq!(npm_name("x", "npm:@scope/real@^2", &private), Some("@scope/real".into()));
        assert_eq!(npm_name("x", "workspace:*", &private), None);
        assert_eq!(npm_name("x", "user/repo", &private), None);
        assert_eq!(npm_name("@acme/ui", "^1", &private), None);
    }
}
