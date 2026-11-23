//! The complexity gate: a changed function whose cognitive complexity (SonarSource's definition, in functions.rs) ends
//! at 25 or more, when it is new or the change added 10 or more. Only the change is judged, never what was already
//! there: an absolute threshold on old code would only be nagging.

use rayon::prelude::*;
use serde::Deserialize;
use std::collections::HashMap;

use crate::functions::{self, Func};
use crate::{Answer, Finding, Request};

const FAIL_AT: u32 = 25;
const GROWTH: u32 = 10;

#[derive(Deserialize)]
struct File {
    path: String,
    /// The file on the base, "" when it is new.
    before: String,
    /// Lines the change added.
    lines: Vec<u32>,
}

/// Each outermost function by name and occurrence, so the base's twin of a head function is found after edits move it.
fn keyed(funcs: &[Func]) -> Vec<(String, &Func)> {
    let mut seen: HashMap<&str, u32> = HashMap::new();
    funcs
        .iter()
        .filter(|f| f.top)
        .map(|f| {
            let n = seen.entry(f.name.as_str()).or_default();
            *n += 1;
            (format!("{}#{n}", f.name), f)
        })
        .collect()
}

fn judge(root: &str, file: &File) -> (usize, Vec<Finding>) {
    let Some(text) = crate::text::read(root, &file.path) else { return (0, vec![]) };
    let Some(head) = functions::read(&file.path, &text) else { return (0, vec![]) };
    let base = if file.before.is_empty() { None } else { functions::read(&file.path, &file.before) };
    let was: HashMap<String, u32> = base.as_ref().map(|b| keyed(&b.funcs).into_iter().map(|(k, f)| (k, f.complexity)).collect()).unwrap_or_default();
    let mut checked = 0;
    let mut findings = Vec::new();
    for (key, f) in keyed(&head.funcs) {
        if !file.lines.iter().any(|l| (f.line..=f.end_line).contains(l)) {
            continue;
        }
        checked += 1;
        let before = was.get(&key).copied();
        if f.complexity < FAIL_AT || before.is_some_and(|b| f.complexity < b + GROWTH) {
            continue;
        }
        let name = if f.callback { format!("the {}", f.name) } else { f.name.clone() };
        let since = before.map_or("a new function".to_string(), |b| format!("was {b}"));
        findings.push(Finding {
            file: file.path.clone(),
            line: f.line,
            target: format!("{}:{}", file.path, f.name),
            message: format!("{}:{} {name} has cognitive complexity {} ({since}): split it into named steps; do not just move its branches into a lookup of closures", file.path, f.line, f.complexity),
        });
    }
    (checked, findings)
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let files: Vec<File> = serde_json::from_value(request.options["files"].clone()).map_err(|e| e.to_string())?;
    let judged: Vec<(usize, Vec<Finding>)> = files.par_iter().map(|f| judge(&request.root, f)).collect();
    let checked: usize = judged.iter().map(|(n, _)| n).sum();
    let mut findings: Vec<Finding> = judged.into_iter().flat_map(|(_, f)| f).collect();
    findings.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    Ok(Answer { findings, summary: format!("{checked} changed functions checked"), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branches(n: usize) -> String {
        (0..n).map(|i| format!("  if (a === {i}) {{ if (b) return {i}; }}\n")).collect()
    }

    #[test]
    fn reports_a_function_that_crossed_the_bar_by_growing_not_one_already_over_it() {
        let dir = std::env::temp_dir().join(format!("intersite-complexity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Each branch costs 3 (an if, and a nested if): 4 branches are 12, 10 are 30.
        let small = format!("export function pick(a, b) {{\n{}  return -1;\n}}\n", branches(4));
        let big = format!("export function pick(a, b) {{\n{}  return -1;\n}}\n", branches(10));
        let bigger = format!("export function pick(a, b) {{\n{}  return -1;\n}}\n", branches(11));
        std::fs::write(dir.join("a.ts"), &big).unwrap();
        let root = dir.to_string_lossy();
        let grown = judge(&root, &File { path: "a.ts".into(), before: small, lines: vec![5] });
        assert_eq!(grown.1.iter().map(|f| f.message.as_str()).collect::<Vec<_>>(), vec!["a.ts:1 pick has cognitive complexity 30 (was 12): split it into named steps; do not just move its branches into a lookup of closures"]);
        let fresh = judge(&root, &File { path: "a.ts".into(), before: String::new(), lines: vec![1] });
        assert!(fresh.1[0].message.contains("(a new function)"));
        std::fs::write(dir.join("a.ts"), &bigger).unwrap();
        let nudged = judge(&root, &File { path: "a.ts".into(), before: big, lines: vec![12] });
        assert_eq!((nudged.0, nudged.1.len()), (1, 0));
        let untouched = judge(&root, &File { path: "a.ts".into(), before: String::new(), lines: vec![99] });
        assert_eq!((untouched.0, untouched.1.len()), (0, 0));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
