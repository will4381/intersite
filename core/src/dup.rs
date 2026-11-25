//! The duplicates check: an added block of N or more lines that already exists elsewhere in the repository. Lines are
//! compared trimmed with runs of whitespace as one space, blank lines dropped (so a block still matches after blank
//! lines were added or removed); a window that is mostly closing brackets, imports or comments does not count.

use rayon::prelude::*;
use regex::Regex;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::LazyLock;

use crate::{Answer, Finding, Request};

/// Closing brackets, imports, single tokens, comments: lines that repeat everywhere without being pasted code.
static TRIVIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[\[\](){};,]*|import\b.*|export\s+(?:\*|\{[^}]*\})\s*from\b.*|\}?\s*from\s.*|[\w$.]+[;,]?|\}?\s*else\s*\{?|//.*|/?\*.*|#.*|</[\w.]+>)$").unwrap()
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
const MAX_BYTES: u64 = 256 * 1024;

/// A file's non-blank lines: number, hash of the normalised text, and whether it is trivial.
struct Lines {
    line: Vec<u32>,
    hash: Vec<u64>,
    trivial: Vec<bool>,
}

/// The file's lines, or None for missing, binary, generated or minified text.
fn read(root: &str, file: &str) -> Option<Lines> {
    let text = crate::text::read_up_to(root, file, MAX_BYTES)?;
    let raw: Vec<&str> = text.split('\n').collect();
    if text.len() / raw.len().max(1) > 200 {
        return None;
    }
    let mut out = Lines { line: vec![], hash: vec![], trivial: vec![] };
    for (i, r) in raw.iter().enumerate() {
        let s = SPACES.replace_all(r.trim(), " ");
        if s.is_empty() {
            continue;
        }
        let mut h = std::collections::hash_map::DefaultHasher::new();
        s.hash(&mut h);
        out.line.push(i as u32 + 1);
        out.hash.push(h.finish());
        out.trivial.push(TRIVIAL.is_match(&s));
    }
    Some(out)
}

/// The hash of the `n` lines from `i`, or None when most of them are trivial.
fn window(f: &Lines, i: usize, n: usize) -> Option<u64> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let mut real = 0;
    for k in i..i + n {
        f.hash[k].hash(&mut h);
        real += usize::from(!f.trivial[k]);
    }
    (real * 2 >= n).then(|| h.finish())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// A block is this many lines or more.
    lines: usize,
    /// The changed files in the order the diff lists them, so findings come out in that order.
    changed: Vec<String>,
    /// Judging the whole repository: every line is new.
    whole: bool,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { lines: n, changed: order, whole } = request.options()?;
    let added = request.added.clone().unwrap_or_default();
    let whole = request.added.is_none() || whole;
    let all: Vec<Option<Lines>> = request.files.par_iter().map(|f| read(&request.root, f)).collect();
    // One index of every window of pre-existing lines, first occurrence first. Windows touching added lines are left
    // out, so the added block never matches itself, and code moved within the change has no original to match.
    let mut index: HashMap<u64, (usize, u32)> = HashMap::new();
    for (fi, f) in all.iter().enumerate() {
        let Some(f) = f else { continue };
        let fresh = added.get(request.files[fi].as_str());
        for i in 0..(f.line.len() + 1).saturating_sub(n) {
            if !whole && fresh.is_some_and(|set| f.line[i..i + n].iter().any(|l| set.contains(l))) {
                continue;
            }
            if let Some(key) = window(f, i, n) {
                index.entry(key).or_insert((fi, f.line[i]));
            }
        }
    }
    let position: HashMap<&str, usize> = request.files.iter().enumerate().map(|(i, f)| (f.as_str(), i)).collect();
    let mut findings = Vec::new();
    let mut checked = 0;
    for file in &order {
        let Some(fresh) = added.get(file.as_str()).filter(|s| !s.is_empty()) else { continue };
        let Some(f) = read(&request.root, file) else { continue };
        checked += 1;
        let own = if whole { position.get(file.as_str()).copied() } else { None };
        let mut run: Option<(usize, usize, (usize, u32))> = None;
        let flush = |run: &mut Option<(usize, usize, (usize, u32))>, findings: &mut Vec<Finding>| {
            if let Some((first, last, (fi, line))) = run.take() {
                findings.push(Finding {
                    file: file.clone(),
                    line: f.line[first],
                    target: file.clone(),
                    message: format!(
                        "{file}:{} repeats {}:{line} ({} lines): reuse it",
                        f.line[first],
                        request.files[fi],
                        last - first + n
                    ),
                });
            }
        };
        for i in 0..(f.line.len() + 1).saturating_sub(n) {
            let at = if f.line[i..i + n].iter().all(|l| fresh.contains(l)) {
                window(&f, i, n).and_then(|k| index.get(&k).copied())
            } else {
                None
            };
            // A block inside its own original is not a copy; one that only overlaps it (a repeating pattern) is not either.
            let own_overlap = at.is_some_and(|(fi, line)| Some(fi) == own && (line as i64 - f.line[i] as i64).unsigned_abs() < n as u64);
            match at {
                Some(a) if !own_overlap => match &mut run {
                    Some(r) => r.1 = i,
                    None => run = Some((i, i, a)),
                },
                _ => flush(&mut run, &mut findings),
            }
        }
        flush(&mut run, &mut findings);
    }
    Ok(Answer::new(findings, format!("{checked} changed source files checked against {} tracked files", request.files.len())))
}
