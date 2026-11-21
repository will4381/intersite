//! The naming check: a file or folder the change adds that breaks a convention its siblings already keep (casing, a
//! shared suffix such as `*.service.ts`, the test-name pattern, or file names that match their main export). A
//! convention is whatever a clear majority of enough siblings already do, per folder and per kind of file.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::{Answer, Finding, Request};

static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:[cm]?[jt]sx?|swift|py|rb|go|rs|kts?|java|vue|svelte|astro|css|scss|less)$").unwrap());
static SKIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__|migrations|drizzle|Pods|DerivedData)/|\.min\.|\.d\.[cm]?ts$").unwrap());
/// Names a framework or tool chooses: routes, entry points, special files. Never reported, never counted.
static RESERVED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:index|page|layout|route|loading|error|not-found|global-error|template|default|head|middleware|proxy|instrumentation|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest|main|app|App|mod|lib|setup|conftest|__init__|__main__|vite-env|env|global|globals|styles?|types?|constants|utils|helpers|README|LICENSE|CHANGELOG|Package|ContentView)$").unwrap()
});
const MIN_AGREE: usize = 5;
const SHARE: f64 = 0.9;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Style {
    Word,
    Kebab,
    Snake,
    Camel,
    Pascal,
}

fn style_name(s: Style) -> &'static str {
    match s {
        Style::Kebab => "kebab-case",
        Style::Snake => "snake_case",
        Style::Camel => "camelCase",
        Style::Pascal | Style::Word => "PascalCase",
    }
}

/// The casing of a bare name: one lowercase word fits kebab, snake and camel alike.
fn style_of(stem: &str) -> Option<Style> {
    static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9]*$").unwrap());
    static KEBAB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$").unwrap());
    static SNAKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$").unwrap());
    static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9]*(?:[A-Z]+[a-z0-9]*)+$").unwrap());
    static PASCAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$").unwrap());
    [(&*WORD, Style::Word), (&*KEBAB, Style::Kebab), (&*SNAKE, Style::Snake), (&*CAMEL, Style::Camel), (&*PASCAL, Style::Pascal)].into_iter().find(|(r, _)| r.is_match(stem)).map(|(_, s)| s)
}

fn fits(style: Option<Style>, wanted: Style) -> bool {
    style == Some(wanted) || (style == Some(Style::Word) && wanted != Style::Pascal)
}

/// A name's words, lowercased: split at - and _, before a capital after a lowercase letter or digit, and before the
/// last capital of an acronym followed by a lowercase letter.
fn split_words(stem: &str) -> Vec<String> {
    let chars: Vec<char> = stem.chars().collect();
    let mut out = Vec::new();
    let mut word = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c == '-' || c == '_' {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            continue;
        }
        let prev = if i > 0 { chars[i - 1] } else { ' ' };
        let next = chars.get(i + 1).copied().unwrap_or(' ');
        let boundary = c.is_ascii_uppercase() && ((prev.is_ascii_lowercase() || prev.is_ascii_digit()) || (prev.is_ascii_uppercase() && next.is_ascii_lowercase()));
        if boundary && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        word.push(c);
    }
    if !word.is_empty() {
        out.push(word);
    }
    out.into_iter().map(|w| w.to_lowercase()).collect()
}

/// A name in another casing: `user_card` as Pascal is `UserCard`.
fn restyle(stem: &str, style: Style) -> String {
    let words = split_words(stem);
    let cap = |w: &str| {
        let mut c = w.chars();
        c.next().map_or(String::new(), |f| f.to_uppercase().collect::<String>() + c.as_str())
    };
    match style {
        Style::Kebab => words.join("-"),
        Style::Snake => words.join("_"),
        Style::Pascal => words.iter().map(|w| cap(w)).collect(),
        Style::Camel | Style::Word => words.first().cloned().unwrap_or_default() + &words.iter().skip(1).map(|w| cap(w)).collect::<String>(),
    }
}

/// A file name split into its stem, its middle parts (`service` in `user.service.ts`) and its extension.
fn parts(name: &str) -> (String, Vec<String>, String) {
    let mut dots: Vec<&str> = name.split('.').collect();
    let ext = if dots.len() > 1 { dots.pop().unwrap_or("").to_string() } else { String::new() };
    (dots[0].to_string(), dots[1..].iter().map(|s| s.to_string()).collect(), ext)
}

fn test_pattern(name: &str) -> Option<&'static str> {
    let (stem, middle, _) = parts(name);
    if middle.iter().any(|m| m == "test") {
        Some(".test")
    } else if middle.iter().any(|m| m == "spec") {
        Some(".spec")
    } else if stem.starts_with("test_") {
        Some("test_*")
    } else if stem.ends_with("_test") {
        Some("*_test")
    } else {
        None
    }
}

/// The kind of file a name is compared within: hooks, tests and each language family keep their own casing.
fn kind_of(name: &str) -> String {
    static HOOK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^use(?:[A-Z0-9]|[-_][a-z])").unwrap());
    let (stem, _, ext) = parts(name);
    if test_pattern(name).is_some() {
        "test".into()
    } else if HOOK.is_match(&stem) {
        "hook".into()
    } else if ext == "jsx" || ext == "tsx" {
        "jsx".into()
    } else if matches!(ext.as_str(), "js" | "ts" | "cjs" | "mjs" | "cts" | "mts") {
        "js".into()
    } else if matches!(ext.as_str(), "css" | "scss" | "less") {
        "css".into()
    } else {
        ext
    }
}

/// The convention a group of sibling names keeps, when a clear majority of enough of them agree.
fn convention(names: &[String]) -> Option<(Style, usize, usize)> {
    let styles: Vec<Style> = names.iter().filter_map(|n| style_of(n)).collect();
    for style in [Style::Kebab, Style::Snake, Style::Camel, Style::Pascal] {
        let agree = styles.iter().filter(|s| fits(Some(**s), style)).count();
        let decisive = styles.iter().filter(|s| **s == style).count();
        // ponytail: thresholds tuned on a corpus of 22 repositories; make them config if a project needs looser ones
        if agree >= MIN_AGREE && decisive >= 3 && agree as f64 >= SHARE * styles.len() as f64 {
            return Some((style, agree, styles.len()));
        }
    }
    None
}

fn checkable(stem: &str) -> bool {
    !stem.is_empty() && stem.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && !RESERVED.is_match(stem)
}

fn dirname(path: &str) -> &str {
    path.rfind('/').map_or(".", |i| &path[..i])
}

fn basename(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

/// Every folder's children, by kind: files of each kind and the sub-folders.
fn sibling_index(files: &[String], fresh: &HashSet<String>) -> HashMap<String, Vec<String>> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut seen_dirs = HashSet::new();
    for file in files {
        if SKIP.is_match(file) {
            continue;
        }
        let segments: Vec<&str> = file.split('/').collect();
        for i in 1..segments.len() {
            let dir = segments[..i].join("/");
            if seen_dirs.contains(&dir) || fresh.contains(&dir) {
                continue;
            }
            seen_dirs.insert(dir);
            let parent = segments[..i - 1].join("/");
            groups.entry(format!("{}\0dir", if parent.is_empty() { "." } else { &parent })).or_default().push(segments[i - 1].to_string());
        }
        if fresh.contains(file) || !CODE.is_match(file) {
            continue;
        }
        let name = segments[segments.len() - 1];
        groups.entry(format!("{}\0{}", dirname(file), kind_of(name))).or_default().push(name.to_string());
    }
    groups
}

/// The middle part (`service`) almost every name in the list shares.
fn shared_suffix(names: &[&String]) -> Option<(String, usize, usize)> {
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for n in names {
        let mut in_name = HashSet::new();
        for m in parts(n).1 {
            if !in_name.insert(m.clone()) {
                continue;
            }
            if !counts.contains_key(&m) {
                order.push(m.clone());
            }
            *counts.entry(m).or_default() += 1;
        }
    }
    for suffix in order {
        let agree = counts[&suffix];
        if !suffix.chars().all(|c| c.is_ascii_lowercase()) || suffix.is_empty() || matches!(suffix.as_str(), "module" | "stories" | "story" | "d" | "test" | "spec") {
            continue;
        }
        if agree >= MIN_AGREE && agree as f64 >= SHARE * names.len() as f64 {
            return Some((suffix, agree, names.len()));
        }
    }
    None
}

/// Casing and suffix findings for one added file name, against its siblings of the same kind.
fn check_file_name(path: &str, groups: &HashMap<String, Vec<String>>, exports: Option<&[String]>, subjects: &HashSet<String>) -> Vec<String> {
    let dir = dirname(path);
    let name = basename(path);
    let (stem, middle, ext) = parts(name);
    if !checkable(&stem) || middle.iter().any(|m| m == "config") {
        return vec![];
    }
    let kind = kind_of(name);
    let empty = Vec::new();
    let own = groups.get(&format!("{dir}\0{kind}")).unwrap_or(&empty);
    let mut out = Vec::new();
    let stems: Vec<String> = own.iter().map(|n| parts(n).0).filter(|s| checkable(s)).collect();
    let rule = convention(&stems);
    let style = style_of(&stem);
    // A file whose main export is a lowercase value is not a component, so a PascalCase folder does not bind it.
    let value_file = rule.is_some_and(|r| r.0 == Style::Pascal) && exports.is_some_and(|e| !e.is_empty() && !e.iter().any(|n| starts_capital_then_lower(n)));
    let subject = kind == "test" && [dir, dirname(dir)].iter().any(|d| subjects.contains(&format!("{d}/{stem}")));
    let digit_led = stem.split(['-', '_']).any(|w| w.starts_with(|c: char| c.is_ascii_digit()));
    if let Some((rs, agree, total)) = rule {
        if !fits(style, rs) && !value_file && !subject && !digit_led {
            let mut fixed = vec![restyle(&stem, rs)];
            fixed.extend(middle.iter().cloned());
            if !ext.is_empty() {
                fixed.push(ext.clone());
            }
            let what = if kind == "test" { "tests" } else if kind == "hook" { "hooks" } else { "files" };
            out.push(format!("{path}: this folder names {what} in {} ({agree} of {total}): rename to {}", style_name(rs), fixed.join(".")));
        }
    }
    if kind != "test" {
        let same_ext: Vec<&String> = own.iter().filter(|n| parts(n).2 == ext).collect();
        if let Some((suffix, agree, total)) = shared_suffix(&same_ext) {
            if !middle.contains(&suffix) {
                out.push(format!("{path}: files in this folder end in .{suffix}.{ext} ({agree} of {total}): rename to {stem}.{suffix}.{ext}"));
            }
        }
    }
    out
}

fn starts_capital_then_lower(n: &str) -> bool {
    let mut c = n.chars();
    matches!((c.next(), c.next()), (Some(a), Some(b)) if a.is_ascii_uppercase() && b.is_ascii_lowercase())
}

/// The name a file is about: the default export's name, or its only exported function, class or const. Swift: its only
/// top-level type.
fn main_export(text: &str, ext: &str) -> Option<String> {
    static SWIFT_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^(?:(?:public|internal|private|fileprivate|open|final)\s+)*(?:struct|class|enum|protocol|actor)\s+([A-Za-z_]\w*)").unwrap());
    static SWIFT_EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^(?:(?:public|private|fileprivate|internal)\s+)?extension\s").unwrap());
    static DEFAULT_NAMED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)|^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$").unwrap());
    static DEFAULT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^export\s+default\b").unwrap());
    static RUNTIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)").unwrap());
    if ext == "swift" {
        let types: Vec<String> = SWIFT_TYPE.captures_iter(text).map(|c| c[1].to_string()).collect();
        return (types.len() == 1 && !SWIFT_EXT.is_match(text)).then(|| types[0].clone());
    }
    if let Some(c) = DEFAULT_NAMED.captures(text) {
        return c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string());
    }
    if DEFAULT.is_match(text) {
        return None;
    }
    let runtime: Vec<String> = RUNTIME.captures_iter(text).map(|c| c[1].to_string()).collect();
    (runtime.len() == 1).then(|| runtime[0].clone())
}

/// Every exported name in a JS or TS file.
fn export_names(text: &str) -> Vec<String> {
    static EXPORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)").unwrap());
    EXPORT.captures_iter(text).map(|c| c[1].to_string()).collect()
}

/// The words of a name, lowercased and singular.
fn words_of(name: &str) -> Vec<String> {
    restyle(name, Style::Kebab)
        .split('-')
        .map(|w| {
            let b = w.as_bytes();
            let n = b.len();
            let lower = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_lowercase());
            if n >= 5 && w.ends_with("ies") && lower(n - 5) && lower(n - 4) {
                return format!("{}y", &w[..n - 3]);
            }
            if w.ends_with("es") && n >= 3 && (w[..n - 2].ends_with("ss") || w[..n - 2].ends_with('x') || w[..n - 2].ends_with("sh") || w[..n - 2].ends_with("ch")) {
                return w[..n - 2].to_string();
            }
            if n >= 4 && w.ends_with('s') && lower(n - 4) && lower(n - 3) && b[n - 2] != b's' {
                return w[..n - 1].to_string();
            }
            w.to_string()
        })
        .collect()
}

const VERB: &[&str] = &["register", "create", "make", "build", "get", "with", "to"];
const KIND: &[&str] = &["route", "rule", "page", "sheet", "view", "screen", "component", "provider", "schema", "service", "handler", "controller", "store", "extension"];

/// Whether a file is named after its export: the same letters, or every word of one (leaving out kind words and the
/// export's leading verb) is in the other, in any order.
fn named_after(stem: &str, name: &str) -> bool {
    let (a, b) = (words_of(stem), words_of(name));
    let (aj, bj) = (a.concat(), b.concat());
    if aj.contains(&bj) || bj.contains(&aj) {
        return true;
    }
    let file_core: Vec<&String> = a.iter().filter(|w| !KIND.contains(&w.as_str())).collect();
    let export_core: Vec<&String> = b.iter().enumerate().filter(|(i, w)| !KIND.contains(&w.as_str()) && !(*i == 0 && VERB.contains(&w.as_str()))).map(|(_, w)| w).collect();
    file_core.iter().all(|w| b.contains(w)) || export_core.iter().all(|w| a.contains(w))
}

fn check_export_name(path: &str, read: &mut impl FnMut(&str) -> String, groups: &HashMap<String, Vec<String>>) -> Option<String> {
    let base = basename(path);
    let (stem, _, ext) = parts(base);
    if !checkable(&stem) || !matches!(ext.as_str(), "js" | "ts" | "jsx" | "tsx" | "cjs" | "mjs" | "cts" | "mts" | "swift") {
        return None;
    }
    let name = main_export(&read(path), &ext)?;
    if name == "default" || named_after(&stem, &name) {
        return None;
    }
    let dir = dirname(path);
    let (mut agree, mut total) = (0, 0);
    for sibling in groups.get(&format!("{dir}\0{}", kind_of(base))).into_iter().flatten() {
        let (s_stem, _, s_ext) = parts(sibling);
        if !checkable(&s_stem) {
            continue;
        }
        let Some(theirs) = main_export(&read(&format!("{dir}/{sibling}")), &s_ext) else { continue };
        total += 1;
        if named_after(&s_stem, &theirs) {
            agree += 1;
        }
    }
    if agree < MIN_AGREE || (agree as f64) < SHARE * total as f64 {
        return None;
    }
    let style = style_of(&stem);
    let fixed = match style {
        Some(s) if s != Style::Word => restyle(&name, s),
        _ => name.clone(),
    };
    Some(format!("{path}: its main export is {name}, and files in this folder are named after theirs ({agree} of {total}): rename the file to {}, or the export to match the file", base.replacen(&stem, &fixed, 1)))
}

fn check_test_name(path: &str, groups: &HashMap<String, Vec<String>>) -> Option<String> {
    static DOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:test|spec)\.").unwrap());
    static LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^test_(.*?)(\.\w+)$").unwrap());
    static TRAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)_test(\.\w+)$").unwrap());
    let mine = test_pattern(basename(path))?;
    let tests: Vec<Option<&'static str>> = groups.get(&format!("{}\0test", dirname(path))).into_iter().flatten().map(|n| test_pattern(n)).collect();
    let mut seen = Vec::new();
    for pattern in &tests {
        if seen.contains(pattern) {
            continue;
        }
        seen.push(*pattern);
        let agree = tests.iter().filter(|t| *t == pattern).count();
        let Some(p) = pattern else { continue };
        if *p == mine || agree < MIN_AGREE || (agree as f64) < SHARE * tests.len() as f64 {
            continue;
        }
        let name = basename(path);
        let step1 = DOT.replacen(name, 1, format!("{p}.").as_str()).to_string();
        let step2 = LEAD.replacen(&step1, 1, if *p == "*_test" { "${1}_test${2}" } else { "test_${1}${2}" }).to_string();
        let fixed = TRAIL.replacen(&step2, 1, if *p == "test_*" { "test_${1}${2}" } else { "${1}_test${2}" }).to_string();
        let shown = if *p == ".test" || *p == ".spec" { format!("*{p}.*") } else { p.to_string() };
        return Some(format!("{path}: tests in this folder are named {shown} ({agree} of {}): rename to {fixed}", tests.len()));
    }
    None
}

fn ancestors(path: &str) -> Vec<String> {
    let segments: Vec<&str> = path.split('/').collect();
    (1..segments.len()).map(|i| segments[..i].join("/")).collect()
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let added: Vec<String> = request.options.get("added").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    let tests: HashSet<String> = request.options.get("tests").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    let files = &request.files;
    let fresh: HashSet<String> = added.iter().cloned().collect();
    let before: HashSet<String> = files.iter().filter(|f| !fresh.contains(*f)).flat_map(|f| ancestors(f)).collect();
    let mut new_dirs: Vec<String> = Vec::new();
    for d in added.iter().flat_map(|f| ancestors(f)) {
        if !before.contains(&d) && !SKIP.is_match(&format!("{d}/")) && !new_dirs.contains(&d) {
            new_dirs.push(d);
        }
    }
    let mut voters_out = fresh.clone();
    voters_out.extend(new_dirs.iter().cloned());
    let groups = sibling_index(files, &voters_out);
    // What a test can be named after: any other file's stem, or a folder (`Table.test.tsx` for `Table/`).
    let mut subjects: HashSet<String> = files.iter().filter(|f| test_pattern(basename(f)).is_none()).map(|f| format!("{}/{}", dirname(f), parts(basename(f)).0)).collect();
    subjects.extend(before.iter().cloned());
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut read = |file: &str| -> String {
        cache
            .entry(file.to_string())
            .or_insert_with(|| {
                let text = std::fs::read_to_string(std::path::Path::new(&request.root).join(file)).unwrap_or_default();
                text.chars().take(200_000).collect()
            })
            .clone()
    };
    let mut findings = Vec::new();
    for dir in &new_dirs {
        let name = basename(dir);
        if !checkable(name) || name.contains('.') {
            continue;
        }
        let siblings: Vec<String> = groups.get(&format!("{}\0dir", dirname(dir))).into_iter().flatten().filter(|n| checkable(n)).cloned().collect();
        if let Some((rs, agree, total)) = convention(&siblings) {
            if !fits(style_of(name), rs) {
                findings.push(Finding { file: dir.clone(), line: 0, target: dir.clone(), message: format!("{dir}/: folders beside it are named in {} ({agree} of {total}): rename to {}", style_name(rs), restyle(name, rs)) });
            }
        }
    }
    // An added file inside an added folder has no siblings that voted, so only its folder is judged.
    let added_dirs: HashSet<&String> = new_dirs.iter().collect();
    for path in added.iter().filter(|f| CODE.is_match(f) && !added_dirs.contains(&dirname(f).to_string())) {
        let is_test = tests.contains(path) || test_pattern(basename(path)).is_some();
        static JS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?[jt]sx?$").unwrap());
        let js = JS.is_match(path);
        let exports = js.then(|| export_names(&read(path)));
        let mut messages = check_file_name(path, &groups, exports.as_deref(), &subjects);
        let extra = if is_test { check_test_name(path, &groups) } else { check_export_name(path, &mut read, &groups) };
        messages.extend(extra);
        for message in messages {
            findings.push(Finding { file: path.clone(), line: 0, target: path.clone(), message });
        }
    }
    Ok(Answer { findings, summary: format!("{} added files and {} added folders checked", added.len(), new_dirs.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn casing_and_names() {
        assert_eq!(style_of("user_card"), Some(Style::Snake));
        assert_eq!(restyle("user_card", Style::Pascal), "UserCard");
        assert_eq!(restyle("OAuthConsentForm", Style::Kebab), "o-auth-consent-form");
        assert_eq!(restyle("HTMLParser", Style::Kebab), "html-parser");
        assert!(named_after("staff-schedule", "registerStaffTodayScheduleRoutes"));
        assert!(named_after("oauth-consent-form", "OAuthConsentForm"));
        assert_eq!(words_of("categories"), vec!["category"]);
        assert_eq!(main_export("export default function UserCard() {}", "tsx").as_deref(), Some("UserCard"));
    }
}
