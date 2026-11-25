//! The search command's engine, after Aroma's structural search: the functions in the repository that contain a piece
//! of code. Candidates by shared features, then each pruned to the part that matches, ranked by how much of the query
//! that part holds. Renamed variables and reordered or extra statements still match.

use std::collections::HashMap;

use crate::aroma::{self, Unit};
use crate::{Answer, Request};

/// How many candidates by shared features are pruned: Aroma's first phase keeps a fixed number before reranking.
const CANDIDATES: usize = 100;
/// A match holds at least this share of the query's features. Tuned on half-function queries over Intersite: the
/// function each came from held 89% or more of nine in ten, and the best unrelated match held under 50%.
const MIN_SHARE: f64 = 0.5;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    query: Query,
    /// At most this many matches.
    max: usize,
}

/// Code on stdin or a whole file, a range of lines, or the function around one line.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Query {
    Snippet { text: String, file: Option<String>, ext: Option<String> },
    Lines { text: String, file: String, from: u32, to: u32 },
    Around { text: String, file: String, line: u32 },
}

/// The query and the lines it covers in its file, if it is one, so it does not match itself.
fn query(q: Query) -> Result<(Unit, Option<String>, u32, u32), String> {
    match q {
        Query::Snippet { text, file, ext } => {
            let unit = aroma::snippet(&text, ext.as_deref().unwrap_or(".tsx")).ok_or("no code to search for")?;
            let to = text.split('\n').count() as u32;
            Ok((unit, file, 1, to))
        }
        Query::Lines { text, file, from, to } => {
            Ok((aroma::lines(&file, &text, from, to).ok_or("the file does not parse")?, Some(file), from, to))
        }
        Query::Around { text, file, line } => {
            // The innermost function around the line, or the line alone.
            let around =
                aroma::units(&file, &text).into_iter().filter(|u| u.line <= line && line <= u.end_line).min_by_key(|u| u.end_line - u.line);
            match around {
                Some(u) => {
                    let (from, to) = (u.line, u.end_line);
                    Ok((u, Some(file), from, to))
                }
                None => Ok((aroma::lines(&file, &text, line, line).ok_or("the file does not parse")?, Some(file), line, line)),
            }
        }
    }
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { query: q, max } = request.options()?;
    let (q, file, from, to) = query(q)?;
    if q.bag.is_empty() {
        return Err("no code to search for: point at lines that hold code, or pass a snippet that parses".into());
    }
    let cache_dir = std::path::Path::new(&request.root).join("node_modules/.cache/intersite");
    let all = aroma::index_units(&request.root, &request.files, &cache_dir);
    let is_self = |f: &str, line: u32, end: u32| file.as_deref() == Some(f) && line <= to && from <= end;
    let mut candidates: Vec<(usize, &aroma::Indexed)> = all
        .iter()
        .filter(|u| !is_self(&u.file, u.line, u.end_line))
        .map(|u| (aroma::overlap(&u.set, &q.set), u))
        .filter(|c| c.0 > 0)
        .collect();
    candidates.sort_by_key(|a| std::cmp::Reverse(a.0));
    candidates.truncate(CANDIDATES);
    let want = aroma::counts(&q.bag);
    let query_lines: Vec<u32> = q.leaves.iter().map(|l| l.line).collect();
    let length = query_lines.iter().max().unwrap_or(&0) - query_lines.iter().min().unwrap_or(&0) + 1;
    let mut parsed: HashMap<String, Vec<Unit>> = HashMap::new();
    let mut ranked = Vec::new();
    for (_, u) in candidates {
        let units = parsed
            .entry(u.file.clone())
            .or_insert_with(|| aroma::units(&u.file, &aroma::read_source(&request.root, &u.file).unwrap_or_default()));
        let Some(unit) = units.iter().find(|x| x.line == u.line && x.name == u.name) else { continue };
        let (score, kept) = aroma::prune(&want, &unit.leaves);
        if kept.is_empty() {
            continue;
        }
        let (a, b) = aroma::span(&kept.iter().map(|&i| unit.leaves[i].line).collect::<Vec<_>>());
        // Matches scattered over a long function are shared idioms, not the code searched for.
        if aroma::scattered(a, b, length) {
            continue;
        }
        ranked.push((score as f64 / q.bag.len() as f64, u.size, u, a, b));
    }
    ranked.sort_by(|x, y| y.0.total_cmp(&x.0).then(x.1.cmp(&y.1)));
    let mut shown: Vec<serde_json::Value> = Vec::new();
    let mut spans: Vec<(String, u32, u32)> = Vec::new();
    for (share, size, u, a, b) in ranked {
        if shown.len() == max || share < MIN_SHARE {
            break;
        }
        // A function nested in another is one match: the better scored, or with equal scores the smaller, is shown.
        if spans.iter().any(|(f, l, e)| *f == u.file && *l <= u.end_line && u.line <= *e) {
            continue;
        }
        spans.push((u.file.clone(), u.line, u.end_line));
        shown.push(serde_json::json!({ "file": u.file, "name": u.name, "line": u.line, "endLine": u.end_line, "size": size, "share": share, "from": a, "to": b }));
    }
    let data = serde_json::json!({ "query": { "file": file, "from": from, "to": to, "features": q.bag.len() }, "functions": all.len(), "matches": shown, "minShare": MIN_SHARE });
    Ok(Answer { findings: vec![], summary: String::new(), data: Some(data) })
}
