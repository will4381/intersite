//! The complexity gate: a changed function whose cognitive complexity (SonarSource's definition, in functions.rs) ends
//! at 25 or more, when it is new or the change added 10 or more. Only the change is judged, never what was already
//! there: an absolute threshold on old code would only be nagging.

use rayon::prelude::*;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use crate::functions::{self, Func};
use crate::{Answer, Finding, Request};

const FAIL_AT: u32 = 25;
const GROWTH: u32 = 10;
/// How alike two bodies' words must be (Jaccard) for one to be the other moved, renamed and lightly edited.
const ALIKE: f64 = 0.6;
/// Fewer words than this say too little about a body to tell it from another.
const FEW_WORDS: usize = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    path: String,
    /// Its path on the base, "" when it is new.
    from: String,
    /// Lines the change added.
    lines: Vec<u32>,
}

/// A file the change touched, as it was on the base.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseFile {
    path: String,
    text: String,
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

/// A function's body with its whitespace dropped: the same after a move, a rename or a reformat.
fn fingerprint(text: &str, f: &Func) -> String {
    text.get(f.body.0 as usize..f.body.1 as usize).unwrap_or("").split_whitespace().collect()
}

/// The words of a function's body: identifiers and literals of three or more characters.
fn words<'t>(text: &'t str, f: &Func) -> HashSet<&'t str> {
    let body = text.get(f.body.0 as usize..f.body.1 as usize).unwrap_or("");
    body.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .filter(|w| w.len() >= 3 && !w.bytes().all(|b| b.is_ascii_digit()))
        .collect()
}

/// The base's outermost functions, found four ways: by file and key; and, for one no longer where it was (moved, not
/// copied), by body, for one moved or renamed unchanged; by name, for one moved to a file git does not pair with its
/// old one, when no other such function has that name; and by the words of its body, for one moved, renamed and
/// lightly edited (calls to renamed helpers) in one go.
#[derive(Default)]
struct Base {
    by_key: HashMap<(String, String), u32>,
    by_body: HashMap<String, u32>,
    by_name: HashMap<String, Option<u32>>,
    /// Only functions complex enough to excuse one at `FAIL_AT`: the others could never change a verdict.
    by_words: Vec<(u32, HashSet<String>)>,
}

impl Base {
    fn new(root: &str, files: &[BaseFile]) -> Self {
        let read: Vec<_> = files
            .par_iter()
            .filter_map(|b| {
                let shape = functions::read(&b.path, &b.text)?;
                // The keys its file still has: a function there now did not move.
                let head = crate::text::read(root, &b.path).and_then(|text| functions::read(&b.path, &text));
                let kept: HashSet<String> = head.map(|h| keyed(&h.funcs).into_iter().map(|(k, _)| k).collect()).unwrap_or_default();
                Some((b, shape, kept))
            })
            .collect();
        let mut base = Base::default();
        for (file, shape, kept) in &read {
            for (key, f) in keyed(&shape.funcs) {
                base.by_key.insert((file.path.clone(), key.clone()), f.complexity);
                if kept.contains(&key) {
                    continue;
                }
                base.by_body.entry(fingerprint(&file.text, f)).or_insert(f.complexity);
                if !f.callback {
                    // A name two base functions share says nothing about which one moved.
                    base.by_name.entry(f.name.clone()).and_modify(|c| *c = None).or_insert(Some(f.complexity));
                }
                let found = words(&file.text, f);
                if f.complexity + GROWTH > FAIL_AT && found.len() >= FEW_WORDS {
                    base.by_words.push((f.complexity, found.into_iter().map(String::from).collect()));
                }
            }
        }
        base
    }

    /// The complexity the function had on the base, when it was there.
    fn before(&self, file: &File, key: &str, text: &str, f: &Func) -> Option<u32> {
        let paired = (!file.from.is_empty()).then(|| self.by_key.get(&(file.from.clone(), key.to_string()))).flatten();
        let named = || if f.callback { None } else { self.by_name.get(&f.name).copied().flatten() };
        paired.or_else(|| self.by_body.get(&fingerprint(text, f))).copied().or_else(named).or_else(|| self.alike(text, f))
    }

    /// The complexity of the base function whose body's words are most like this one's, when alike enough.
    fn alike(&self, text: &str, f: &Func) -> Option<u32> {
        let mine = words(text, f);
        if mine.len() < FEW_WORDS {
            return None;
        }
        let score = |theirs: &HashSet<String>| {
            let shared = mine.iter().filter(|w| theirs.contains(**w)).count();
            shared as f64 / (mine.len() + theirs.len() - shared).max(1) as f64
        };
        let best = self.by_words.iter().map(|(complexity, theirs)| (score(theirs), *complexity)).max_by(|a, b| a.0.total_cmp(&b.0));
        best.filter(|(score, _)| *score >= ALIKE).map(|(_, complexity)| complexity)
    }
}

fn judge(root: &str, file: &File, base: &Base) -> (usize, Vec<Finding>) {
    let Some(text) = crate::text::read(root, &file.path) else { return (0, vec![]) };
    let Some(head) = functions::read(&file.path, &text) else { return (0, vec![]) };
    let mut checked = 0;
    let mut findings = Vec::new();
    for (key, f) in keyed(&head.funcs) {
        if !file.lines.iter().any(|l| (f.line..=f.end_line).contains(l)) {
            continue;
        }
        checked += 1;
        if f.complexity < FAIL_AT {
            continue;
        }
        let before = base.before(file, &key, &text, f);
        if before.is_some_and(|b| f.complexity < b + GROWTH) {
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
    let read = |key: &str| request.options.get(key).cloned().unwrap_or(serde_json::Value::Array(vec![]));
    let files: Vec<File> = serde_json::from_value(read("files")).map_err(|e| e.to_string())?;
    let base: Vec<BaseFile> = serde_json::from_value(read("base")).map_err(|e| e.to_string())?;
    let base = Base::new(&request.root, &base);
    let judged: Vec<(usize, Vec<Finding>)> = files.par_iter().map(|f| judge(&request.root, f, &base)).collect();
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

    /// Judges `head` written at `path`, with `before` as the base file `from` ("" when new) and `others` as the other
    /// files the change touched.
    fn judged(path: &str, head: &str, from: &str, before: &str, others: &[(&str, &str)], lines: Vec<u32>) -> (usize, Vec<String>) {
        let dir = std::env::temp_dir().join(format!("intersite-complexity-{}-{path}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(path), head).unwrap();
        let mut files: Vec<BaseFile> = others.iter().map(|(p, t)| BaseFile { path: p.to_string(), text: t.to_string() }).collect();
        if !from.is_empty() {
            files.push(BaseFile { path: from.into(), text: before.into() });
        }
        let file = File { path: path.into(), from: from.into(), lines };
        let root = dir.to_string_lossy();
        let (n, findings) = judge(&root, &file, &Base::new(&root, &files));
        std::fs::remove_dir_all(dir).unwrap();
        (n, findings.into_iter().map(|f| f.message).collect())
    }

    fn pick(name: &str, n: usize) -> String {
        format!("export function {name}(a, b) {{\n{}  return -1;\n}}\n", branches(n))
    }

    #[test]
    fn reports_a_function_that_crossed_the_bar_by_growing_not_one_already_over_it() {
        // Each branch costs 3 (an if, and a nested if): 4 branches are 12, 10 are 30.
        let (small, big, bigger) = (pick("pick", 4), pick("pick", 10), pick("pick", 11));
        assert_eq!(judged("a.ts", &big, "a.ts", &small, &[], vec![5]).1, vec!["a.ts:1 pick has cognitive complexity 30 (was 12): split it into named steps; do not just move its branches into a lookup of closures"]);
        assert!(judged("a.ts", &big, "", "", &[], vec![1]).1[0].contains("(a new function)"));
        assert_eq!(judged("a.ts", &bigger, "a.ts", &big, &[], vec![12]), (1, vec![]));
        assert_eq!(judged("a.ts", &big, "", "", &[], vec![99]), (0, vec![]));
    }

    #[test]
    fn a_function_moved_to_another_file_or_renamed_is_judged_against_its_old_self() {
        let big = pick("pick", 10);
        let old = format!("import x from 'x';\n{big}");
        // Moved out of a file that stays, into a new one: found by name.
        assert_eq!(judged("b.ts", &big, "", "", &[("a.ts", &old)], vec![1]), (1, vec![]));
        // Renamed as it moved: found by its body.
        assert_eq!(judged("b.ts", &pick("choose", 10), "", "", &[("a.ts", &old)], vec![1]), (1, vec![]));
        // Moved and grown by 10 or more: still reported, against what it was.
        assert!(judged("b.ts", &pick("pick", 14), "", "", &[("a.ts", &old)], vec![1]).1[0].contains("(was 30)"));
        // Renamed with a renamed call inside: found by the words of its body.
        let settle = |name: &str, read: &str| {
            let steps: String = (0..10)
                .map(|i| format!("  if (order.status === 'step{i}') {{ if (order.paid) return {read}(order, ledger{i}); }}\n"))
                .collect();
            format!("export function {name}(order) {{\n{steps}  return null;\n}}\n")
        };
        let was = settle("settlePostgresOrder", "readPostgresLedger");
        assert_eq!(judged("b.ts", &settle("settleOrder", "readLedger"), "", "", &[("a.ts", &was)], vec![1]), (1, vec![]));
        // A copy is new: its old self is still where it was.
        let dir = std::env::temp_dir().join(format!("intersite-complexity-{}-b.ts", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), &old).unwrap();
        std::fs::write(dir.join("b.ts"), &big).unwrap();
        let root = dir.to_string_lossy();
        let base = Base::new(&root, &[BaseFile { path: "a.ts".into(), text: old.clone() }]);
        let copied = judge(&root, &File { path: "b.ts".into(), from: String::new(), lines: vec![1] }, &base);
        assert!(copied.1[0].message.contains("(a new function)"));
        std::fs::remove_dir_all(dir).unwrap();
        // A name two base functions had says nothing about which one moved, so an unrelated new one is new.
        let twice = [("a.ts", old.as_str()), ("c.ts", "export function pick() { return 1; }\n")];
        assert!(judged("b.ts", &pick("pick", 11), "", "", &twice, vec![1]).1[0].contains("(a new function)"));
    }
}
