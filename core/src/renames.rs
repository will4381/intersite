//! A rename the compiler finished but the words did not: an identifier the change renamed everywhere in code that
//! is still written under its old name in strings, comments and docs, where nothing checks it. A log line, an error
//! message, an API doc or a config key that names the old identifier now points at nothing.

use rayon::prelude::*;
use std::collections::BTreeMap;

use crate::text::{self, Lines};
use crate::{Answer, Finding, Request};

/// Files whose code the rename went through: the old name's absence from their code proves the rename is complete.
fn is_code(file: &str) -> bool {
    let ext = file.rsplit('.').next().unwrap_or("");
    matches!(ext, "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx")
}

/// Files that record history on purpose: the old name belongs there.
fn is_history(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file).to_ascii_uppercase();
    name.starts_with("CHANGELOG")
        || name.starts_with("HISTORY")
        || name.starts_with("RELEASE")
        || name.ends_with(".LOCK")
        || name.contains("LOCK.")
        || file.contains("migrations/")
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The identifiers in a line, in order.
fn identifiers(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in line.char_indices() {
        match (start, is_ident(c)) {
            (None, true) if !c.is_ascii_digit() => start = Some(i),
            (Some(s), false) => {
                out.push(&line[s..i]);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push(&line[s..]);
    }
    out
}

/// Whether a name is specific enough that finding it elsewhere means this identifier: `userId`, `MAX_RETRIES`,
/// `fetchOrders`, not `data` or `id`.
fn specific(name: &str) -> bool {
    let multiword = name.chars().skip(1).any(|c| c.is_ascii_uppercase()) || name.trim_matches('_').contains('_');
    name.len() >= 4 && (multiword || name.len() >= 8)
}

/// Byte offsets where `word` stands alone, not inside a longer identifier.
fn find_word(hay: &str, word: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = hay[from..].find(word) {
        let at = from + i;
        let before = hay[..at].chars().next_back().is_none_or(|c| !is_ident(c));
        let after = hay[at + word.len()..].chars().next().is_none_or(|c| !is_ident(c));
        if before && after {
            out.push(at);
        }
        from = at + word.len();
    }
    out
}

/// Renames in a unified diff: a removed line and the added line in its place whose identifiers differ only by one
/// name, swapped for another, every time it differs. Returns old name -> (new name, file, line of the new line).
fn renames(patch: &str, prefix: &str) -> BTreeMap<String, (String, String, u32)> {
    let mut found = BTreeMap::new();
    let mut file = String::new();
    let mut line = 0u32;
    let (mut removed, mut added): (Vec<&str>, Vec<(u32, &str)>) = (vec![], vec![]);
    let flush = |file: &str, removed: &mut Vec<&str>, added: &mut Vec<(u32, &str)>, found: &mut BTreeMap<String, (String, String, u32)>| {
        if removed.len() == added.len() && is_code(file) {
            for (old, (n, new)) in removed.iter().zip(added.iter()) {
                let (a, b) = (identifiers(old), identifiers(new));
                if a.len() != b.len() {
                    continue;
                }
                let swaps: Vec<(&str, &str)> = a.iter().zip(&b).filter(|(x, y)| x != y).map(|(x, y)| (*x, *y)).collect();
                if let Some(&(from, to)) = swaps.first() {
                    if swaps.iter().all(|s| *s == (from, to)) && specific(from) && specific(to) {
                        found.entry(from.to_string()).or_insert((to.to_string(), format!("{prefix}{file}"), *n));
                    }
                }
            }
        }
        removed.clear();
        added.clear();
    };
    for l in patch.lines() {
        if let Some(path) = l.strip_prefix("+++ b/") {
            flush(&file, &mut removed, &mut added, &mut found);
            file = path.to_string();
        } else if l.starts_with("+++ ") || l.starts_with("--- ") || l.starts_with("diff --git") {
            flush(&file, &mut removed, &mut added, &mut found);
        } else if let Some(rest) = l.strip_prefix("@@ ") {
            flush(&file, &mut removed, &mut added, &mut found);
            line = rest.split_whitespace().nth(1).and_then(|p| p.trim_start_matches('+').split(',').next()?.parse().ok()).unwrap_or(0);
        } else if let Some(text) = l.strip_prefix('-') {
            removed.push(text);
        } else if let Some(text) = l.strip_prefix('+') {
            added.push((line, text));
            line += 1;
        }
    }
    flush(&file, &mut removed, &mut added, &mut found);
    found
}

/// One old name found in a file: its index, whether it is still in the code, and the lines it is written on.
type Hit = (usize, bool, Vec<u32>);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// The change as `git diff -U0 -M`.
    patch: String,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { patch } = request.options()?;
    let found = renames(&patch, &request.prefix);
    if found.is_empty() {
        return Ok(Answer::new(vec![], "no renames in the change".into()));
    }
    let olds: Vec<&String> = found.keys().collect();
    // Per file: for each old name, whether it is still in the code, and where it is in words.
    let per_file: Vec<(String, Vec<Hit>)> = request
        .files
        .par_iter()
        .filter(|f| !is_history(f))
        .filter_map(|file| {
            let src = text::read(&request.root, file)?;
            if !olds.iter().any(|o| src.contains(o.as_str())) {
                return None;
            }
            let code = is_code(file).then(|| text::strip_code(&src));
            let lines = Lines::new(&src);
            let hits = olds
                .iter()
                .enumerate()
                .filter_map(|(i, old)| {
                    let at = find_word(&src, old);
                    if at.is_empty() {
                        return None;
                    }
                    let in_code = code.as_ref().is_some_and(|c| !find_word(c, old).is_empty());
                    Some((i, in_code, at.iter().map(|&o| lines.line(o)).collect()))
                })
                .collect();
            Some((file.clone(), hits))
        })
        .collect();
    let mut findings = Vec::new();
    for (i, (old, (new, file, line))) in found.iter().enumerate() {
        // Still in some file's code: the rename is partial, or another identifier shares the name.
        if per_file.iter().any(|(_, hits)| hits.iter().any(|(j, in_code, _)| *j == i && *in_code)) {
            continue;
        }
        let left: Vec<String> = per_file
            .iter()
            .filter_map(|(f, hits)| hits.iter().find(|(j, _, _)| *j == i).map(|(_, _, lines)| format!("{f}:{}", lines[0])))
            .collect();
        if left.is_empty() {
            continue;
        }
        let more = left.len().saturating_sub(5);
        let shown = left.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        findings.push(Finding {
            file: file.clone(),
            line: *line,
            target: format!("renames:{old}"),
            message: format!("{file}:{line} renames {old} to {new} in code, but {old} is still written in {shown}{}: strings, comments and docs that nothing checks; rename those too", if more > 0 { format!(" and {more} more") } else { String::new() }),
        });
    }
    Ok(Answer::new(findings, format!("{} renames checked", found.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rename_is_one_name_swapped_on_a_replaced_line() {
        let patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3 +3 @@\n-export function fetchOrders(userId) { return get(userId); }\n+export function loadOrders(userId) { return get(userId); }\n@@ -9 +9 @@\n-const total = sum(items);\n+const total = sum(lines);\n";
        let got = renames(patch, "");
        assert_eq!(got.keys().collect::<Vec<_>>(), vec!["fetchOrders"]);
        assert_eq!(got["fetchOrders"], ("loadOrders".to_string(), "src/a.ts".to_string(), 3));
    }
}
