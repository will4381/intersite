//! Structural features of JavaScript and TypeScript code, after Aroma (Luan et al., "Aroma: Code Recommendation via
//! Structural Code Search", OOPSLA 2019, arXiv 1812.01158). A file is parsed (oxc, serialised as ESTree) into a
//! simplified tree whose inner nodes are labelled by their syntax. Every name and literal (a leaf) yields features:
//! itself; itself with its place in its parent, grandparent and great-grandparent; itself with the next leaf; and for a
//! local variable, the places of two consecutive uses. Local names become #VAR, so a renamed copy has the same
//! features. Overlap of feature sets finds candidates fast, and `prune` keeps the part of a candidate that matches a
//! query: how much of one piece of code sits inside another. Hashes are computed exactly as the JavaScript version did.

use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;
use rayon::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};

use crate::globals::JS_GLOBALS;
use crate::text::Lines;

const TYPE_KEYS: &[&str] =
    &["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments", "decorators", "implements"];
/// Nodes that only wrap one expression or statement: what they wrap stands in their place.
const WRAPPERS: &[&str] = &[
    "ExpressionStatement",
    "ChainExpression",
    "ParenthesizedExpression",
    "JSXExpressionContainer",
    "TSAsExpression",
    "TSSatisfiesExpression",
    "TSNonNullExpression",
    "TSTypeAssertion",
    "TSInstantiationExpression",
];
const FUNCTIONS: &[&str] = &["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];
const DROPPED: &[&str] = &["EmptyStatement", "JSXEmptyExpression", "JSXClosingElement", "JSXClosingFragment", "ImportDeclaration"];
const BROWSER: &[&str] = &["window", "document", "localStorage", "sessionStorage", "navigator", "location", "history"];
const NOT_CODE: &[&str] = &[
    "type",
    "start",
    "end",
    "range",
    "loc",
    "raw",
    "operator",
    "kind",
    "computed",
    "optional",
    "prefix",
    "async",
    "generator",
    "shorthand",
    "method",
    "static",
    "delegate",
    "directive",
];
const LITERAL_CHARS: usize = 40;
const SLOT: i32 = 35;
/// Bumped when features change, so a cache from an older Intersite is recomputed.
const VERSION: &str = "rust-1:oxc-0.116";
const MAX_BYTES: u64 = 256 * 1024;

/// FNV-1a over UTF-16 code units, as `Math.imul` computed it.
pub fn hash_of(s: &str) -> i32 {
    let mut h: i32 = 0x811c9dc5u32 as i32;
    for c in s.encode_utf16() {
        h = (h ^ c as i32).wrapping_mul(0x01000193);
    }
    h
}

/// One feature from a kind and up to three hashed parts.
fn mix(kind: i32, a: i32, b: i32, c: i32) -> i32 {
    let mut h = (0x811c9dc5u32 as i32 ^ kind).wrapping_mul(0x01000193);
    h = (h ^ a).wrapping_mul(0x01000193);
    h = (h ^ b).wrapping_mul(0x01000193);
    (h ^ c).wrapping_mul(0x01000193)
}

#[derive(Clone)]
struct Leaf {
    id: i32,
    name: String,
    local: bool,
    at: u64,
}

struct Tree {
    label: i32,
    kids: Vec<Simple>,
    member: bool,
}

enum Simple {
    Kw(String),
    Leaf(Leaf),
    Tree(Tree),
}

#[derive(Clone, Debug)]
pub struct Featured {
    pub at: u64,
    pub line: u32,
    pub feats: Vec<i32>,
}

#[derive(Clone, Debug)]
pub struct Unit {
    pub name: String,
    pub line: u32,
    pub end_line: u32,
    pub leaves: Vec<Featured>,
    pub bag: Vec<i32>,
    pub set: Vec<i32>,
}

#[derive(Clone, Debug)]
pub struct Indexed {
    pub file: String,
    pub name: String,
    pub line: u32,
    pub end_line: u32,
    pub size: usize,
    pub set: Vec<i32>,
}

fn ty(n: &Value) -> &str {
    n["type"].as_str().unwrap_or("")
}

fn start(n: &Value) -> u64 {
    n["start"].as_u64().unwrap_or(0)
}

fn is_node(v: &Value) -> bool {
    v.get("type").is_some_and(|t| t.is_string())
}

/// The keys that may hold code on a node, type annotations left out, in the serializer's order.
fn code_keys(n: &Value) -> Vec<&str> {
    n.as_object()
        .map(|o| o.keys().map(String::as_str).filter(|k| !NOT_CODE.contains(k) && !TYPE_KEYS.contains(k)).collect())
        .unwrap_or_default()
}

/// The child nodes under the given keys of a node.
fn children<'v>(n: &'v Value, keys: &[&str]) -> Vec<&'v Value> {
    let mut out = Vec::new();
    for key in keys {
        match &n[*key] {
            Value::Array(items) => out.extend(items.iter().filter(|c| is_node(c))),
            v if is_node(v) => out.push(v),
            _ => {}
        }
    }
    out
}

/// Adds the names a binding pattern declares.
fn declare(p: &Value, out: &mut HashSet<String>) {
    match ty(p) {
        "Identifier" => {
            if let Some(n) = p["name"].as_str() {
                out.insert(n.to_string());
            }
        }
        "ObjectPattern" => {
            for q in p["properties"].as_array().into_iter().flatten() {
                declare(if ty(q) == "RestElement" { &q["argument"] } else { &q["value"] }, out);
            }
        }
        "ArrayPattern" => p["elements"].as_array().into_iter().flatten().for_each(|q| declare(q, out)),
        "RestElement" => declare(&p["argument"], out),
        "AssignmentPattern" => declare(&p["left"], out),
        "TSParameterProperty" => declare(&p["parameter"], out),
        _ => {}
    }
}

/// The name a function goes by: its own, the variable or property it is assigned to, the variable a call wrapping it
/// is assigned to (`const Card = memo(() => …)`), or the file's name for a default export.
fn name_of(f: &Value, path: &[&Value], fallback: &str) -> Option<String> {
    if let Some(n) = f["id"]["name"].as_str() {
        return Some(n.to_string());
    }
    let parent = path.last().copied();
    let grand = if path.len() >= 2 { Some(path[path.len() - 2]) } else { None };
    let same = |a: &Value, b: &Value| std::ptr::eq(a, b);
    if let Some(p) = parent {
        if ty(p) == "VariableDeclarator" && same(&p["init"], f) && ty(&p["id"]) == "Identifier" {
            return p["id"]["name"].as_str().map(str::to_string);
        }
        if matches!(ty(p), "Property" | "MethodDefinition" | "PropertyDefinition")
            && same(&p["value"], f)
            && p["computed"] != Value::Bool(true)
        {
            return p["key"]["name"].as_str().map(str::to_string).or_else(|| Some(js_string(&p["key"]["value"])));
        }
        if ty(p) == "ExportDefaultDeclaration" {
            return Some(fallback.to_string());
        }
        if let Some(g) = grand {
            if ty(p) == "CallExpression" && ty(g) == "VariableDeclarator" && same(&g["init"], p) && ty(&g["id"]) == "Identifier" {
                return g["id"]["name"].as_str().map(str::to_string);
            }
        }
    }
    None
}

/// `String(value)` as JavaScript writes it.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Number(n) => {
            n.as_f64().map_or(n.to_string(), |f| if f.fract() == 0.0 && f.abs() < 1e21 { format!("{}", f as i64) } else { format!("{f}") })
        }
        other => other.to_string(),
    }
}

struct Scan {
    names: HashSet<String>,
    called: HashSet<String>,
    functions: Vec<(String, u64, u64)>,
}

/// One pass over a program: names declared inside functions (or everywhere, for a snippet), names called directly,
/// and every named function.
fn scan(program: &Value, everywhere: bool, fallback: &str) -> Scan {
    fn visit<'v>(n: &'v Value, inside: bool, everywhere: bool, fallback: &str, path: &mut Vec<&'v Value>, out: &mut Scan) {
        let t = ty(n);
        let f = FUNCTIONS.contains(&t);
        if f {
            for p in n["params"].as_array().into_iter().flatten() {
                declare(p, &mut out.names);
            }
            if let Some(name) = name_of(n, path, fallback) {
                out.functions.push((name, start(n), n["end"].as_u64().unwrap_or(0)));
            }
        }
        if inside || everywhere {
            if t == "VariableDeclarator" {
                declare(&n["id"], &mut out.names);
            }
            if t == "CatchClause" {
                declare(&n["param"], &mut out.names);
            }
            if (t == "FunctionDeclaration" || t == "ClassDeclaration") && n["id"].is_object() {
                if let Some(id) = n["id"]["name"].as_str() {
                    out.names.insert(id.to_string());
                }
            }
        }
        if t == "CallExpression" && ty(&n["callee"]) == "Identifier" {
            if let Some(c) = n["callee"]["name"].as_str() {
                out.called.insert(c.to_string());
            }
        }
        path.push(n);
        let keys = code_keys(n);
        for child in children(n, &keys) {
            visit(child, inside || f, everywhere, fallback, path, out);
        }
        path.pop();
    }
    let mut out = Scan { names: HashSet::new(), called: HashSet::new(), functions: vec![] };
    visit(program, false, everywhere, fallback, &mut vec![], &mut out);
    out
}

/// Whether the identifier at `key` of `node` is a property or label, whose name is kept and never a variable.
fn named(n: &Value, key: &str) -> bool {
    match key {
        "property" => ty(n) == "JSXMemberExpression" || (ty(n) == "MemberExpression" && n["computed"] != Value::Bool(true)),
        "key" => n["computed"] != Value::Bool(true),
        _ => key == "label" || (key == "name" && ty(n) == "JSXAttribute"),
    }
}

/// The first `n` UTF-16 code units of a string, as `String.prototype.slice` takes them.
fn utf16_prefix(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

fn leaf(text: &str, name: &str, local: bool, at: u64) -> Simple {
    Simple::Leaf(Leaf { id: hash_of(text), name: name.to_string(), local, at })
}

/// The simplified tree of a node: a keyword, a leaf, a labelled subtree, or None when it holds no code.
fn simplify(n: &Value, reference: bool, local: &dyn Fn(&str) -> bool) -> Option<Simple> {
    let t = ty(n);
    if WRAPPERS.contains(&t) {
        return simplify(&n["expression"], reference, local);
    }
    if t == "TSParameterProperty" {
        return simplify(&n["parameter"], reference, local);
    }
    if t.starts_with("TS") || DROPPED.contains(&t) || t.is_empty() {
        return None;
    }
    if t == "ThisExpression" {
        return Some(Simple::Kw("this".into()));
    }
    if t == "Super" {
        return Some(Simple::Kw("super".into()));
    }
    if matches!(t, "Identifier" | "JSXIdentifier" | "PrivateIdentifier") {
        let raw = n["name"].as_str().unwrap_or("");
        let name = if t == "PrivateIdentifier" { format!("#{raw}") } else { raw.to_string() };
        if reference && name == "undefined" {
            return Some(Simple::Kw(name));
        }
        let is_local = reference && local(&name);
        return Some(leaf(if is_local { "#VAR" } else { &name }, &name, is_local, start(n)));
    }
    if t == "Literal" {
        let raw = n["raw"].as_str().unwrap_or("");
        if n["value"].is_boolean() || raw == "null" {
            return Some(Simple::Kw(raw.to_string()));
        }
        let text = match &n["value"] {
            Value::String(s) => serde_json::to_string(&utf16_prefix(s, LITERAL_CHARS)).unwrap_or_default(),
            _ => raw.to_string(),
        };
        return Some(leaf(&text, &text, false, start(n)));
    }
    if t == "TemplateElement" || t == "JSXText" {
        let value = if t == "JSXText" {
            n["value"].as_str().unwrap_or("").to_string()
        } else {
            n["value"]["cooked"].as_str().or_else(|| n["value"]["raw"].as_str()).unwrap_or("").to_string()
        };
        // JavaScript's trim and \s count the byte-order mark as whitespace; Rust's do not.
        let collapsed = value.split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
        let raw = utf16_prefix(&collapsed, LITERAL_CHARS);
        return if raw.is_empty() { None } else { Some(leaf(&format!("`{raw}`"), &raw, false, start(n))) };
    }
    let mut kids: Vec<(u64, Simple)> = Vec::new();
    for key in code_keys(n) {
        // A function's own name is what a renamed copy changes: `function f() {}` reads as `const f = () => {}`.
        if key == "id" && FUNCTIONS.contains(&t) {
            continue;
        }
        for child in children(n, &[key]) {
            if let Some(kid) = simplify(child, !named(n, key), local) {
                kids.push((start(child), kid));
            }
        }
    }
    kids.sort_by_key(|k| k.0);
    let mut list: Vec<Simple> = kids.into_iter().map(|k| k.1).collect();
    // `if (x) y;` reads as `if (x) { y; }`, and `const a = 1;` as its one declarator.
    if (t == "BlockStatement" || t == "VariableDeclaration") && list.len() == 1 && !matches!(list[0], Simple::Kw(_)) {
        return list.pop();
    }
    if t == "BlockStatement" && list.is_empty() {
        return Some(Simple::Kw("{}".into()));
    }
    let kind = n["kind"].as_str().unwrap_or("");
    let kind = if (t == "Property" && kind != "init") || (t == "MethodDefinition" && kind != "method") { kind } else { "" };
    let flags = format!(
        "{}{}{}{}{}{kind}",
        n["operator"].as_str().unwrap_or(""),
        if n["computed"] == Value::Bool(true) { "[]" } else { "" },
        if n["optional"] == Value::Bool(true) && !t.ends_with("Pattern") { "?" } else { "" },
        if n["prefix"] == Value::Bool(false) { "post" } else { "" },
        if n["delegate"] == Value::Bool(true) { "*" } else { "" },
    );
    // The label is the syntax with a # for each leaf or subtree, hashed as it is built.
    let mut label = hash_of(&format!("{}{flags}", if FUNCTIONS.contains(&t) { "Function" } else { t }));
    for kid in &list {
        label = (label
            ^ match kid {
                Simple::Kw(k) => hash_of(k),
                _ => SLOT,
            })
        .wrapping_mul(0x01000193);
    }
    Some(Simple::Tree(Tree { label, kids: list, member: t == "MemberExpression" && n["computed"] != Value::Bool(true) }))
}

/// Aroma's four feature kinds for every leaf of a tree, in source order.
fn featurize(tree: &Tree, lines: &Lines) -> Vec<Featured> {
    struct Place<'p> {
        label: i32,
        slot: i32,
        up: Option<&'p Place<'p>>,
    }
    struct Found {
        leaf: Leaf,
        feats: Vec<i32>,
        context: i32,
    }
    fn walk(node: &Tree, up: Option<&Place>, found: &mut Vec<Found>) {
        let mut slot = 0;
        for (index, kid) in node.kids.iter().enumerate() {
            if matches!(kid, Simple::Kw(_)) {
                continue;
            }
            slot += 1;
            let place = Place { label: node.label, slot, up };
            match kid {
                Simple::Tree(t) => walk(t, Some(&place), found),
                Simple::Leaf(l) => {
                    let mut feats = vec![mix(1, l.id, 0, 0)];
                    let mut p = Some(&place);
                    let mut depth = 0;
                    while let (Some(pl), true) = (p, depth < 3) {
                        feats.push(mix(2, l.id, pl.slot, pl.label));
                        p = pl.up;
                        depth += 1;
                    }
                    // A local's context is its place in its parent, or for `x.foo` the property it is reached into.
                    let property = if node.member && slot == 1 {
                        node.kids.iter().enumerate().find(|(i, k)| *i > 0 && !matches!(k, Simple::Kw(_))).map(|(_, k)| k)
                    } else {
                        None
                    };
                    let context = match property {
                        Some(Simple::Leaf(prop)) => prop.id,
                        _ => mix(3, slot, node.label, 0),
                    };
                    let _ = index;
                    found.push(Found { leaf: l.clone(), feats, context });
                }
                Simple::Kw(_) => {}
            }
        }
    }
    let mut found = Vec::new();
    walk(tree, None, &mut found);
    let mut last_use: HashMap<String, usize> = HashMap::new();
    for i in 0..found.len() {
        if i + 1 < found.len() {
            let f = mix(4, found[i].leaf.id, found[i + 1].leaf.id, 0);
            found[i].feats.push(f);
        }
        if !found[i].leaf.local {
            continue;
        }
        if let Some(&before) = last_use.get(&found[i].leaf.name) {
            let f = mix(5, found[before].context, found[i].context, 0);
            found[i].feats.push(f);
        }
        last_use.insert(found[i].leaf.name.clone(), i);
    }
    found.into_iter().map(|f| Featured { at: f.leaf.at, line: lines.line(f.leaf.at as usize), feats: f.feats }).collect()
}

/// The features of some leaves, sorted with and without repeats.
fn bags(leaves: &[Featured]) -> (Vec<i32>, Vec<i32>) {
    let mut bag: Vec<i32> = leaves.iter().flat_map(|l| l.feats.iter().copied()).collect();
    bag.sort_unstable();
    let mut set = bag.clone();
    set.dedup();
    (bag, set)
}

struct Analysis {
    leaves: Vec<Featured>,
    named: Vec<(String, u32, u32, usize, usize)>,
}

/// A file's leaves with their features, and its named functions as ranges of those leaves.
fn analyze(path: &str, text: &str, as_snippet: bool) -> Option<Analysis> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let parsed =
        Parser::new(&allocator, text, source_type).with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() }).parse();
    if parsed.panicked || (!parsed.errors.is_empty() && parsed.program.body.is_empty()) {
        return None;
    }
    let program: Value = serde_json::from_str(&parsed.program.to_estree_ts_json(false)).ok()?;
    let lines = Lines::new(text);
    let fallback = path.rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("").to_string();
    let found = scan(&program, as_snippet, &fallback);
    let imported: HashSet<String> = program["body"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| ty(s) == "ImportDeclaration")
        .flat_map(|s| s["specifiers"].as_array().into_iter().flatten().filter_map(|x| x["local"]["name"].as_str().map(str::to_string)))
        .collect();
    let loose = |name: &str| {
        !imported.contains(name)
            && !found.called.contains(name)
            && name.starts_with(|c: char| c.is_ascii_lowercase() || c == '_' || c == '$')
            && !BROWSER.contains(&name)
            && !JS_GLOBALS.contains(&name)
    };
    let local: Box<dyn Fn(&str) -> bool> =
        if as_snippet { Box::new(|n: &str| found.names.contains(n) || loose(n)) } else { Box::new(|n: &str| found.names.contains(n)) };
    let leaves = match simplify(&program, true, &*local) {
        Some(Simple::Tree(t)) => featurize(&t, &lines),
        _ => vec![],
    };
    let first = |offset: u64| leaves.partition_point(|l| l.at < offset);
    let named = found
        .functions
        .iter()
        .map(|(name, s, e)| (name.clone(), lines.line(*s as usize), lines.line(e.saturating_sub(1) as usize), first(*s), first(*e)))
        .collect();
    Some(Analysis { leaves, named })
}

/// Every named function in a file, nested ones included, with its features.
pub fn units(path: &str, text: &str) -> Vec<Unit> {
    let Some(found) = analyze(path, text, false) else { return vec![] };
    found
        .named
        .into_iter()
        .filter_map(|(name, line, end_line, from, to)| {
            let leaves = found.leaves[from..to.max(from)].to_vec();
            (!leaves.is_empty()).then(|| {
                let (bag, set) = bags(&leaves);
                Unit { name, line, end_line, leaves, bag, set }
            })
        })
        .collect()
}

/// The code on lines `from` to `to` of a file, as a query.
pub fn lines(path: &str, text: &str, from: u32, to: u32) -> Option<Unit> {
    let found = analyze(path, text, false)?;
    let leaves: Vec<Featured> = found.leaves.into_iter().filter(|l| l.line >= from && l.line <= to).collect();
    let (bag, set) = bags(&leaves);
    Some(Unit { name: format!("lines {from}-{to}"), line: from, end_line: to, leaves, bag, set })
}

/// A query from loose code that may be only statements, a method or an expression, as cut from a function body.
pub fn snippet(text: &str, ext: &str) -> Option<Unit> {
    for (before, after) in [("", ""), ("function snippet() {\n", "\n}"), ("class Snippet {\n", "\n}"), ("(\n", "\n)")] {
        let Some(found) = analyze(&format!("snippet{ext}"), &format!("{before}{text}{after}"), true) else { continue };
        if found.leaves.is_empty() {
            continue;
        }
        let shift = u32::from(!before.is_empty());
        let leaves: Vec<Featured> = found.leaves.into_iter().map(|l| Featured { line: l.line - shift, ..l }).collect();
        let (bag, set) = bags(&leaves);
        return Some(Unit { name: "snippet".into(), line: 1, end_line: text.split('\n').count() as u32, leaves, bag, set });
    }
    None
}

/// How many values two sorted sets share.
pub fn overlap(a: &[i32], b: &[i32]) -> usize {
    let (mut i, mut j, mut n) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Equal => {
                n += 1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    n
}

/// Each feature's count in a bag.
pub fn counts(bag: &[i32]) -> HashMap<i32, usize> {
    let mut out = HashMap::new();
    for f in bag {
        *out.entry(*f).or_default() += 1;
    }
    out
}

/// Aroma's pruning: greedily keeps the leaves of a candidate that add the most features the query also has. `score`
/// is how many of the query's features the kept part matches; `kept` are the indices of the kept leaves.
pub fn prune(want: &HashMap<i32, usize>, leaves: &[Featured]) -> (usize, Vec<usize>) {
    let mut have: HashMap<i32, usize> = HashMap::new();
    let gain = |l: &Featured, have: &HashMap<i32, usize>| {
        let mut g = 0;
        for (i, f) in l.feats.iter().enumerate() {
            let earlier = l.feats[..i].iter().filter(|x| *x == f).count();
            if have.get(f).copied().unwrap_or(0) + earlier < want.get(f).copied().unwrap_or(0) {
                g += 1;
            }
        }
        g
    };
    // Lazy greedy over buckets of each leaf's last known gain: what a leaf could match only shrinks as others are kept.
    let mut buckets: Vec<Vec<usize>> = Vec::new();
    for i in (0..leaves.len()).rev() {
        let g = gain(&leaves[i], &have);
        if g > 0 {
            if buckets.len() <= g {
                buckets.resize(g + 1, Vec::new());
            }
            buckets[g].push(i);
        }
    }
    let mut kept = Vec::new();
    let mut score = 0;
    let mut level = buckets.len().saturating_sub(1);
    while level > 0 {
        let Some(i) = buckets[level].pop() else {
            level -= 1;
            continue;
        };
        let g = gain(&leaves[i], &have);
        if g == level {
            kept.push(i);
            score += g;
            for f in &leaves[i].feats {
                *have.entry(*f).or_default() += 1;
            }
        } else if g > 0 {
            buckets[g].push(i);
        }
    }
    (score, kept)
}

/// The lines a match is at: the shortest run of lines holding nine in ten of the kept leaves.
pub fn span(at: &[u32]) -> (u32, u32) {
    let mut sorted = at.to_vec();
    sorted.sort_unstable();
    if sorted.is_empty() {
        return (0, 0);
    }
    let need = ((sorted.len() as f64 * 0.9).ceil() as usize).max(1);
    let mut best = (sorted[0], sorted[sorted.len() - 1]);
    for i in 0..=sorted.len() - need {
        if sorted[i + need - 1] - sorted[i] < best.1 - best.0 {
            best = (sorted[i], sorted[i + need - 1]);
        }
    }
    best
}

/// Whether a match at `from`-`to` is scattered, for code `length` lines long: shared idioms, not a copy.
pub fn scattered(from: u32, to: u32, length: u32) -> bool {
    to.saturating_sub(from) > length * 2 + 10
}

/// A source file's text, or None when missing, too large, binary or generated.
pub fn read_source(root: &str, file: &str) -> Option<String> {
    crate::text::read_up_to(root, file, MAX_BYTES)
}

fn file_key(file: &str, text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    file.hash(&mut h);
    0u8.hash(&mut h);
    text.hash(&mut h);
    h.finish()
}

type Cached = Vec<(String, u32, u32, usize, Vec<i32>)>;

fn read_cache(path: &std::path::Path) -> HashMap<u64, Cached> {
    let mut out = HashMap::new();
    let Ok(mut f) = std::fs::File::open(path) else { return out };
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return out;
    }
    let mut at = 0usize;
    let mut take = |n: usize| -> Option<&[u8]> {
        let s = bytes.get(at..at + n)?;
        at += n;
        Some(s)
    };
    let u32_ = |b: &[u8]| u32::from_le_bytes(b.try_into().unwrap_or([0; 4]));
    let mut parse = || -> Option<HashMap<u64, Cached>> {
        let mut out = HashMap::new();
        let vlen = u32_(take(4)?) as usize;
        if take(vlen)? != VERSION.as_bytes() {
            return None;
        }
        let entries = u32_(take(4)?);
        for _ in 0..entries {
            let key = u64::from_le_bytes(take(8)?.try_into().ok()?);
            let n = u32_(take(4)?);
            let mut units = Vec::new();
            for _ in 0..n {
                let nl = u32_(take(4)?) as usize;
                let name = String::from_utf8(take(nl)?.to_vec()).ok()?;
                let line = u32_(take(4)?);
                let end = u32_(take(4)?);
                let size = u32_(take(4)?) as usize;
                let sl = u32_(take(4)?) as usize;
                let set = take(sl * 4)?.chunks(4).map(|c| i32::from_le_bytes(c.try_into().unwrap_or([0; 4]))).collect();
                units.push((name, line, end, size, set));
            }
            out.insert(key, units);
        }
        Some(out)
    };
    if let Some(parsed) = parse() {
        out = parsed;
    }
    out
}

fn write_cache(path: &std::path::Path, entries: &HashMap<u64, Cached>) {
    let mut b: Vec<u8> = Vec::new();
    b.extend((VERSION.len() as u32).to_le_bytes());
    b.extend(VERSION.as_bytes());
    b.extend((entries.len() as u32).to_le_bytes());
    for (key, units) in entries {
        b.extend(key.to_le_bytes());
        b.extend((units.len() as u32).to_le_bytes());
        for (name, line, end, size, set) in units {
            b.extend((name.len() as u32).to_le_bytes());
            b.extend(name.as_bytes());
            b.extend(line.to_le_bytes());
            b.extend(end.to_le_bytes());
            b.extend((*size as u32).to_le_bytes());
            b.extend((set.len() as u32).to_le_bytes());
            for f in set {
                b.extend(f.to_le_bytes());
            }
        }
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Written aside and renamed, so a run that stops halfway never leaves a torn cache.
    let temp = path.with_extension(format!("bin.{}", std::process::id()));
    if std::fs::File::create(&temp).and_then(|mut f| f.write_all(&b)).is_ok() {
        let _ = std::fs::rename(&temp, path);
    }
}

/// The named functions of `files` with their feature sets, cached by file content in `cache_dir`, so only files
/// changed since the last run are parsed.
pub fn index_units(root: &str, files: &[String], cache_dir: &std::path::Path) -> Vec<Indexed> {
    // ponytail: one cache file rewritten whole when anything changed; shard by folder if it grows past tens of MB
    let path = cache_dir.join("features-rust.bin");
    let saved = read_cache(&path);
    let per_file: Vec<Option<(u64, Cached, bool, String)>> = files
        .par_iter()
        .map(|file| {
            let text = read_source(root, file)?;
            let key = file_key(file, &text);
            if let Some(found) = saved.get(&key) {
                return Some((key, found.clone(), false, file.clone()));
            }
            let found: Cached = units(file, &text).into_iter().map(|u| (u.name, u.line, u.end_line, u.leaves.len(), u.set)).collect();
            Some((key, found, true, file.clone()))
        })
        .collect();
    let mut entries: HashMap<u64, Cached> = HashMap::new();
    let mut all = Vec::new();
    let mut parsed = false;
    for (key, found, fresh, file) in per_file.into_iter().flatten() {
        parsed |= fresh;
        for (name, line, end_line, size, set) in &found {
            all.push(Indexed { file: file.clone(), name: name.clone(), line: *line, end_line: *end_line, size: *size, set: set.clone() });
        }
        entries.insert(key, found);
    }
    if parsed || entries.len() != saved.len() {
        write_cache(&path, &entries);
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_javascript_and_finds_named_functions() {
        // Math.imul FNV-1a of "a" in JavaScript is -468965076.
        assert_eq!(hash_of("a"), -468965076);
        let u = units("a.ts", "export function groupBy(items, keyOf) {\n  const groups = new Map();\n  for (const item of items) groups.set(keyOf(item), item);\n  return groups;\n}\nconst Card = memo(() => 1);\n");
        assert_eq!(u.iter().map(|u| (u.name.as_str(), u.line, u.end_line)).collect::<Vec<_>>(), vec![("groupBy", 1, 5), ("Card", 6, 6)]);
        let q = snippet("const buckets = new Map();\nfor (const entry of entries) buckets.set(pick(entry), entry);", ".ts").unwrap();
        let (score, kept) = prune(&counts(&q.bag), &u[0].leaves);
        assert!(score as f64 / q.bag.len() as f64 > 0.5 && !kept.is_empty());
        assert_eq!(span(&[3, 4, 5, 6, 7, 8, 9, 10, 11, 30]), (3, 11));
    }
}
