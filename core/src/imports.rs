//! The imports check: an import that names something that is not there. A file that does not exist (or exists under
//! another case, which only macOS forgives), a name the module does not export, or a package no package.json
//! declares and nothing installed provides: the shape of an invented import. Reported on the lines the change added,
//! and on unchanged imports the change broke by deleting, moving or un-exporting what they named.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::graph::{self, Graph, Kind, Module, Target};
use crate::{rel, text, Answer, Finding, Request};

/// Folders a build writes and git ignores: an import of one is fine before the build has run.
static GENERATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:\.next|\.svelte-kit|\.astro|\.nuxt|\.output|\.react-router|\.source|\.velite|\.contentlayer|\.wrangler|\.expo|\.vercel|\.turbo|_generated|__generated__|generated|\.generated|\+types|\$types|paraglide|dist|build|out|\.cache)(?:/|$)").unwrap()
});
/// Fixtures and sample data: code kept broken or incomplete on purpose, as input for a tool's tests.
static FIXTURE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|/)(?:__)?(?:test[-_])?fixtures?(?:__)?/|(?:^|/)(?:testdata|__snapshots__)/").unwrap());
/// A name npm would accept: lowercase, an optional scope.
static PACKAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._-]*$").unwrap());
/// Bundler and test-runner configs, whose `alias` maps can make any word an import.
static BUNDLER_CONFIG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:(?:vite|vitest|webpack|rollup|rspack|rsbuild|next|astro|svelte|nuxt|babel|metro|craco|tsup|esbuild|electron\.vite|electron-vite|app|jest|remix|react-router|quasar|vue|wxt|farm|modern)\.config\.[cm]?[jt]s|\.babelrc(?:\.json)?|babel\.config\.json|jest\.config\.json)$").unwrap()
});
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["'`]([^"'`\s]+)["'`]"#).unwrap());
/// Modules a framework or runtime provides with no package behind them.
const VIRTUAL: [&str; 14] = [
    "virtual:",
    "astro:",
    "$app/",
    "$env/",
    "$service-worker",
    "~",
    "bun:",
    "cloudflare:",
    "#",
    "@/",
    "uno.css",
    "__STATIC_CONTENT_MANIFEST",
    "sveltekit:",
    "vinxi/",
];
/// Runtimes that provide modules of their own: k6 load tests, Bun.
const RUNTIMES: [&str; 2] = ["k6", "bun"];
/// Imports Next.js resolves itself, without a package of their own.
const NEXT_PROVIDES: [&str; 3] = ["server-only", "client-only", "styled-jsx"];

fn ambient_matches(pattern: &str, spec: &str) -> bool {
    match pattern.split_once('*') {
        Some((pre, post)) => spec.starts_with(pre) && spec.ends_with(post),
        None => pattern == spec,
    }
}

/// The closest of `names` to `name`, when it is a likely typo or casing slip.
fn closest<'a>(name: &str, names: impl Iterator<Item = &'a String>) -> Option<&'a String> {
    let lower = name.to_lowercase();
    names
        .map(|n| (strsim(&lower, &n.to_lowercase()), n))
        .filter(|(d, n)| *d <= (name.len().max(n.len()) / 3).max(1))
        .min_by_key(|(d, _)| *d)
        .map(|(_, n)| n)
}

/// Levenshtein distance.
fn strsim(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for j in 0..b.len() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != b[j])).min(row[j] + 1).min(row[j + 1] + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

/// The path an unresolved specifier meant: the joined path of a relative one, the alias itself otherwise.
fn candidate(file: &str, spec: &str) -> String {
    if spec.starts_with('.') {
        return graph::join(graph::parent(file), spec).unwrap_or_default();
    }
    spec.trim_start_matches(['@', '~', '#', '/']).to_string()
}

/// Words that bundler configs, Deno import maps and package.json `imports` make importable.
fn alias_words(root: &str, files: &[String]) -> HashSet<String> {
    let mut words = HashSet::new();
    for f in files
        .iter()
        .filter(|f| BUNDLER_CONFIG.is_match(f) || f.ends_with("deno.json") || f.ends_with("deno.jsonc") || f.ends_with("import_map.json"))
    {
        if let Some(text) = text::read(root, f) {
            words.extend(QUOTED.captures_iter(&text).map(|c| graph::package_name(&c[1]).to_string()));
        }
    }
    words
}

/// What the Node side's graph gates send (gates/imports.mjs `graphGate`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// Files the change added or modified.
    changed: HashSet<String>,
    /// Files the change deleted or renamed away.
    gone: Vec<String>,
    /// Each modified code file as it was on the base.
    base: HashMap<String, String>,
    #[serde(rename = "fresh")]
    _fresh: serde::de::IgnoredAny,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let graph = Graph::build(&request.root, &request.files);
    let Options { changed, gone, base: base_texts, .. } = request.options()?;
    let base: HashMap<String, Module> = base_texts.iter().map(|(f, t)| (f.clone(), graph::read_module(f, t).unwrap_or_default())).collect();
    let ambient: Vec<&String> = graph.modules.values().flat_map(|m| &m.ambient).collect();
    let words = alias_words(&request.root, &request.files);
    let next = graph.packages.iter().any(|p| p.deps.contains("next"));
    let deno = |file: &str| {
        let mut dir = graph::parent(file);
        loop {
            if ["deno.json", "deno.jsonc"].iter().any(|n| graph.files.contains(&graph::join(dir, n).unwrap_or_default())) {
                return true;
            }
            if dir.is_empty() {
                return false;
            }
            dir = graph::parent(dir);
        }
    };
    // A shared source folder outside any package (`qa/e2e-shared`) uses the packages of the packages that import it.
    let mut importers: HashMap<&str, Vec<&str>> = HashMap::new();
    for (from, targets) in &graph.targets {
        for t in targets {
            if let Target::File(to) = t {
                importers.entry(to.as_str()).or_default().push(from.as_str());
            }
        }
    }
    let declared_by_importers = |file: &str, spec: &str| {
        let mut seen: HashSet<&str> = HashSet::from([file]);
        let mut frontier = vec![file];
        for _ in 0..4 {
            let next: Vec<&str> =
                frontier.iter().flat_map(|f| importers.get(f).into_iter().flatten().copied()).filter(|f| seen.insert(f)).collect();
            if next.iter().any(|f| graph.declares(f, spec)) {
                return true;
            }
            frontier = next;
        }
        false
    };
    let gone_stems: HashSet<&str> = gone.iter().map(|g| graph::no_exts(g)).collect();
    let empty = HashMap::new();

    let mut findings = Vec::new();
    let mut ignorable: HashMap<String, String> = HashMap::new();
    let mut checked = 0;
    let mut files: Vec<&String> =
        graph.modules.keys().filter(|f| f.starts_with(&request.prefix) && !f.ends_with(".d.ts") && !FIXTURE.is_match(f)).collect();
    files.sort();
    for file in files {
        let module = &graph.modules[file];
        let name = rel(&request.prefix, file);
        for (i, import) in module.imports.iter().enumerate() {
            let target = &graph.targets[file][i];
            let spec = import.spec.split('?').next().unwrap_or(&import.spec);
            let added = request.changed(file, import.line);
            checked += 1;
            let relative = spec.starts_with('.');
            match target {
                Target::Missing if relative || graph.is_alias(file, spec) => {
                    let meant = candidate(file, spec);
                    if GENERATED.is_match(&meant) || spec.contains("+types") || spec.contains("$types") {
                        continue;
                    }
                    let deleted =
                        relative && (gone_stems.contains(graph::no_exts(&meant)) || gone_stems.contains(format!("{meant}/index").as_str()));
                    if !(added || deleted) {
                        continue;
                    }
                    let target = format!("imports:{name}:{spec}");
                    let why = if deleted && !added {
                        "which this change deleted or moved: point the import at its new place"
                    } else {
                        "which does not exist: point it at the real file (`intersite search` finds existing code), or create the module; do not add an empty stub just so it resolves"
                    };
                    if relative {
                        ignorable.insert(target.clone(), meant);
                    }
                    findings.push(Finding {
                        file: file.clone(),
                        line: import.line,
                        target,
                        message: format!("{name}:{} imports \"{spec}\", {why}", import.line),
                    });
                }
                Target::File(found)
                    if added && !graph.files.contains(found) && graph.lower.get(&found.to_lowercase()).is_some_and(|a| a != found) =>
                {
                    let actual = &graph.lower[&found.to_lowercase()];
                    findings.push(Finding {
                        file: file.clone(),
                        line: import.line,
                        target: format!("imports:{name}:{spec}"),
                        message: format!("{name}:{} imports \"{spec}\", but the file is {}: the case differs, which macOS forgives and Linux, CI and production do not; match the file name's case", import.line, rel(&request.prefix, actual)),
                    });
                }
                Target::File(found)
                    if !import.names.is_empty()
                        && matches!(import.kind, Kind::Static | Kind::Type | Kind::ReExport)
                        && !found.ends_with(".json")
                        && graph::CODE.is_match(found) =>
                {
                    let Some(exports) = graph.exports_of(found, &empty) else { continue };
                    let touched = changed.contains(found);
                    for n in import.names.iter().filter(|n| !exports.contains(&n.name)) {
                        let added_name = request.changed(file, n.line);
                        // An unchanged import counts only when the change took away a name the module had.
                        let removed = touched && !added_name && graph.exports_of(found, &base).is_some_and(|e| e.contains(&n.name));
                        if !(added_name || removed) {
                            continue;
                        }
                        let module_name = rel(&request.prefix, found);
                        let message = if n.name == "default" {
                            format!("{name}:{} imports a default from \"{spec}\", but {module_name} has no default export{}: import one of its named exports with braces", n.line, if removed { " any more (this change removed it)" } else { "" })
                        } else {
                            let hint = closest(&n.name, exports.iter()).map_or(String::new(), |c| format!(" (did you mean `{c}`?)"));
                            let what = if removed { "no longer exports (this change removed it)" } else { "does not export" };
                            format!("{name}:{} imports `{}` from \"{spec}\", which {module_name} {what}{hint}: import a name it exports, or export it there; do not add a stub export just to satisfy the import", n.line, n.name)
                        };
                        findings.push(Finding {
                            file: file.clone(),
                            line: n.line,
                            target: format!("imports:{name}:{spec}#{}", n.name),
                            message,
                        });
                    }
                }
                Target::Missing if added && !import.in_try && !relative => {
                    let package = graph::package_name(spec);
                    let provided = VIRTUAL.iter().any(|v| spec.starts_with(v))
                        || RUNTIMES.contains(&package)
                        || (next && (NEXT_PROVIDES.contains(&package) || package == "next"));
                    if !PACKAGE.is_match(package) || provided || package.starts_with("@types/") || spec.ends_with(".css") {
                        continue;
                    }
                    if graph.declares(file, spec)
                        || words.contains(package)
                        || ambient.iter().any(|a| ambient_matches(a, spec))
                        || graph.packages_of(file).is_empty()
                        || deno(file)
                        || declared_by_importers(file, spec)
                    {
                        continue;
                    }
                    findings.push(Finding {
                        file: file.clone(),
                        line: import.line,
                        target: format!("imports:{name}:{package}"),
                        message: format!("{name}:{} imports \"{spec}\", but no package.json declares \"{package}\" and it is not installed: agents invent package names, so check the real name on npm and add it with the package manager; do not write a local shim under that name", import.line),
                    });
                }
                _ => {}
            }
        }
    }
    let summary = format!("{checked} imports in {} files checked", graph.modules.len());
    let data = (!ignorable.is_empty()).then(|| serde_json::json!({ "ignorable": ignorable }));
    Ok(Answer { findings, summary, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggestions_and_paths() {
        let names = ["formatPrice".to_string(), "parseDate".to_string()];
        assert_eq!(closest("formatprice", names.iter()), Some(&names[0]));
        assert_eq!(closest("totallyDifferent", names.iter()), None);
        assert_eq!(graph::no_exts("src/a.test.ts"), "src/a");
        assert!(ambient_matches("*.svg", "./logo.svg") && ambient_matches("virtual:pwa", "virtual:pwa"));
        assert!(GENERATED.is_match("app/.react-router/types/x") && !GENERATED.is_match("src/lib/x"));
    }
}
