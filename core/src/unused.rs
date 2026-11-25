//! The unused check: code the change leaves that nothing uses. An added file nothing references, an added export
//! nothing uses, or a file whose last import the change removed. Text only: a file is referenced when another file
//! names its stem (in quotes, for code); an export is used when another file has its name as a word.

use fancy_regex::Regex as Fancy;
use rayon::prelude::*;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::graph::{basename, join, no_ext, parent};
use crate::{Answer, Finding, Request};

static SOURCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.(?:[cm]?[jt]sx?|py|rb|rs|kts?|java|cs|php|vue|svelte|astro|css|scss)$").unwrap());
static JS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?[jt]sx?$").unwrap());
/// Files whose references count. In code, only quoted text names a file (imports are strings); elsewhere any word.
static CORPUS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|astro|scala|sh|sql|css|scss|html|json|jsonc|json5|ya?ml|toml)$|(?:^|/)(?:Dockerfile|Makefile|Procfile)$").unwrap()
});
static QUOTED_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss)$").unwrap());
/// Intersite's own config and baseline name files only to acknowledge or baseline them, which is not a use.
static SKIP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:node_modules|dist|build|out|vendor|coverage|generated|__generated__)/|\.min\.|(?:^|/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|intersite\.(?:ya?ml|json)|intersite-(?:gates-)?baseline\.json|\.intersite/baseline\.json)$").unwrap()
});
const MAX_BYTES: u64 = 1024 * 1024;
/// Loaded by convention, never imported: routing folders, entry names, dotfiles, configs, types, tests and fixtures.
static CONVENTION_DIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:components/ui|\.[^/]+|routes|pages|app|api|migrations|scripts|bin|public|skills|templates|functions|convex|fixtures|__fixtures__|__mocks__|tests?|__tests__|e2e)/").unwrap()
});
static CONVENTION_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:main|server|worker|cli|middleware|instrumentation|instrumentation-client|mdx-components|__main__|conftest|manage|setup)$|^\.|\.(?:config|d|stories|typetest|bench)$|^test_|_test$").unwrap()
});
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\w$][\w$.-]*").unwrap());
static QUOTED: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r#"(["'`])((?:\\.|(?!\1)[^\\\n])*)\1"#).unwrap());
static EXPORT_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|type|interface|enum|const\s+enum|namespace)\s+([\w$]+)").unwrap()
});
// ponytail: one-line `export { a, b }` only; a multi-line list or `export const { a } =` is not seen, a tokenizer if it matters
static EXPORT_LIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*;?\s*$").unwrap());
/// Relative specifiers, and the common source-root aliases (`@/x`, `~/x`, `#/x`).
static LOCAL_IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']((?:\.\.?|[@~#])/[^"']*)["']"#).unwrap()
});
const RESOLVE: [&str; 14] = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".css", ".scss", ".json"];

/// The name other files use for `path`: its name without extension, or its folder's name for an index.
fn stem(path: &str) -> String {
    let name = no_ext(basename(path));
    if name == "index" || name == "__init__" {
        // A root index has no folder: "." names no file.
        match basename(parent(path)) {
            "" => ".".to_string(),
            dir => dir.to_string(),
        }
    } else {
        name.to_string()
    }
}

/// Every word in `text`, plus the parts of dotted and dashed words.
fn words(text: &str, see: &mut impl FnMut(&str)) {
    for token in TOKEN.find_iter(text).map(|m| m.as_str()) {
        see(token);
        if !token.contains(['.', '-']) {
            continue;
        }
        let dotted: Vec<&str> = token.split('.').collect();
        for i in 1..dotted.len() {
            see(&dotted[..i].join("."));
        }
        for part in token.split(['.', '-']) {
            see(part);
        }
    }
}

/// Paths named in any package.json (main, module, types, bin, exports, scripts), without extension, and the folders of
/// published packages, whose exports are for outside consumers.
fn package_entries(root: &str, files: &[String]) -> (HashSet<String>, Vec<String>) {
    fn strings(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::String(s) => out.extend(s.split_whitespace().map(str::to_string)),
            serde_json::Value::Object(o) => o.values().for_each(|x| strings(x, out)),
            serde_json::Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            _ => {}
        }
    }
    let mut named = HashSet::new();
    let mut published = Vec::new();
    for file in files.iter().filter(|f| basename(f) == "package.json" && !SKIP.is_match(f)) {
        let Ok(text) = std::fs::read_to_string(std::path::Path::new(root).join(file)) else { continue };
        // An invalid package.json names no entries; new-deps reports it.
        let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let dir = parent(file);
        let mut list = Vec::new();
        for key in ["main", "module", "types", "bin", "exports", "scripts"] {
            strings(&pkg[key], &mut list);
        }
        for s in list {
            if let Some(entry) = join(dir, &s) {
                named.insert(no_ext(&entry).to_string());
            }
        }
        // `main` alone is what npm init writes, so it does not mark a package as published.
        let private = pkg["private"].as_bool().unwrap_or(false);
        if !private && ["exports", "module", "files", "publishConfig"].iter().any(|k| !pkg[*k].is_null()) {
            published.push(if dir.is_empty() { String::new() } else { format!("{dir}/") });
        }
    }
    (named, published)
}

/// How often `name` appears as a whole word in `line`.
fn word_count(line: &str, name: &str) -> usize {
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    line.match_indices(name)
        .filter(|(i, _)| {
            !line[..*i].chars().next_back().is_some_and(is_word) && !line[i + name.len()..].chars().next().is_some_and(is_word)
        })
        .count()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// Files the change added.
    fresh: Vec<String>,
    /// The text of each file's added lines.
    added_lines: Vec<(String, Vec<String>)>,
    /// The text of each file's removed lines.
    removed_lines: Vec<(String, Vec<String>)>,
    /// Files the test or entry path globs name, matched in Node.
    conventional_by_glob: HashSet<String>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { fresh: fresh_list, added_lines: added, removed_lines: removed, conventional_by_glob: by_glob } = request.options()?;
    let all = &request.files;
    let exists: HashSet<&str> = all.iter().map(String::as_str).collect();
    let fresh: HashSet<&str> = fresh_list.iter().map(String::as_str).collect();
    let (named, published) = package_entries(&request.root, all);
    let conventional = |f: &str| {
        by_glob.contains(f)
            || CONVENTION_DIR.is_match(f)
            || CONVENTION_NAME.is_match(no_ext(basename(f)))
            || named.contains(no_ext(f))
            || SKIP.is_match(f)
    };

    // 1. Added source files.
    let new_files: Vec<&String> = fresh_list.iter().filter(|f| SOURCE.is_match(f) && !conventional(f) && stem(f) != ".").collect();

    // 2. Added exports in files that are not loaded by convention or published.
    let mut exports: Vec<(String, String)> = Vec::new();
    for (file, lines) in &added {
        if !JS.is_match(file)
            || !exists.contains(file.as_str())
            || conventional(file)
            || published.iter().any(|d| file.starts_with(d.as_str()))
        {
            continue;
        }
        for line in lines {
            let list: Vec<String> = match EXPORT_DECL.captures(line) {
                Some(c) => vec![c[1].to_string()],
                None => {
                    static AS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+as\s+").unwrap());
                    EXPORT_LIST
                        .captures(line)
                        .map(|c| c[1].split(',').map(|s| AS.split(s.trim()).last().unwrap_or("").to_string()).collect())
                        .unwrap_or_default()
                }
            };
            for name in list {
                if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$') && name != "default" {
                    exports.push((file.clone(), name));
                }
            }
        }
    }

    // 3. Files that lost a local import and existed before the change.
    let mut by_name: HashMap<&str, Vec<&str>> = HashMap::new();
    for f in all {
        by_name.entry(basename(f)).or_default().push(f);
    }
    let mut orphans: Vec<String> = Vec::new();
    for (from, lines) in &removed {
        if !JS.is_match(from) {
            continue;
        }
        for line in lines {
            for c in LOCAL_IMPORT.captures_iter(line) {
                let spec = &c[1];
                // ponytail: an alias is resolved as the one file whose path ends with the rest of the specifier, not
                // through tsconfig paths; read compilerOptions.paths if two source roots share file names
                let alias = spec.starts_with("@/") || spec.starts_with("~/") || spec.starts_with("#/");
                let Some(path) = (if alias { Some(spec[2..].to_string()) } else { join(parent(from), spec) }) else { continue };
                let bare = path
                    .strip_suffix(".js")
                    .or_else(|| path.strip_suffix(".cjs"))
                    .or_else(|| path.strip_suffix(".mjs"))
                    .unwrap_or(&path)
                    .to_string();
                let mut names: Vec<String> = RESOLVE.iter().map(|e| format!("{path}{e}")).collect();
                names.extend(RESOLVE[1..].iter().map(|e| format!("{bare}{e}")));
                names.extend(RESOLVE[1..].iter().map(|e| format!("{path}/index{e}")));
                let found: Vec<String> = if alias {
                    let mut f: Vec<String> = Vec::new();
                    for n in &names {
                        for cand in by_name.get(basename(n)).into_iter().flatten() {
                            if cand.ends_with(&format!("/{n}")) && !f.iter().any(|x| x == cand) {
                                f.push(cand.to_string());
                            }
                        }
                    }
                    f
                } else {
                    names.into_iter().filter(|p| exists.contains(p.as_str())).collect()
                };
                let target = if found.len() == 1 || !alias { found.first().cloned() } else { None };
                // A file outside the project is another project's to keep or delete.
                if let Some(t) =
                    target.filter(|t| !t.starts_with("../") && !fresh.contains(t.as_str()) && SOURCE.is_match(t) && !conventional(t))
                {
                    if !orphans.contains(&t) {
                        orphans.push(t);
                    }
                }
            }
        }
    }

    // One pass over the whole repository records which files mention each stem and each export name.
    let stems: HashSet<String> = new_files.iter().map(|f| stem(f)).chain(orphans.iter().map(|f| stem(f))).collect();
    let names: HashSet<&str> = exports.iter().map(|e| e.1.as_str()).collect();
    let exporting: HashSet<&str> = exports.iter().map(|e| e.0.as_str()).collect();
    type Hits = (Vec<(String, String)>, Vec<(String, String)>, Option<(String, String)>);
    let scanned: Vec<Option<Hits>> = if stems.is_empty() && names.is_empty() {
        vec![]
    } else {
        all.par_iter()
            .map(|file| {
                if !CORPUS.is_match(file) || SKIP.is_match(file) {
                    return None;
                }
                let path = std::path::Path::new(&request.root).join(file);
                if std::fs::metadata(&path).ok()?.len() > MAX_BYTES {
                    return None;
                }
                let text = std::fs::read_to_string(&path).ok()?;
                if text.contains('\0') {
                    return None;
                }
                let mut path_hits = Vec::new();
                let mut word_hits = Vec::new();
                if !names.is_empty() {
                    words(&text, &mut |w| {
                        if names.contains(w) {
                            word_hits.push((w.to_string(), file.clone()));
                        }
                    });
                }
                let kept = exporting.contains(file.as_str()).then(|| (file.clone(), text.clone()));
                if !stems.is_empty() {
                    let mut see = |w: &str| {
                        if stems.contains(w) {
                            path_hits.push((w.to_string(), file.clone()));
                        }
                    };
                    if QUOTED_ONLY.is_match(file) {
                        for c in QUOTED.captures_iter(&text).filter_map(|c| c.ok()) {
                            words(c.get(2).map_or("", |m| m.as_str()), &mut see);
                        }
                    } else {
                        words(&text, &mut see);
                    }
                }
                Some((path_hits, word_hits, kept))
            })
            .collect()
    };
    let mut path_hits: HashMap<String, HashSet<String>> = HashMap::new();
    let mut word_hits: HashMap<String, HashSet<String>> = HashMap::new();
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut count = 0;
    for hit in scanned.into_iter().flatten() {
        count += 1;
        for (w, f) in hit.0 {
            path_hits.entry(w).or_default().insert(f);
        }
        for (w, f) in hit.1 {
            word_hits.entry(w).or_default().insert(f);
        }
        if let Some((f, t)) = hit.2 {
            texts.insert(f, t);
        }
    }
    let referenced = |file: &str| path_hits.get(&stem(file)).is_some_and(|s| s.iter().any(|f| f != file));
    let mut findings = Vec::new();
    let unreferenced: Vec<&&String> = new_files.iter().filter(|f| !referenced(f)).collect();
    for file in &unreferenced {
        findings.push(Finding {
            file: file.to_string(),
            line: 0,
            target: file.to_string(),
            message: format!("{file} is added but no other file imports or names it: wire it in, or delete it"),
        });
    }
    for (file, name) in &exports {
        if unreferenced.iter().any(|f| **f == file) || word_hits.get(name).is_some_and(|s| s.iter().any(|f| f != file)) {
            continue;
        }
        // Uses inside the file are the name's occurrences beyond its declarations and export list entries.
        let (mut expected, mut seen) = (0, 0);
        for line in texts.get(file).map_or("", |t| t.as_str()).split('\n') {
            let n = word_count(line, name);
            seen += n;
            if EXPORT_DECL.captures(line).is_some_and(|c| &c[1] == name) {
                expected += 1;
            } else if EXPORT_LIST.is_match(line) && n > 0 {
                expected += 2;
            }
        }
        if seen <= expected {
            findings.push(Finding {
                file: file.clone(),
                line: 0,
                target: format!("{file}:{name}"),
                message: format!("{file}: export {name} is used nowhere: delete it"),
            });
        }
    }
    for file in &orphans {
        if !referenced(file) {
            findings.push(Finding {
                file: file.clone(),
                line: 0,
                target: file.clone(),
                message: format!("{file} is no longer imported by anything after this change: delete it"),
            });
        }
    }
    Ok(Answer::new(
        findings,
        format!(
            "{} added files, {} added exports and {} removed imports checked against {count} files",
            new_files.len(),
            exports.len(),
            orphans.len()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_words() {
        assert_eq!(no_ext("a/b.test.ts"), "a/b.test");
        assert_eq!(no_ext("a/.env"), "a/.env");
        assert_eq!(stem("src/user/index.ts"), "user");
        assert_eq!(word_count("foo(fooBar, foo)", "foo"), 2);
        let mut seen = vec![];
        words("./user-card.js", &mut |w| seen.push(w.to_string()));
        assert!(seen.contains(&"user-card".to_string()));
    }
}
