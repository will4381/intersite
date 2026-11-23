//! The coverage gate: a function the change added or edited that the test command never ran. Read from the V8
//! coverage files every Node process of the run wrote (`NODE_V8_COVERAGE`). A function counts as run when V8 reports a
//! call to one of that name in its file, so transpiled TypeScript, whose offsets differ from the file on disk, is
//! matched too. Functions, not lines: a line-level percentage is a threshold to game, an untested function is a fact.

use rayon::prelude::*;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::{Answer, Finding, Request};

#[derive(Deserialize)]
struct File {
    path: String,
    lines: Vec<u32>,
}

/// A script's path relative to the project, from a `file://` URL or a plain path (jest and vitest run code in `vm`).
fn project_path(url: &str, root: &Path) -> Option<String> {
    let path = url.strip_prefix("file://").map(crate::trace::percent_decode).unwrap_or_else(|| url.to_string());
    let rel = Path::new(&path).strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    (!rel.starts_with("node_modules/") && !rel.contains("/node_modules/")).then_some(rel)
}

/// The names of the functions V8 saw called, per project file.
fn called(dir: &str, root: &Path) -> HashMap<String, HashSet<String>> {
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    for doc in crate::trace::json_files(dir, "json") {
        for script in doc["result"].as_array().into_iter().flatten() {
            let Some(file) = script["url"].as_str().and_then(|u| project_path(u, root)) else { continue };
            let names = out.entry(file).or_default();
            for f in script["functions"].as_array().into_iter().flatten() {
                if f["ranges"][0]["count"].as_u64().unwrap_or(0) > 0 {
                    let name = f["functionName"].as_str().unwrap_or("");
                    // V8 names an accessor `get total`; the source names it `total`.
                    names.insert(name.trim_start_matches("get ").trim_start_matches("set ").to_string());
                }
            }
        }
    }
    out
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let files: Vec<File> = serde_json::from_value(request.options["files"].clone()).map_err(|e| e.to_string())?;
    let root = Path::new(&request.root);
    let called = called(request.options["dir"].as_str().unwrap_or(""), root);
    if called.is_empty() {
        return Err("the test command ran none of the project's code under V8 coverage: this gate needs tests that run the project's JavaScript or TypeScript in Node (node --test, vitest, jest, mocha), not a browser, Bun or Deno".into());
    }
    let none = HashSet::new();
    let judged: Vec<(usize, Vec<Finding>)> = files
        .par_iter()
        .map(|file| {
            let Some(text) = crate::text::read(&request.root, &file.path) else { return (0, vec![]) };
            let Some(shape) = crate::functions::read(&file.path, &text) else { return (0, vec![]) };
            let ran = called.get(&file.path).unwrap_or(&none);
            let changed: Vec<&crate::functions::Func> = shape.funcs.iter().filter(|f| !f.callback && !f.empty && file.lines.iter().any(|l| (f.line..=f.end_line).contains(l))).collect();
            let unrun: Vec<&&crate::functions::Func> = changed.iter().filter(|f| !ran.contains(&f.name)).collect();
            // A function inside one that never ran never ran either: the outer one is the finding.
            let inside = |f: &crate::functions::Func| unrun.iter().any(|g| !std::ptr::eq(**g, f) && g.line <= f.line && f.end_line <= g.end_line);
            let findings = unrun
                .iter()
                .filter(|f| !inside(f))
                .map(|f| Finding {
                    file: file.path.clone(),
                    line: f.line,
                    target: format!("{}:{}", file.path, f.name),
                    message: format!("{}:{} {} runs in no test: add a test that calls it and checks what it returns or does", file.path, f.line, f.name),
                })
                .collect();
            (changed.len(), findings)
        })
        .collect();
    let checked: usize = judged.iter().map(|(n, _)| n).sum();
    let mut findings: Vec<Finding> = judged.into_iter().flat_map(|(_, f)| f).collect();
    findings.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    Ok(Answer { findings, summary: format!("{checked} changed functions checked against the tests' V8 coverage"), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_project_paths_from_file_urls_and_plain_paths() {
        let root = Path::new("/repo");
        assert_eq!(project_path("file:///repo/src/a%20b.ts", root).as_deref(), Some("src/a b.ts"));
        assert_eq!(project_path("/repo/src/a.ts", root).as_deref(), Some("src/a.ts"));
        assert_eq!(project_path("file:///repo/node_modules/x/i.js", root), None);
        assert_eq!(project_path("node:internal/main", root), None);
    }
}
