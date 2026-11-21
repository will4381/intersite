//! Functions that do the same job with different code: compared by what they mean, not their shape. A function's
//! meaning is the words in it (its name twice over, the calls, properties, names and strings inside), stemmed and
//! with synonyms folded (fetch, load and read are all "get"), weighted by TF-IDF across the repository, so words every
//! function has count for little. Two functions whose weighted words point the same way (cosine) likely do one job.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;
use oxc_syntax::scope::ScopeFlags;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::text::{self, Lines};
use crate::{Answer, Finding, Request};

/// Words that say nothing about what a function does.
const CALLBACK_KEYS: &[&str] = &["mutationFn", "queryFn", "queryKey", "select", "onSuccess", "onError", "onSettled", "onMutate", "getNextPageParam", "getPreviousPageParam", "callback", "cb", "fn", "handler"];
const NOISE: &[&str] = &[
    "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "it", "be", "by", "at", "as", "if", "do", "no", "not", "this", "that", "with", "from",
    "data", "item", "items", "value", "values", "result", "results", "res", "req", "ctx", "context", "options", "opts", "args", "arg", "params", "param", "props",
    "x", "y", "i", "j", "k", "n", "e", "err", "error", "fn", "cb", "callback", "obj", "temp", "tmp", "val", "key", "length", "push", "then",
];

fn fold(word: &str) -> String {
    let w = text::stem(word);
    match w.as_str() {
        "fetch" | "load" | "read" | "retrieve" | "find" | "query" | "lookup" | "select" => "get".into(),
        "add" | "insert" | "make" | "new" | "build" | "generate" => "create".into(),
        "remove" | "destroy" | "drop" | "erase" | "purge" => "delete".into(),
        "edit" | "modify" | "patch" | "change" | "upsert" => "update".into(),
        "count" | "sum" | "tally" => "total".into(),
        "notify" | "dispatch" | "emit" | "deliver" | "post" | "mail" => "send".into(),
        "check" | "verify" | "validate" | "assert" | "ensure" => "valid".into(),
        "format" | "render" | "display" | "print" | "stringify" => "format".into(),
        "parse" | "decode" | "deserialize" => "parse".into(),
        _ => w,
    }
}

struct Unit {
    file: String,
    name: String,
    line: u32,
    end_line: u32,
    terms: HashMap<String, f64>,
}

struct Collector {
    file: String,
    lines: Lines,
    /// Named functions open around the walk, innermost last; words go to the innermost.
    open: Vec<Unit>,
    done: Vec<Unit>,
    pending_name: Option<String>,
}

impl Collector {
    fn add(&mut self, text: &str, weight: f64) {
        let Some(unit) = self.open.last_mut() else { return };
        for w in text::words(text) {
            if w.len() < 2 || NOISE.contains(&w.as_str()) || w.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            *unit.terms.entry(fold(&w)).or_default() += weight;
        }
    }

    fn open(&mut self, name: Option<String>, span: oxc_span::Span) -> bool {
        let Some(name) = name.or_else(|| self.pending_name.take()) else { return false };
        self.pending_name = None;
        // A callback named by a framework's option key (react-query's mutationFn, a handler's onSuccess) is not a unit:
        // every such callback shares the key, so its words go to the function around it.
        if CALLBACK_KEYS.contains(&name.as_str()) {
            return false;
        }
        let mut unit = Unit { file: self.file.clone(), name: name.clone(), line: self.lines.line(span.start as usize), end_line: self.lines.line(span.end as usize), terms: HashMap::new() };
        for w in text::words(&name) {
            if !NOISE.contains(&w.as_str()) {
                *unit.terms.entry(fold(&w)).or_default() += 2.0;
            }
        }
        self.open.push(unit);
        true
    }

    fn close(&mut self) {
        if let Some(u) = self.open.pop() {
            self.done.push(u);
        }
    }
}

impl<'a> Visit<'a> for Collector {
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        let name = it.id.as_ref().map(|id| id.name.as_str().to_string());
        let opened = self.open(name, it.span);
        walk::walk_function(self, it, flags);
        if opened {
            self.close();
        }
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        let opened = self.open(None, it.span);
        walk::walk_arrow_function_expression(self, it);
        if opened {
            self.close();
        }
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&it.id, &it.init) {
            if matches!(init, Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)) {
                self.pending_name = Some(id.name.as_str().to_string());
            }
        }
        walk::walk_variable_declarator(self, it);
        self.pending_name = None;
    }

    fn visit_method_definition(&mut self, it: &MethodDefinition<'a>) {
        self.pending_name = it.key.static_name().map(|k| k.to_string());
        walk::walk_method_definition(self, it);
        self.pending_name = None;
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        if matches!(it.value, Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)) {
            self.pending_name = it.key.static_name().map(|k| k.to_string());
        } else if let Some(k) = it.key.static_name() {
            self.add(&k, 1.0);
        }
        walk::walk_object_property(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        self.add(it.name.as_str(), 1.0);
    }

    fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
        self.add(it.name.as_str(), 0.5);
    }

    fn visit_identifier_name(&mut self, it: &IdentifierName<'a>) {
        self.add(it.name.as_str(), 1.0);
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        let s = it.value.as_str();
        if s.len() <= 60 {
            self.add(s, 0.5);
        }
    }

    fn visit_template_element(&mut self, it: &TemplateElement<'a>) {
        let s = it.value.raw.as_str();
        if s.len() <= 120 {
            self.add(s, 0.5);
        }
    }
}

fn units(file: &str, src: &str) -> Vec<Unit> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, src, SourceType::from_path(file).unwrap_or_default()).parse();
    if parsed.panicked {
        return vec![];
    }
    let mut c = Collector { file: file.to_string(), lines: Lines::new(src), open: vec![], done: vec![], pending_name: None };
    c.visit_program(&parsed.program);
    c.done
}

/// TF-IDF vectors, L2-normalised: (unit index, term id -> weight).
fn vectors(all: &[Unit]) -> (Vec<Vec<(usize, f64)>>, Vec<String>) {
    let mut ids: HashMap<&str, usize> = HashMap::new();
    let mut df: Vec<usize> = Vec::new();
    for u in all {
        for t in u.terms.keys() {
            let id = *ids.entry(t.as_str()).or_insert_with(|| {
                df.push(0);
                df.len() - 1
            });
            df[id] += 1;
        }
    }
    let n = all.len() as f64;
    let mut names = vec![String::new(); ids.len()];
    for (t, &id) in &ids {
        names[id] = t.to_string();
    }
    let vecs = all
        .iter()
        .map(|u| {
            let mut v: Vec<(usize, f64)> = u.terms.iter().map(|(t, tf)| {
                let id = ids[t.as_str()];
                (id, (1.0 + tf.ln()) * ((n + 1.0) / (df[id] as f64 + 1.0)).ln())
            }).collect();
            let norm = v.iter().map(|(_, w)| w * w).sum::<f64>().sqrt().max(1e-9);
            for e in &mut v {
                e.1 /= norm;
            }
            v.sort_by_key(|e| e.0);
            v
        })
        .collect();
    (vecs, names)
}

fn cosine(a: &[(usize, f64)], b: &[(usize, f64)]) -> f64 {
    let (mut i, mut j, mut s) = (0, 0, 0.0);
    while i < a.len() && j < b.len() {
        match a[i].0.cmp(&b[j].0) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                s += a[i].1 * b[j].1;
                i += 1;
                j += 1;
            }
        }
    }
    s
}

/// The terms that pull two vectors together most.
fn shared(a: &[(usize, f64)], b: &[(usize, f64)], names: &[String]) -> Vec<String> {
    let bm: HashMap<usize, f64> = b.iter().copied().collect();
    let mut s: Vec<(f64, usize)> = a.iter().filter_map(|(t, w)| bm.get(t).map(|v| (w * v, *t))).collect();
    s.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal));
    s.into_iter().take(5).map(|(_, t)| names[t].clone()).collect()
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let min_score = request.options.get("minScore").and_then(|v| v.as_f64()).unwrap_or(0.8);
    let min_terms = request.options.get("minTerms").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
    let at = request.options.get("at").and_then(|v| v.as_object()).map(|o| (o.get("file").and_then(|f| f.as_str()).unwrap_or("").to_string(), o.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32));
    let max = request.options.get("max").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
    let mut all: Vec<Unit> = request.files.par_iter().filter_map(|f| Some(units(f, &text::read(&request.root, f)?))).flatten().collect();
    all.retain(|u| u.terms.len() >= min_terms && u.end_line > u.line + 1);
    let (vecs, names) = vectors(&all);
    // Candidates share one of each other's strongest terms: an inverted index on each unit's top terms.
    let top: Vec<Vec<usize>> = vecs.iter().map(|v| {
        let mut s = v.clone();
        s.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        s.into_iter().take(8).map(|e| e.0).collect()
    }).collect();
    let mut index: HashMap<usize, Vec<usize>> = HashMap::new();
    for (u, terms) in top.iter().enumerate() {
        for &t in terms {
            index.entry(t).or_default().push(u);
        }
    }
    let nested = |a: &Unit, b: &Unit| a.file == b.file && a.line <= b.end_line && b.line <= a.end_line;
    let mut findings = Vec::new();
    let mut matches = Vec::new();
    if let Some((file, line)) = at {
        // Meaning search: the functions most like the one around a line.
        let Some(q) = all.iter().enumerate().filter(|(_, u)| u.file == file && u.line <= line && line <= u.end_line).min_by_key(|(_, u)| u.end_line - u.line).map(|(i, _)| i) else {
            return Err(format!("no function with enough words around {file}:{line}"));
        };
        let mut scored: Vec<(f64, usize)> = (0..all.len()).filter(|&i| i != q && !nested(&all[i], &all[q])).map(|i| (cosine(&vecs[q], &vecs[i]), i)).filter(|(s, _)| *s >= min_score * 0.75).collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (s, i) in scored.into_iter().take(max) {
            matches.push(serde_json::json!({ "file": all[i].file, "name": all[i].name, "line": all[i].line, "score": (s * 100.0).round() / 100.0, "shared": shared(&vecs[q], &vecs[i], &names) }));
        }
        return Ok(Answer { findings, summary: format!("{} functions compared with {} at {}:{}", all.len(), all[q].name, all[q].file, all[q].line), data: Some(serde_json::json!({ "matches": matches })) });
    }
    let changed: Vec<bool> = all.iter().map(|u| (u.line..=u.end_line).any(|l| request.changed(&u.file, l))).collect();
    let mut seen = HashSet::new();
    for a in 0..all.len() {
        if !changed[a] {
            continue;
        }
        let mut best: Option<(f64, usize)> = None;
        for &t in &top[a] {
            for &b in index.get(&t).into_iter().flatten() {
                if b == a || all[b].file == all[a].file || nested(&all[a], &all[b]) || (request.added.is_none() && b < a && changed[b]) {
                    continue;
                }
                let s = cosine(&vecs[a], &vecs[b]);
                if s >= min_score && best.is_none_or(|(bs, _)| s > bs) {
                    best = Some((s, b));
                }
            }
        }
        let Some((s, b)) = best else { continue };
        let key = if a < b { (a, b) } else { (b, a) };
        if !seen.insert(key) {
            continue;
        }
        let (u, v) = (&all[a], &all[b]);
        let words = shared(&vecs[a], &vecs[b], &names).join(", ");
        findings.push(Finding {
            file: u.file.clone(),
            line: u.line,
            target: format!("{}:{}", u.file, u.name),
            message: format!("{}:{} {} looks like it does the job of {}:{} {} ({:.0}% alike in what they use: {words}): read it, and call it or merge the two if so", u.file, u.line, u.name, v.file, v.line, v.name, s * 100.0),
        });
    }
    findings.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    Ok(Answer { findings, summary: format!("{} functions compared by meaning", all.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_job_different_code_scores_high_and_unrelated_low() {
        let a = units("a.ts", "export async function fetchUserById(id) {\n  const row = await prisma.user.findUnique({ where: { id } });\n  if (!row) throw new NotFoundError('user not found');\n  return { id: row.id, email: row.email, name: row.displayName };\n}\n");
        let b = units("b.ts", "export const loadUser = async (userId) => {\n  const user = await prisma.user.findFirst({ where: { id: userId } });\n  if (user === null) {\n    throw new NotFoundError(`no user ${userId}`);\n  }\n  return { id: user.id, email: user.email, name: user.displayName };\n};\n");
        let c = units("c.ts", "export function formatInvoiceTotal(lines, currency) {\n  const cents = lines.reduce((sum, line) => sum + line.amountCents * line.quantity, 0);\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);\n}\n");
        let all: Vec<Unit> = a.into_iter().chain(b).chain(c).collect();
        let (v, _) = vectors(&all);
        assert!(cosine(&v[0], &v[1]) > 0.6, "{}", cosine(&v[0], &v[1]));
        assert!(cosine(&v[0], &v[2]) < 0.2, "{}", cosine(&v[0], &v[2]));
    }
}
