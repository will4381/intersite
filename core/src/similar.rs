//! The similar check: an added function, component, hook, class or type that already exists under another name (the
//! same structure once local names and literals are placeholders), and added code holding most of an existing
//! function's body (a helper pasted inside a new function instead of called), found with Aroma's features.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::aroma::{self, Indexed};
use crate::units::{self, Unit};
use crate::{Answer, Finding, Request};

/// Kit primitives (shadcn-style) are deliberately uniform wrappers: two of them are never reported as a pair.
static KIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:components/ui|ui/components|packages/ui)/").unwrap());
static JS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?[jt]sx?$").unwrap());
/// Entry points whose shape a framework or script convention dictates.
static ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:main|run|handler|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|loader|action|generateMetadata|generateStaticParams|getServerSideProps|getStaticProps|getStaticPaths)$").unwrap()
});
static SELECTORS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:query|from|table|collection|doc|withIndex|index|rpc|invoke|channel|emit|on|select|insert|update|upsert|delete|eq|neq|where|orderBy|field|getItem|setItem)$").unwrap()
});
/// URLs, routes, module specifiers and SQL: a string that says which thing a unit talks to. Env names too.
static ADDRESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)^["'`]?(?:\.{0,2}/|[@~#]/|https?:|\s*(?:select|insert into|update|delete from|with)\s)"#).unwrap());
static ENV_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^["'`][A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+["'`]$"#).unwrap());
const K: usize = 7;
// Jaccard over 7-gram sets. Tuned on 21 agent-built repositories: real regenerated helpers scored 60-100%, and below
// 60% or 32 normalised tokens the matches were mostly shared idioms a reviewer would keep.
const THRESHOLD: f64 = 0.6;
const MIN_TOKENS: usize = 32;
const MIN_MEMBERS: usize = 6;
const TYPE_THRESHOLD: f64 = 0.9;
const LCS_CELLS: usize = 4_000_000;
/// A unit this short that calls a different module-level helper is a delegate to it, not a copy.
const DELEGATE_TOKENS: usize = 50;
// A partial copy holds at least this share of an existing function's features, and the original has at least this
// many names and literals. Tuned on nine agent-built repositories judged whole.
const CONTAINED: f64 = 0.8;
const MIN_LEAVES: usize = 30;
/// The function holding the copy is this much bigger than the original; closer in size, they are similar functions.
const BIGGER: f64 = 1.5;
/// From this share the whole original is there, so the copy can call it; below it, the two share a part.
const WHOLE_COPY: f64 = 0.95;
/// A feature in more than this many changed functions is too common to say much.
const MAX_POSTING: usize = 64;
const PER_FUNCTION: usize = 5;

struct Entry {
    file: String,
    unit: Unit,
    prints: Option<Vec<i32>>,
}

fn family(u: &Unit) -> &str {
    match u.kind.as_str() {
        "type" => "type",
        "class" => "class",
        _ => "code",
    }
}

/// Whether a copy of the unit would matter: big enough, not an entry point, not an error subclass.
fn big(u: &Unit) -> bool {
    if u.kind == "type" {
        return u.members.len() >= MIN_MEMBERS;
    }
    if ENTRY.is_match(&u.name)
        || (u.kind == "class"
            && u.raw.iter().enumerate().any(|(i, t)| t == "extends" && u.raw.get(i + 1).is_some_and(|n| n.ends_with("Error"))))
    {
        return false;
    }
    u.norm.len() >= MIN_TOKENS
}

/// The unit's k-gram hashes over its normalised tokens, sorted and unique.
fn fingerprint(norm: &[String], ids: &mut HashMap<String, i32>) -> Vec<i32> {
    let toks: Vec<i32> = norm
        .iter()
        .map(|t| {
            let n = ids.len() as i32;
            *ids.entry(t.clone()).or_insert(n)
        })
        .collect();
    let mut out: Vec<i32> = (0..toks.len().saturating_sub(K - 1))
        .map(|i| {
            let mut h: i32 = 0x811c9dc5u32 as i32;
            for &id in &toks[i..i + K] {
                h = (h ^ id).wrapping_mul(0x01000193);
            }
            h
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn member_similarity(a: &[String], b: &[String]) -> f64 {
    let sa: HashSet<&String> = a.iter().collect();
    let sb: HashSet<&String> = b.iter().collect();
    let shared = sb.iter().filter(|m| sa.contains(*m)).count();
    shared as f64 / (sa.len() + sb.len() - shared) as f64
}

/// Whether `other` may be reported as the original of added `e`.
fn candidate(e: &Entry, other: &Entry) -> bool {
    other.file != e.file
        && family(&other.unit) == family(&e.unit)
        && big(&other.unit)
        && !(KIT.is_match(&e.file) && KIT.is_match(&other.file))
}

/// One more shared feature for each of `units`; `hit` lists each unit the first time it shares one.
fn tally(units: &[usize], shared: &mut [usize], hit: &mut Vec<usize>) {
    for &i in units {
        if shared[i] == 0 {
            hit.push(i);
        }
        shared[i] += 1;
    }
}

/// The most similar other unit for each added unit, as (added, other, similarity).
fn best_matches(fresh: &mut [Entry], all: &mut [Entry], ids: &mut HashMap<String, i32>) -> Vec<(usize, usize, f64)> {
    let mut index: HashMap<i32, Vec<usize>> = HashMap::new();
    let (mut lo, mut hi) = (f64::INFINITY, 0f64);
    for (i, e) in fresh.iter_mut().enumerate() {
        if family(&e.unit) == "type" {
            continue;
        }
        let prints = fingerprint(&e.unit.norm, ids);
        lo = lo.min(e.unit.norm.len() as f64 * THRESHOLD);
        hi = hi.max(e.unit.norm.len() as f64 / THRESHOLD);
        for h in &prints {
            index.entry(*h).or_default().push(i);
        }
        e.prints = Some(prints);
    }
    let mut best: Vec<Option<usize>> = vec![None; fresh.len()];
    let mut score = vec![0f64; fresh.len()];
    let mut shared = vec![0usize; fresh.len()];
    for (oi, other) in all.iter_mut().enumerate() {
        let len = other.unit.norm.len() as f64;
        if family(&other.unit) == "type" || len < lo || len > hi {
            continue;
        }
        if other.prints.is_none() {
            other.prints = Some(fingerprint(&other.unit.norm, ids));
        }
        let prints = other.prints.as_ref().unwrap();
        let mut hit = Vec::new();
        for h in prints {
            tally(index.get(h).map_or(&[][..], |v| v.as_slice()), &mut shared, &mut hit);
        }
        for i in hit {
            let sim = shared[i] as f64 / (fresh[i].prints.as_ref().unwrap().len() + prints.len() - shared[i]) as f64;
            shared[i] = 0;
            if sim > score[i] && candidate(&fresh[i], other) {
                score[i] = sim;
                best[i] = Some(oi);
            }
        }
    }
    // ponytail: each added type is compared with every type, O(added × types); index members if big changes slow it
    for (i, e) in fresh.iter().enumerate() {
        if family(&e.unit) != "type" {
            continue;
        }
        for (oi, other) in all.iter().enumerate() {
            if family(&other.unit) != "type" || !candidate(e, other) {
                continue;
            }
            let sim = member_similarity(&e.unit.members, &other.unit.members);
            if sim > score[i] {
                score[i] = sim;
                best[i] = Some(oi);
            }
        }
    }
    best.into_iter().enumerate().filter_map(|(i, b)| b.map(|o| (i, o, score[i]))).collect()
}

/// Whether two line ranges share a run of `n` identical non-trivial lines: the duplicates gate reports those.
fn pasted(root: &str, a: (&str, u32, u32), b: (&str, u32, u32), n: usize, cache: &mut HashMap<String, Vec<String>>) -> bool {
    static TRIVIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\[\](){};,]*$|^</[\w.]*>$").unwrap());
    let mut lines = |(file, from, to): (&str, u32, u32)| -> Vec<String> {
        let all = cache
            .entry(file.to_string())
            .or_insert_with(|| aroma::read_source(root, file).unwrap_or_default().split('\n').map(str::to_string).collect());
        all.iter()
            .skip(from.saturating_sub(1) as usize)
            .take((to + 1).saturating_sub(from) as usize)
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|l| !l.is_empty())
            .collect()
    };
    let la = lines(a);
    let lb = lines(b);
    if la.len() < n || lb.len() < n {
        return false;
    }
    let runs: HashSet<String> = (0..=lb.len() - n).map(|i| lb[i..i + n].join("\n")).collect();
    (0..=la.len() - n)
        .any(|i| runs.contains(&la[i..i + n].join("\n")) && la[i..i + n].iter().filter(|l| !TRIVIAL.is_match(l)).count() * 2 >= n)
}

/// Matched token pairs of the longest common subsequence of two normalised streams, or None when too large.
fn align(a: &[String], b: &[String]) -> Option<Vec<(usize, usize)>> {
    // ponytail: quadratic LCS, skipped past LCS_CELLS (about 2,000 tokens a side); Myers diff if huge units need wording
    if (a.len() + 1) * (b.len() + 1) > LCS_CELLS {
        return None;
    }
    let w = b.len() + 1;
    let mut dp = vec![0u16; (a.len() + 1) * w];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            dp[i * w + j] = if a[i] == b[j] { dp[(i + 1) * w + j + 1] + 1 } else { dp[(i + 1) * w + j].max(dp[i * w + j + 1]) };
        }
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    Some(pairs)
}

fn raw(u: &Unit, k: i64) -> &str {
    if k < 0 {
        ""
    } else {
        u.raw.get(k as usize).map_or("", String::as_str)
    }
}

fn literal(kind: &str) -> bool {
    matches!(kind, "str" | "text" | "num" | "regex")
}

/// Whether string `k` of `u` is a list of CSS classes.
fn class_list(u: &Unit, k: usize) -> bool {
    static CLASSY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:cn|clsx|cva|twMerge|classNames)$").unwrap());
    static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[!a-z0-9:/\[\].%#-]+$").unwrap());
    let before = raw(u, k as i64 - 2);
    if before == "className" || before == "class" || CLASSY.is_match(before) {
        return true;
    }
    let text = raw(u, k as i64).trim_start_matches(['"', '\'', '`']).trim_end_matches(['"', '\'', '`']).trim();
    let words: Vec<&str> = text.split_whitespace().collect();
    words.len() > 1 && words.iter().all(|w| WORD.is_match(w)) && words.iter().filter(|w| w.contains(['-', ':'])).count() * 2 >= words.len()
}

/// What separates two near-identical units: "" when only local names do, a list such as "class names and one string"
/// when only literals and a prop or two do, else None.
fn differences(a: &Unit, b: &Unit) -> Option<String> {
    let pairs = align(&a.norm, &b.norm)?;
    let unmatched = a.norm.len() + b.norm.len() - 2 * pairs.len();
    let ma: HashSet<usize> = pairs.iter().map(|p| p.0).collect();
    let mb: HashSet<usize> = pairs.iter().map(|p| p.1).collect();
    let mut props: HashSet<&str> = HashSet::new();
    for (i, k) in a.raw_kind.iter().enumerate() {
        if k == "attr" && !ma.contains(&i) {
            props.insert(&a.raw[i]);
        }
    }
    for (j, k) in b.raw_kind.iter().enumerate() {
        if k == "attr" && !mb.contains(&j) {
            props.insert(&b.raw[j]);
        }
    }
    // A prop is about three tokens (`name="value"`); anything more is a structural change.
    if unmatched > props.len() * 3 {
        return None;
    }
    let (mut classes, mut strings, mut numbers) = (0, 0, 0);
    for &(i, j) in &pairs {
        if a.raw[i] == b.raw[j] || !literal(&a.raw_kind[i]) {
            continue;
        }
        if a.raw_kind[i] == "num" {
            numbers += 1;
        } else if class_list(a, i) {
            classes += 1;
        } else {
            strings += 1;
        }
    }
    let count = |n: usize, what: &str| if n == 1 { format!("one {what}") } else { format!("{n} {what}s") };
    let mut parts: Vec<String> = Vec::new();
    if classes > 0 {
        parts.push("class names".into());
    }
    if strings > 0 {
        parts.push(count(strings, "string"));
    }
    if numbers > 0 {
        parts.push(count(numbers, "number"));
    }
    if !props.is_empty() {
        parts.push(count(props.len(), "prop"));
    }
    let joined = parts.join(", ");
    Some(match joined.rfind(", ") {
        Some(i) => format!("{} and {}", &joined[..i], &joined[i + 2..]),
        None => joined,
    })
}

/// Whether token `k` of `u` names a dependency: something it talks to.
fn resource(u: &Unit, k: usize) -> bool {
    let next = raw(u, k as i64 + 1);
    let reached = next == "." || next == "?.";
    let kind = u.raw_kind.get(k).map_or("", String::as_str);
    if matches!(raw(u, k as i64 - 1), "function" | "const" | "let" | "var" | "class") {
        return false;
    }
    match kind {
        "dep" => next == "(" || reached,
        "mod" => reached || (next == "(" && u.norm.len() < DELEGATE_TOKENS),
        "tag" => raw(u, k as i64).starts_with('<') && raw(u, k as i64)[1..].starts_with(|c: char| c.is_ascii_uppercase()),
        _ => kind == "id" && raw(u, k as i64 - 1) == "." && reached,
    }
}

fn resource_in(u: &Unit, from: usize, to: usize) -> bool {
    (from..to).any(|k| resource(u, k))
}

/// Whether literal `k` of `u` is a prop passed to a custom component (`<Chart title="…">`).
fn custom_prop(u: &Unit, k: usize) -> bool {
    let mut m = k as i64 - 1;
    while m >= 0 && m > k as i64 - 80 {
        if u.raw_kind[m as usize] == "tag" {
            let t = &u.raw[m as usize];
            return t.starts_with('<') && t[1..].starts_with(|c: char| c.is_ascii_uppercase());
        }
        m -= 1;
    }
    false
}

/// Whether string `k` of `u` selects what a data call touches (`db.query("fees")`).
fn selector(u: &Unit, k: usize) -> bool {
    raw(u, k as i64 - 1) == "(" && raw(u, k as i64 - 3) == "." && SELECTORS.is_match(raw(u, k as i64 - 2))
}

/// Whether two similar units are one pattern applied to different things, which a reviewer keeps apart.
fn apart(a: &Unit, b: &Unit) -> bool {
    let mut pairs = align(&a.norm, &b.norm).unwrap_or_default();
    pairs.push((a.norm.len(), b.norm.len()));
    let (mut i0, mut j0) = (0, 0);
    let (mut literals, mut changed, mut props) = (0, 0, 0);
    for (i, j) in pairs {
        if resource_in(a, i0, i) && resource_in(b, j0, j) {
            return true;
        }
        i0 = i + 1;
        j0 = j + 1;
        if i == a.norm.len() {
            break;
        }
        let differs = a.raw[i] != b.raw[j];
        if differs && resource(a, i) && resource(b, j) {
            return true;
        }
        if !literal(&a.raw_kind[i]) {
            continue;
        }
        literals += 1;
        if !differs {
            continue;
        }
        if a.raw_kind[i] == "str" && (selector(a, i) || [&a.raw[i], &b.raw[j]].iter().any(|t| ADDRESS.is_match(t) || ENV_NAME.is_match(t)))
        {
            return true;
        }
        changed += 1;
        if custom_prop(a, i) {
            props += 1;
        }
    }
    if a.kind == "component" {
        return changed > 0 && props == changed;
    }
    let branches = a
        .norm
        .iter()
        .enumerate()
        .filter(|(k, t)| *t == "case" || (*t == "return" && a.norm.get(k + 1).is_some_and(|n| matches!(n.as_str(), "S" | "N" | "T" | "R"))))
        .count();
    branches >= 3 && changed >= 3 && changed * 2 >= literals
}

fn message(e: &Entry, other: &Entry, sim: f64) -> String {
    let where_ = format!(
        "{}:{} {} is {}% the same as {}:{} {}",
        e.file,
        e.unit.line,
        e.unit.name,
        (sim * 100.0).floor() as i64,
        other.file,
        other.unit.line,
        other.unit.name
    );
    if e.unit.kind == "type" {
        return format!("{where_}: use one type");
    }
    match differences(&e.unit, &other.unit) {
        Some(d) if d.is_empty() => format!("{where_}: reuse it"),
        None => format!("{where_}: reuse it, or extract what they share"),
        Some(d) => {
            let one = match e.unit.kind.as_str() {
                "component" => "one component with a variant prop",
                "class" => "one class with a parameter",
                _ => "one function with a parameter",
            };
            format!("{where_} and differs only in {d}: make them {one}")
        }
    }
}

/// Aroma's first phase for partial copies: for each changed function, the existing functions most of whose features
/// it shares, found through an index of the changed functions' features.
fn copy_candidates<'a>(
    all: &'a [Indexed],
    added: &HashMap<String, HashSet<u32>>,
    whole: bool,
) -> Vec<Vec<(&'a Indexed, &'a Indexed, f64)>> {
    let added_in = |u: &Indexed| added.get(u.file.as_str()).map_or(0, |lines| (u.line..=u.end_line).filter(|l| lines.contains(l)).count());
    let containers: Vec<&Indexed> = all.iter().filter(|u| u.size >= MIN_LEAVES && added_in(u) > 0).collect();
    let mut postings: HashMap<i32, Vec<usize>> = HashMap::new();
    for (i, u) in containers.iter().enumerate() {
        for f in &u.set {
            postings.entry(*f).or_default().push(i);
        }
    }
    let mut shared = vec![0usize; containers.len()];
    let mut candidates: Vec<Vec<(&Indexed, &Indexed, f64)>> = vec![Vec::new(); containers.len()];
    for e in all {
        // The original existed before the change: a function mostly made of added lines is new, or moved.
        if e.size < MIN_LEAVES || (!whole && added_in(e) * 2 > (e.end_line - e.line + 1) as usize) {
            continue;
        }
        let mut common = 0;
        let mut hit = Vec::new();
        for f in &e.set {
            let list = postings.get(f).map_or(&[][..], |v| v.as_slice());
            if list.len() > MAX_POSTING {
                common += 1;
                continue;
            }
            tally(list, &mut shared, &mut hit);
        }
        for i in hit {
            let a = containers[i];
            let share = shared[i] as f64 / (e.set.len().saturating_sub(common)).max(1) as f64;
            shared[i] = 0;
            let nested = a.file == e.file && a.line <= e.end_line && e.line <= a.end_line;
            if share >= CONTAINED && !nested && e.size as f64 * BIGGER <= a.size as f64 && !(KIT.is_match(&a.file) && KIT.is_match(&e.file))
            {
                candidates[i].push((a, e, share));
            }
        }
    }
    candidates
}

struct Hit<'a> {
    a: &'a Indexed,
    e: &'a Indexed,
    share: f64,
    from: u32,
    to: u32,
}

/// Added code holding most of an existing function's body: a helper pasted inside a function instead of called.
fn partial_copies(
    request: &Request,
    files: &[String],
    added: &HashMap<String, HashSet<u32>>,
    whole: bool,
    n: usize,
    reported: &HashSet<String>,
    cache: &mut HashMap<String, Vec<String>>,
) -> Vec<Finding> {
    let cache_dir = std::path::Path::new(&request.root).join("node_modules/.cache/intersite");
    let js: Vec<String> = files.iter().filter(|f| JS.is_match(f)).cloned().collect();
    let all = aroma::index_units(&request.root, &js, &cache_dir);
    let mut candidates = copy_candidates(&all, added, whole);
    let mut parsed: HashMap<String, Vec<aroma::Unit>> = HashMap::new();
    let mut hits: Vec<Hit> = Vec::new();
    for list in &mut candidates {
        list.sort_by(|x, y| y.2.total_cmp(&x.2));
        for &(a, e, _) in list.iter().take(PER_FUNCTION) {
            if reported.contains(&format!("{}:{} {}:{}", a.file, a.name, e.file, e.name)) {
                continue;
            }
            for f in [&a.file, &e.file] {
                if !parsed.contains_key(f) {
                    let text = aroma::read_source(&request.root, f).unwrap_or_default();
                    parsed.insert(f.clone(), aroma::units(f, &text));
                }
            }
            let find = |x: &Indexed| parsed.get(&x.file).and_then(|us| us.iter().find(|u| u.line == x.line && u.name == x.name)).cloned();
            let (Some(container), Some(original)) = (find(a), find(e)) else { continue };
            let (score, kept) = aroma::prune(&aroma::counts(&original.bag), &container.leaves);
            let share = score as f64 / original.bag.len() as f64;
            let lines: Vec<u32> = kept.iter().map(|&i| container.leaves[i].line).collect();
            let fresh = added.get(a.file.as_str());
            // Most of what matches must be added lines: an old function that already held the code is not this change's.
            if share < CONTAINED || (!whole && lines.iter().filter(|l| fresh.is_some_and(|f| f.contains(l))).count() * 2 < lines.len()) {
                continue;
            }
            let (from, to) = aroma::span(&lines);
            if aroma::scattered(from, to, e.end_line - e.line + 1) {
                continue;
            }
            if pasted(&request.root, (&a.file, from, to), (&e.file, e.line, e.end_line), n, cache) {
                continue;
            }
            hits.push(Hit { a, e, share, from, to });
            break;
        }
    }
    let overlaps = |f1: &str, a1: u32, b1: u32, f2: &str, a2: u32, b2: u32| f1 == f2 && a1 <= b2 && a2 <= b1;
    let mut out = Vec::new();
    for (hi, h) in hits.iter().enumerate() {
        // A copy inside a nested function is reported there, not again for every function around it.
        if hits.iter().enumerate().any(|(oi, o)| {
            oi != hi && std::ptr::eq(o.e, h.e) && o.a.file == h.a.file && h.a.line <= o.a.line && o.a.end_line <= h.a.end_line
        }) {
            continue;
        }
        // Judging the whole repository, two copies of each other are one finding, at the later file.
        let mutual = hits.iter().enumerate().find(|(oi, o)| {
            *oi != hi
                && overlaps(&o.a.file, o.from, o.to, &h.e.file, h.e.line, h.e.end_line)
                && overlaps(&h.a.file, h.from, h.to, &o.e.file, o.e.line, o.e.end_line)
        });
        if let Some((_, m)) = mutual {
            if format!("{}:{}", h.a.file, h.from) <= format!("{}:{}", m.a.file, m.from) {
                continue;
            }
        }
        let advice = if h.share >= WHOLE_COPY { "call it instead" } else { "call it, or extract what they share" };
        out.push(Finding {
            file: h.a.file.clone(),
            line: h.from,
            target: format!("{}:{}", h.a.file, h.a.name),
            message: format!(
                "{}:{}-{} in {} repeats {}:{} {} ({}% of it): {advice}",
                h.a.file,
                h.from,
                h.to,
                h.a.name,
                h.e.file,
                h.e.line,
                h.e.name,
                (h.share * 100.0).floor() as i64
            ),
        });
    }
    out
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// The duplicates gate's block size: a pair sharing that many pasted lines is its finding, not this one's.
    lines: usize,
    /// Judging the whole repository.
    whole: bool,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { lines: n, whole } = request.options()?;
    let added = request.added.clone().unwrap_or_default();
    let files = &request.files;
    // Every unit in the repository's source files, and which ones the change added (its first line is an added line).
    let per_file: Vec<Vec<Entry>> = {
        use rayon::prelude::*;
        files
            .par_iter()
            .map(|file| {
                if !JS.is_match(file) {
                    return vec![];
                }
                let Some(text) = aroma::read_source(&request.root, file) else { return vec![] };
                units::units(&text, file).into_iter().map(|unit| Entry { file: file.clone(), unit, prints: None }).collect()
            })
            .collect()
    };
    let mut all: Vec<Entry> = per_file.into_iter().flatten().collect();
    let fresh_idx: Vec<usize> = all
        .iter()
        .enumerate()
        .filter(|(_, e)| big(&e.unit) && !KIT.is_match(&e.file) && added.get(e.file.as_str()).is_some_and(|l| l.contains(&e.unit.line)))
        .map(|(i, _)| i)
        .collect();
    let mut fresh: Vec<Entry> =
        fresh_idx.iter().map(|&i| Entry { file: all[i].file.clone(), unit: all[i].unit.clone(), prints: None }).collect();
    let mut ids = HashMap::new();
    let matches = best_matches(&mut fresh, &mut all, &mut ids);
    let mut seen = HashSet::new();
    let mut cache = HashMap::new();
    let mut findings = Vec::new();
    let mut reported = HashSet::new();
    for (fi, oi, sim) in matches {
        let (e, other) = (&fresh[fi], &all[oi]);
        let mut key = [format!("{}:{}", e.file, e.unit.line), format!("{}:{}", other.file, other.unit.line)];
        key.sort();
        let key = key.join(" ");
        let threshold = if e.unit.kind == "type" { TYPE_THRESHOLD } else { THRESHOLD };
        if sim < threshold
            || seen.contains(&key)
            || pasted(
                &request.root,
                (&e.file, e.unit.line, e.unit.end_line),
                (&other.file, other.unit.line, other.unit.end_line),
                n,
                &mut cache,
            )
            || apart(&e.unit, &other.unit)
        {
            continue;
        }
        seen.insert(key);
        reported.insert(format!("{}:{} {}:{}", e.file, e.unit.name, other.file, other.unit.name));
        findings.push(Finding {
            file: e.file.clone(),
            line: e.unit.line,
            target: format!("{}:{}", e.file, e.unit.name),
            message: message(e, other, sim),
        });
    }
    findings.extend(partial_copies(request, files, &added, whole, n, &reported, &mut cache));
    Ok(Answer::new(findings, format!("{} added units checked against {} units", fresh.len(), all.len())))
}
