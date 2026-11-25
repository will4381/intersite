//! The API contract lint behind `replay --mode contract`: what an API's requests carry and what it answers, read across
//! every route for inconsistency and bad shapes. Nothing is configured: a convention is what a clear majority of enough
//! routes or fields already do (as in the naming check), and a route that departs from it is a finding. Checks that
//! need no convention (a stack trace in an error, a password hash in an answer) report on their own. Findings are per
//! route, not per case, in the order they were found. Shapes are shared/shape.mjs's: a kind string ("string", "number",
//! "boolean", "null"), an array of the distinct element shapes, or an object of shapes.

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};
use std::borrow::{Borrow, Cow};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::sync::LazyLock;

use crate::text::{restyle, style_name, style_of, Style};
use crate::{Answer, Request};

// ponytail: thresholds borrowed from the naming check (tuned on 22 repositories), not yet tuned on recorded traffic.
const MIN_AGREE: usize = 5;
const SHARE: f64 = 0.9;
const SHOWN: usize = 3;
/// Findings of one kind under one object, this many or more, print as one line: one root cause, not dozens of lines.
const GROUP: usize = 3;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    evidence: Vec<Evidence>,
    id_pattern: String,
    /// `replay.contractIgnore`.
    #[serde(default)]
    ignore: Vec<Ignore>,
}

/// One case: the recorded, scrubbed request, the production answer's status and shape, and the live answer when the
/// case was replayed in this run.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    case_id: String,
    method: String,
    route: String,
    path: String,
    actor: String,
    /// None for no body and for a JSON null alike.
    #[serde(default)]
    body: Option<Value>,
    status: i64,
    shape: Value,
    #[serde(default)]
    live: Option<Live>,
}

/// What the local server answered one replayed case. `sent`: the credential header values the request carried.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Live {
    status: i64,
    /// None when the body was not JSON, which is not a JSON null.
    #[serde(default, deserialize_with = "present")]
    json: Option<Value>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    sent: Vec<String>,
}

/// A deliberate exception. A field given as anything but a string (null included) matches nothing.
#[derive(Deserialize)]
struct Ignore {
    route: String,
    #[serde(default, deserialize_with = "present")]
    pointer: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    check: Option<Value>,
}

/// A field that was given, even as null.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// `detail`: the kinds a field is typed as, for a group's examples. `group`: the parent pointer of the findings it was
/// grouped with (see group_findings).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Finding {
    check: &'static str,
    method: String,
    route: String,
    pointer: String,
    message: String,
    case_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { evidence, id_pattern, ignore } = request.options()?;
    let pattern = fancy_regex::Regex::new(&id_pattern).map_err(|e| format!("contract: idPattern {id_pattern}: {e}"))?;
    let findings = lint(&Api { routes: routes_of(&evidence), pattern }, &ignore);
    let data = serde_json::to_value(findings).map_err(|e| e.to_string())?;
    Ok(Answer { findings: vec![], summary: String::new(), data: Some(data) })
}

// ---- Evidence by route ----

/// One answer to a case: the recorded one, or the live one when the case was replayed.
struct Reply<'a> {
    case_id: &'a str,
    status: i64,
    shape: Cow<'a, Value>,
    live: Option<&'a Live>,
}

impl Reply<'_> {
    fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

struct Route<'a> {
    key: String,
    method: &'a str,
    route: &'a str,
    cases: Vec<&'a Evidence>,
    answers: Vec<Reply<'a>>,
}

impl Route<'_> {
    fn ok(&self) -> impl Iterator<Item = &Reply<'_>> {
        self.answers.iter().filter(|answer| answer.is_ok())
    }

    fn first_case(&self) -> &str {
        &self.cases[0].case_id
    }
}

struct Api<'a> {
    routes: Vec<Route<'a>>,
    pattern: fancy_regex::Regex,
}

impl Api<'_> {
    fn is_id(&self, text: &str) -> bool {
        self.pattern.is_match(text).unwrap_or(false)
    }
}

/// The evidence grouped by method and route template, cases ordered by ID so the case a finding names is stable.
fn routes_of(evidence: &[Evidence]) -> Vec<Route<'_>> {
    let mut sorted: Vec<&Evidence> = evidence.iter().collect();
    sorted.sort_by(|a, b| js_cmp(&a.case_id, &b.case_id));
    let mut routes: Ordered<String, Route> = Ordered::default();
    for item in sorted {
        let key = format!("{} {}", item.method, item.route);
        let route = routes.entry(key.clone(), || Route { key, method: &item.method, route: &item.route, cases: vec![], answers: vec![] });
        route.cases.push(item);
        route.answers.push(Reply { case_id: &item.case_id, status: item.status, shape: Cow::Borrowed(&item.shape), live: None });
        if let Some(live) = item.live.as_ref().filter(|live| live.status != 0) {
            let shape = Cow::Owned(shape_of(live.json.as_ref()));
            route.answers.push(Reply { case_id: &item.case_id, status: live.status, shape, live: Some(live) });
        }
    }
    routes.into_values()
}

#[derive(Clone, Copy, PartialEq)]
enum Side {
    Response,
    Request,
}

impl Side {
    fn name(self) -> &'static str {
        match self {
            Side::Response => "response",
            Side::Request => "request",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Side::Response => "",
            Side::Request => "request ",
        }
    }
}

/// The shapes one side of a route carries, with their cases: the request bodies, or the answers (only the successful
/// ones with `ok_only`).
fn shapes<'r>(route: &'r Route, side: Side, ok_only: bool) -> Vec<(&'r str, Cow<'r, Value>)> {
    match side {
        Side::Request => route
            .cases
            .iter()
            .filter_map(|item| item.body.as_ref().map(|body| (item.case_id.as_str(), Cow::Owned(shape_of(Some(body))))))
            .collect(),
        Side::Response => route
            .answers
            .iter()
            .filter(|answer| !ok_only || answer.is_ok())
            .map(|answer| (answer.case_id, Cow::Borrowed(answer.shape.as_ref())))
            .collect(),
    }
}

/// The findings, deduplicated by check, route and pointer (the first wins), less the ignored ones; then grouped, and
/// an entry on a group's parent pointer silences the whole group.
fn lint(api: &Api, ignore: &[Ignore]) -> Vec<Finding> {
    let mut found = Found::default();
    for side in [Side::Response, Side::Request] {
        casing(api, side, &mut found);
        types(api, side, &mut found);
    }
    let checks: [fn(&Api, &mut Found); 11] =
        [types_across_routes, envelope, lists, errors, status_and_body, values, absence, exposure, repeated, requests, route_names];
    for check in checks {
        check(api, &mut found);
    }
    let mut visible: Vec<Finding> = found.list.into_iter().filter(|f| !ignore.iter().any(|entry| ignores(entry, f, &f.pointer))).collect();
    group_findings(&mut visible);
    visible.retain(|f| f.group.as_deref().is_none_or(|group| !ignore.iter().any(|entry| ignores(entry, f, group))));
    visible
}

#[derive(Default)]
struct Found {
    list: Vec<Finding>,
    index: HashMap<String, usize>,
}

impl Found {
    /// Records a finding unless one of this check, route and pointer already is; returns the one recorded.
    fn add(&mut self, route: &Route, check: &'static str, pointer: &str, case_id: &str, message: String) -> &mut Finding {
        let key = format!("{check}\0{}\0{pointer}", route.key);
        let at = *self.index.entry(key).or_insert_with(|| {
            let (method, route, pointer, case_id) =
                (route.method.to_string(), route.route.to_string(), pointer.to_string(), case_id.to_string());
            self.list.push(Finding { check, method, route, pointer, message, case_id, detail: None, group: None });
            self.list.len() - 1
        });
        &mut self.list[at]
    }
}

fn ignores(entry: &Ignore, finding: &Finding, pointer: &str) -> bool {
    let fits = |field: &Option<Value>, value: &str| field.as_ref().is_none_or(|given| given.as_str() == Some(value));
    (entry.route == format!("{} {}", finding.method, finding.route) || entry.route == finding.route)
        && fits(&entry.pointer, pointer)
        && fits(&entry.check, finding.check)
}

// ---- Grouping ----

/// What a finding says to do: the text after its last `: `.
fn remedy_of(message: &str) -> &str {
    match message.rfind(": ") {
        Some(at) => &message[at + 2..],
        None => message.char_indices().nth(1).map_or("", |(at, _)| &message[at..]),
    }
}

/// The pointer of the object holding a field: `/a/b` -> `/a`, `/a` -> `` (the answer itself).
fn parent_of(pointer: &str) -> &str {
    &pointer[..pointer.rfind('/').unwrap_or(0)]
}

type Parents = Vec<(String, Vec<usize>)>;

/// Sets `group` on findings that share a check, a route, a remedy and a parent object, when there are at least GROUP of
/// them: one cause (a metrics object whose values are strings in some answers) is one finding. Sibling groups under one
/// object (`/metrics/tiktok/*` and `/metrics/meta/*`) become one group under it, but never one for the whole answer.
fn group_findings(findings: &mut [Finding]) {
    let mut kinds: Ordered<String, Parents> = Ordered::default();
    for (at, f) in findings.iter().enumerate().filter(|(_, f)| f.pointer.encode_utf16().count() > 1) {
        let parents = kinds.entry(format!("{}\0{} {}\0{}", f.check, f.method, f.route, remedy_of(&f.message)), Vec::new);
        let parent = parent_of(&f.pointer);
        match parents.iter_mut().find(|(name, _)| name == parent) {
            Some((_, list)) => list.push(at),
            None => parents.push((parent.to_string(), vec![at])),
        }
    }
    for mut parents in kinds.into_values() {
        lift(&mut parents);
        for (parent, list) in parents.iter().filter(|(_, list)| list.len() >= GROUP) {
            for &at in list {
                findings[at].group = Some(if parent.is_empty() { "/".to_string() } else { parent.clone() });
            }
        }
    }
}

/// Merges sibling groups (two or more findings each) into their parent object, repeatedly, below the answer's root. Each
/// pass reads the groups as they stood when it began, as a JavaScript Map spread would.
fn lift(parents: &mut Parents) {
    loop {
        let mut ups: Vec<(String, Parents)> = vec![];
        for (parent, list) in parents.iter().filter(|(parent, list)| list.len() >= 2 && !parent_of(parent).is_empty()) {
            let up = parent_of(parent);
            match ups.iter_mut().find(|(name, _)| name == up) {
                Some((_, entries)) => entries.push((parent.clone(), list.clone())),
                None => ups.push((up.to_string(), vec![(parent.clone(), list.clone())])),
            }
        }
        let mut changed = false;
        for (up, entries) in ups.into_iter().filter(|(_, entries)| entries.len() >= 2) {
            let merged = entries.iter().flat_map(|(_, list)| list.iter().copied());
            match parents.iter_mut().find(|(name, _)| *name == up) {
                Some((_, list)) => list.extend(merged),
                None => parents.push((up, merged.collect())),
            }
            parents.retain(|(name, _)| !entries.iter().any(|(gone, _)| gone == name));
            changed = true;
        }
        if !changed {
            return;
        }
    }
}

// ---- Shapes and JSON values ----

/// `a < b` on JavaScript strings: by UTF-16 code unit.
fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A key JavaScript keeps as an array index, which objects list first in numeric order.
fn array_index(key: &str) -> Option<u64> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.len() <= 10 && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u64>().ok().filter(|n| canonical && *n < u64::from(u32::MAX))
}

/// shared/shape.mjs's shapeOf: keys sorted as JavaScript sorts and then lists them, array elements distinct and sorted.
fn shape_of(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => "null".into(),
        Some(Value::Bool(_)) => "boolean".into(),
        Some(Value::Number(_)) => "number".into(),
        Some(Value::String(_)) => "string".into(),
        Some(Value::Array(items)) => {
            let mut distinct: Vec<(String, Value)> = vec![];
            for item in items {
                let shape = shape_of(Some(item));
                let key = serde_json::to_string(&shape).unwrap_or_default();
                if !distinct.iter().any(|(seen, _)| *seen == key) {
                    distinct.push((key, shape));
                }
            }
            distinct.sort_by(|a, b| js_cmp(&a.0, &b.0));
            Value::Array(distinct.into_iter().map(|(_, shape)| shape).collect())
        }
        Some(Value::Object(record)) => {
            let mut keys: Vec<&String> = record.keys().collect();
            keys.sort_by(|a, b| js_cmp(a, b));
            keys.sort_by_key(|key| array_index(key).map_or((1, 0), |n| (0, n)));
            Value::Object(keys.into_iter().map(|key| (key.clone(), shape_of(record.get(key)))).collect())
        }
    }
}

fn kind_of(shape: &Value) -> &str {
    match shape {
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        Value::String(kind) => kind,
        _ => "",
    }
}

fn article(kind: &str) -> String {
    let an = kind.starts_with(['a', 'e', 'i', 'o', 'u']);
    format!("{} {kind}", if an { "an" } else { "a" })
}

/// The first few of a list, and how many more.
fn some(list: impl IntoIterator<Item = String>) -> String {
    let list: Vec<String> = list.into_iter().collect();
    let more = if list.len() > SHOWN { format!(" and {} more", list.len() - SHOWN) } else { String::new() };
    list[..list.len().min(SHOWN)].join(", ") + &more
}

/// Every object in a shape with its pointer (array elements are `*`), outermost first.
fn objects_of<'s>(shape: &'s Value, pointer: String, out: &mut Vec<(String, &'s Map<String, Value>)>) {
    match shape {
        Value::Array(elements) => elements.iter().for_each(|element| objects_of(element, format!("{pointer}/*"), out)),
        Value::Object(fields) => {
            out.push((pointer.clone(), fields));
            fields.iter().for_each(|(key, value)| objects_of(value, format!("{pointer}/{key}"), out));
        }
        _ => {}
    }
}

/// A key in a shape: its pointer, name, shape, and the object it sits in.
struct Field<'s> {
    pointer: String,
    parent: String,
    key: &'s str,
    shape: &'s Value,
    siblings: &'s Map<String, Value>,
}

fn fields_of(shape: &Value) -> Vec<Field<'_>> {
    let mut objects = vec![];
    objects_of(shape, String::new(), &mut objects);
    objects
        .into_iter()
        .flat_map(|(parent, siblings)| {
            siblings.iter().map(move |(key, shape)| Field {
                pointer: format!("{parent}/{key}"),
                parent: parent.clone(),
                key,
                shape,
                siblings,
            })
        })
        .collect()
}

/// A leaf of a JSON value with its pointer (array elements are `*`) and key.
struct Leaf<'v> {
    pointer: String,
    key: &'v str,
    value: &'v Value,
}

fn leaves_of<'v>(value: &'v Value, pointer: String, key: &'v str, out: &mut Vec<Leaf<'v>>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| leaves_of(item, format!("{pointer}/*"), key, out)),
        Value::Object(fields) => fields.iter().for_each(|(name, item)| leaves_of(item, format!("{pointer}/{name}"), name, out)),
        _ => out.push(Leaf { pointer, key, value }),
    }
}

/// The leaves of a live answer's JSON (none when it was not JSON).
fn live_leaves<'v>(answer: &Reply<'v>) -> Vec<Leaf<'v>> {
    let mut out = vec![];
    if let Some(json) = answer.live.and_then(|live| live.json.as_ref()) {
        leaves_of(json, String::new(), "", &mut out);
    }
    out
}

/// `String(number)` as JavaScript writes it.
fn js_number(n: &Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f == 0.0 {
        return "0".into();
    }
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{f:.0}");
    }
    if f.abs() >= 1e21 || f.abs() < 1e-6 {
        let exponent = format!("{f:e}");
        return if exponent.contains("e-") { exponent } else { exponent.replacen('e', "e+", 1) };
    }
    format!("{f}")
}

fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

// ---- Conventions ----

/// The value a clear majority of enough votes share: at least MIN_AGREE of them and SHARE of all.
struct Rule<T> {
    value: T,
    agree: usize,
    total: usize,
}

fn majority<T: Eq + Hash>(votes: impl IntoIterator<Item = T>) -> Option<Rule<T>> {
    let mut counts: HashMap<T, usize> = HashMap::new();
    let mut total = 0;
    for vote in votes {
        *counts.entry(vote).or_default() += 1;
        total += 1;
    }
    // At most one value can hold SHARE (over half), so which is checked first does not matter.
    counts.into_iter().find(|(_, agree)| *agree >= MIN_AGREE && *agree as f64 >= SHARE * total as f64).map(|(value, agree)| Rule {
        value,
        agree,
        total,
    })
}

/// A map that iterates in insertion order, as JavaScript's Map does.
struct Ordered<K, V> {
    index: HashMap<K, usize>,
    entries: Vec<(K, V)>,
}

impl<K, V> Default for Ordered<K, V> {
    fn default() -> Self {
        Ordered { index: HashMap::new(), entries: vec![] }
    }
}

impl<K: Eq + Hash + Clone, V> Ordered<K, V> {
    fn entry(&mut self, key: K, make: impl FnOnce() -> V) -> &mut V {
        let at = match self.index.get(&key) {
            Some(&at) => at,
            None => {
                self.entries.push((key.clone(), make()));
                self.index.insert(key, self.entries.len() - 1);
                self.entries.len() - 1
            }
        };
        &mut self.entries[at].1
    }

    /// Replaces the value in place, or adds it at the end.
    fn set(&mut self, key: K, value: V) {
        match self.index.get(&key) {
            Some(&at) => self.entries[at].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    fn get<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.index.get(key).map(|&at| &self.entries[at].1)
    }

    fn contains<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.index.contains_key(key)
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    fn into_values(self) -> Vec<V> {
        self.entries.into_iter().map(|(_, value)| value).collect()
    }
}

/// The values of `new Map(entries)`: each key once, at its first position, holding its last value.
fn js_map<K: Eq + Hash + Clone, V>(entries: impl IntoIterator<Item = (K, V)>) -> Vec<V> {
    let mut map = Ordered::default();
    entries.into_iter().for_each(|(key, value)| map.set(key, value));
    map.into_values()
}

// ---- Names ----

/// Whether a path segment or key names a plural (`orders`, `user-profiles`; not `status`, `access`).
fn plural(word: &str) -> bool {
    static PLURAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^siu:]s$|^(?:people|children|data|media)$").unwrap());
    let chars: Vec<char> = word.chars().collect();
    let mut start = 0;
    for i in 0..chars.len() {
        if chars[i] == '-' || chars[i] == '_' {
            start = i + 1;
        } else if i > 0 && chars[i - 1].is_ascii_lowercase() && chars[i].is_ascii_uppercase() {
            start = i;
        }
    }
    PLURAL.is_match(&chars[start..].iter().collect::<String>().to_lowercase())
}

fn ends_sibilant(word: &str) -> bool {
    ["s", "x", "ch", "sh"].iter().any(|end| word.ends_with(end))
}

/// A word in plural form, roughly.
fn plural_of(word: &str) -> String {
    let mut out = word.to_string();
    if let Some(stem) = word.strip_suffix('y').filter(|stem| stem.chars().last().is_some_and(|c| !"aeiou".contains(c))) {
        out = format!("{stem}ie");
    }
    if ends_sibilant(&out) {
        out.push('e');
    }
    out + "s"
}

/// A word in singular form, roughly.
fn singular(word: &str) -> String {
    let mut out = word.strip_suffix("ies").map_or_else(|| word.to_string(), |stem| format!("{stem}y"));
    if let Some(stem) = out.strip_suffix("es").filter(|stem| ends_sibilant(stem)) {
        out = stem.to_string();
    }
    if let Some(stem) = out.strip_suffix('s').filter(|stem| !stem.ends_with('s')) {
        out = stem.to_string();
    }
    out
}

// ---- Casing ----

/// A key cased in a style other than one plain word, with where it was seen.
struct Cased<'a> {
    route: &'a Route<'a>,
    case_id: &'a str,
    field: Field<'a>,
    style: Style,
}

/// Keys cased against the API's dominant style, one finding per route. Keys of a nested object written wholly in
/// another style, in a route whose other keys follow the API, are a third party's object passed through and left alone.
/// With no dominant style, an object mixing styles is the finding.
fn casing(api: &Api, side: Side, found: &mut Found) {
    static FOREIGN_ROUTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:webhooks?|callbacks?|hooks)(?:/|$)").unwrap());
    let shapes: Vec<(&Route, &str, Cow<Value>)> = api
        .routes
        .iter()
        .filter(|route| !FOREIGN_ROUTE.is_match(route.route))
        .flat_map(|route| shapes(route, side, false).into_iter().map(move |(case_id, shape)| (route, case_id, shape)))
        .collect();
    let fields: Vec<Cased> = shapes
        .iter()
        .flat_map(|(route, case_id, shape)| {
            let (route, case_id) = (*route, *case_id);
            fields_of(shape).into_iter().filter_map(move |field| {
                let style = style_of(field.key).filter(|style| *style != Style::Word)?;
                Some(Cased { route, case_id, field, style })
            })
        })
        .filter(|cased| !api.is_id(cased.field.key))
        .collect();
    let rule = majority(js_map(fields.iter().map(|f| ((f.route.key.as_str(), f.field.pointer.as_str()), f.style))));
    let Some(rule) = rule else { return mixed_casing(&fields, side, found) };
    for list in off_casing(&fields, rule.value).into_values() {
        let (first, style) = (list[0], rule.value);
        let what = if list.len() == 1 {
            format!("{} is {}", first.field.pointer, style_name(first.style))
        } else {
            format!("{} are not {}", some(list.iter().map(|f| f.field.pointer.clone())), style_name(style))
        };
        let message = format!(
            "{}{what}; {} of {} {} fields in this API are {}: rename {} {}",
            side.prefix(),
            rule.agree,
            rule.total,
            side.name(),
            style_name(style),
            if list.len() == 1 { "it" } else { "them" },
            some(list.iter().map(|f| restyle(f.field.key, style)))
        );
        found.add(first.route, "casing", &first.field.pointer, first.case_id, message);
    }
}

/// The keys of each route cased against `style`, each pointer once, leaving out objects passed through.
fn off_casing<'f, 'a>(fields: &'f [Cased<'a>], style: Style) -> Ordered<&'f str, Vec<&'f Cased<'a>>> {
    let followed: HashSet<&str> = fields.iter().filter(|f| f.style == style).map(|f| f.route.key.as_str()).collect();
    let mut off: Ordered<&str, Vec<&Cased>> = Ordered::default();
    for field in fields {
        if field.style == style || passed_through(field, style, &followed) {
            continue;
        }
        let list = off.entry(field.route.key.as_str(), Vec::new);
        if !list.iter().any(|other| other.field.pointer == field.field.pointer) {
            list.push(field);
        }
    }
    off
}

/// A nested object whose cased keys are all in another style than the API's, in a route that otherwise follows it, or
/// an object keyed by data.
fn passed_through(cased: &Cased, style: Style, followed: &HashSet<&str>) -> bool {
    static CASED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[-_A-Z]").unwrap());
    if cased.field.parent.is_empty() {
        return false;
    }
    let keys: Vec<&String> = cased
        .field
        .siblings
        .keys()
        .filter(|key| CASED.is_match(key.get(key.chars().next().map_or(0, char::len_utf8)..).unwrap_or("")))
        .collect();
    let foreign = followed.contains(cased.route.key.as_str()) && keys.len() > 1 && !keys.iter().any(|key| style_of(key) == Some(style));
    foreign || dictionary(cased.field.siblings)
}

/// An object keyed by data rather than by field names (`{ good: 3, needs_work: 1, strong: 9 }`, a permission map): at
/// least three keys, no `id`, and values that all have one shape other than a string (a record of strings is common).
/// Its keys are values, so their casing is not the API's to choose.
fn dictionary(object: &Map<String, Value>) -> bool {
    let shapes: Vec<String> = object.values().map(json_text).collect();
    shapes.len() >= 3 && !object.contains_key("id") && shapes[0] != "\"string\"" && shapes.iter().all(|shape| *shape == shapes[0])
}

/// With no API-wide style: one object holding keys in two styles.
fn mixed_casing(fields: &[Cased], side: Side, found: &mut Found) {
    let mut objects: HashMap<(&str, &str), Vec<(Style, &str)>> = HashMap::new();
    for f in fields {
        let styles = objects.entry((f.route.key.as_str(), f.field.parent.as_str())).or_default();
        if !styles.iter().any(|(style, _)| *style == f.style) {
            styles.push((f.style, f.field.key));
        }
        if let [(a, first), (b, second)] = styles[..] {
            let at = if f.field.parent.is_empty() { "/" } else { &f.field.parent };
            let message = format!(
                "{}{at} mixes {} ({first}) and {} ({second}) in one object: write every key in one style",
                side.prefix(),
                style_name(a),
                style_name(b)
            );
            found.add(f.route, "casing", at, f.case_id, message);
        }
    }
}

// ---- Types ----

/// The same key at the same pointer of one route answered (or sent) with different types across cases, beyond null.
fn types(api: &Api, side: Side, found: &mut Found) {
    for route in &api.routes {
        types_of_route(route, side, found);
    }
}

fn types_of_route(route: &Route, side: Side, found: &mut Found) {
    // pointer -> kind -> case IDs
    let mut kinds: Ordered<String, Ordered<String, Vec<&str>>> = Ordered::default();
    // A list whose rows type one field differently within a single answer (a field definition's `default`) is a union
    // by design, not drift between cases.
    let mut unions: HashSet<String> = HashSet::new();
    for (case_id, shape) in shapes(route, side, true) {
        let mut here: HashMap<String, &str> = HashMap::new();
        for field in fields_of(&shape).into_iter().filter(|field| kind_of(field.shape) != "null") {
            let kind = kind_of(field.shape);
            if here.get(&field.pointer).is_some_and(|seen| *seen != kind) {
                unions.insert(field.pointer.clone());
            }
            here.insert(field.pointer.clone(), kind);
            let ids = kinds.entry(field.pointer, Ordered::default).entry(kind.to_string(), Vec::new);
            if !ids.contains(&case_id) {
                ids.push(case_id);
            }
        }
    }
    for (pointer, seen) in kinds.iter().filter(|(pointer, seen)| seen.len() >= 2 && !unions.contains(*pointer)) {
        let mut sorted: Vec<(&String, &Vec<&str>)> = seen.iter().collect();
        sorted.sort_by_key(|(_, ids)| std::cmp::Reverse(ids.len()));
        let ((top, top_ids), (kind, ids)) = (sorted[0], sorted[1]);
        let total: usize = seen.iter().map(|(_, ids)| ids.len()).sum();
        let (check, what, remedy) = match side {
            Side::Request => ("requests", format!("request {pointer} arrives as"), "clients disagree; accept"),
            Side::Response => ("types", format!("{pointer} is"), "answer"),
        };
        let message = format!(
            "{what} {} here; {} of {total} cases of this route have {}: {remedy} one type every time",
            article(kind),
            top_ids.len(),
            article(top)
        );
        found.add(route, check, pointer, ids[0], message).detail.get_or_insert_with(|| format!("{kind}, {top}"));
    }
}

/// A scalar kind as a static string.
fn scalar(kind: &str) -> Option<&'static str> {
    ["string", "number", "boolean"].into_iter().find(|scalar| *scalar == kind)
}

/// A key's answers in one route: the kinds it has, and where it was first seen.
struct Typed<'a> {
    route: &'a Route<'a>,
    pointer: String,
    case_id: &'a str,
    kinds: Vec<&'static str>,
}

/// An ID, count or money key typed differently across routes (`id` a string in most routes, a number in one; other
/// names, such as `email` or `version`, mean different things in different places), and date fields that are numbers
/// where the API's other date fields are strings.
fn types_across_routes(api: &Api, found: &mut Found) {
    static TYPED_KEY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:id|uuid|total|count|amount|price|quantity|cost|balance|subtotal|tax|fee)$|[a-z0-9](?:Id|_id|ID|Count|_count|Total|_total|Amount|_amount|Price|_price|Cents|_cents)$").unwrap()
    });
    // Named like a date but a flag or a count: `is_vaccinations_up_to_date`, `requires_onset_date`.
    static FLAG_KEY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(?:is|has|requires|can|should|needs?)(?:_|[A-Z])|up_?to_?date").unwrap());
    let mut by_key: Ordered<&str, Ordered<&str, Typed>> = Ordered::default();
    let mut dates: Ordered<(&str, String), Typed> = Ordered::default();
    for route in &api.routes {
        for answer in route.ok() {
            for field in fields_of(&answer.shape) {
                let Some(kind) = scalar(kind_of(field.shape)) else { continue };
                if TYPED_KEY.is_match(field.key) {
                    let make = || Typed { route, pointer: field.pointer.clone(), case_id: answer.case_id, kinds: vec![] };
                    let typed = by_key.entry(field.key, Ordered::default).entry(route.key.as_str(), make);
                    if !typed.kinds.contains(&kind) {
                        typed.kinds.push(kind);
                    }
                }
                if DATE_KEY.is_match(field.key) && !FLAG_KEY.is_match(field.key) && kind != "boolean" {
                    let date = Typed { route, pointer: field.pointer.clone(), case_id: answer.case_id, kinds: vec![kind] };
                    dates.set((route.key.as_str(), field.pointer), date);
                }
            }
        }
    }
    for (key, routes) in by_key.iter() {
        typed_key(key, routes, found);
    }
    date_kinds(&dates.into_values(), found);
}

fn typed_key(key: &str, routes: &Ordered<&str, Typed>, found: &mut Found) {
    let single: Vec<&Typed> = routes.iter().map(|(_, typed)| typed).filter(|typed| typed.kinds.len() == 1).collect();
    let Some(rule) = majority(single.iter().map(|typed| typed.kinds[0])) else { return };
    for typed in single.iter().filter(|typed| typed.kinds[0] != rule.value) {
        let message = format!(
            "{} is {}; {} of {} routes answer {key} as {}: answer {}",
            typed.pointer,
            article(typed.kinds[0]),
            rule.agree,
            rule.total,
            article(rule.value),
            article(rule.value)
        );
        found.add(typed.route, "types", &typed.pointer, typed.case_id, message);
    }
}

fn date_kinds(dates: &[Typed], found: &mut Found) {
    let Some(rule) = majority(dates.iter().map(|date| date.kinds[0])) else { return };
    let remedy = if rule.value == "string" { "an ISO 8601 string" } else { "the same form" };
    for date in dates.iter().filter(|date| date.kinds[0] != rule.value) {
        let message = format!(
            "{} is {}; {} of {} date fields in this API are {}s: answer {remedy}",
            date.pointer,
            article(date.kinds[0]),
            rule.agree,
            rule.total,
            rule.value
        );
        found.add(date.route, "types", &date.pointer, date.case_id, message);
    }
}

// ---- Envelopes and lists ----

/// The first successful answer with a body, per route.
fn roots_of<'a>(api: &'a Api) -> Vec<(&'a Route<'a>, &'a Reply<'a>)> {
    api.routes.iter().filter_map(|route| route.ok().find(|answer| kind_of(&answer.shape) != "null").map(|answer| (route, answer))).collect()
}

/// The top-level keys of an answer that hold an object or a list.
fn wrappers(shape: &Value) -> Vec<&str> {
    shape.as_object().map_or(vec![], |object| {
        object.iter().filter(|(_, value)| value.is_object() || value.is_array()).map(|(key, _)| key.as_str()).collect()
    })
}

/// A top-level wrapper (`data`) most routes answer in and this one does not; or, where most routes answer bare, one
/// that wraps its answer.
fn envelope(api: &Api, found: &mut Found) {
    let roots = roots_of(api);
    let mut counts: Ordered<&str, usize> = Ordered::default();
    for (_, answer) in &roots {
        for key in wrappers(&answer.shape) {
            *counts.entry(key, || 0) += 1;
        }
    }
    let best = counts
        .iter()
        .fold(None, |best: Option<(&str, usize)>, (key, n)| if best.is_none_or(|(_, most)| *n > most) { Some((*key, *n)) } else { best });
    if let Some((best, _)) = best {
        let rule = majority(roots.iter().map(|(_, answer)| wrappers(&answer.shape).contains(&best)));
        if let Some(rule) = rule.filter(|rule| rule.value) {
            for (route, answer) in roots.iter().filter(|(_, answer)| !wrappers(&answer.shape).contains(&best)) {
                let message = format!(
                    "answers without the top-level {best} that {} of {} routes wrap their answer in: answer {{ {best}: … }}",
                    rule.agree, rule.total
                );
                found.add(route, "envelope", "/", answer.case_id, message);
            }
            return;
        }
    }
    needless_envelopes(&roots, found);
}

/// An answer wrapped in a lone `data` (or `result`, ...) where most other routes answer the value itself.
fn needless_envelopes(roots: &[(&Route, &Reply)], found: &mut Found) {
    static ENVELOPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:data|result|payload|response|body)$").unwrap());
    for (route, answer) in roots {
        let Some(object) = answer.shape.as_object().filter(|object| object.len() == 1) else { continue };
        let key = object.keys().next().map_or("", String::as_str);
        if !ENVELOPE.is_match(key) {
            continue;
        }
        let others = roots.iter().filter(|(other, _)| !std::ptr::eq(*other, *route));
        let bare = majority(others.map(|(_, other)| other.shape.as_object().is_none_or(|object| !object.contains_key(key))));
        if let Some(bare) = bare.filter(|bare| bare.value) {
            let message = format!(
                "wraps its answer in {{ {key}: … }}; {} of {} other routes answer without it: answer the value itself",
                bare.agree, bare.total
            );
            found.add(route, "envelope", "/", answer.case_id, message);
        }
    }
}

static PAGING: LazyLock<[(&str, Regex); 3]> = LazyLock::new(|| {
    [
        ("total", Regex::new(r"^(?:total|count|totalCount|total_count|totalItems|total_items|totalResults|total_results)$").unwrap()),
        (
            "next",
            Regex::new(r"^(?:next|nextCursor|next_cursor|cursor|nextPageToken|next_page_token|nextPage|next_page|nextLink|next_link|endCursor|end_cursor|page)$")
                .unwrap(),
        ),
        ("more", Regex::new(r"^(?:hasMore|has_more|hasNextPage|has_next_page)$").unwrap()),
    ]
});

/// How a GET on a collection answers: a bare array, or an object holding one list of rows and its paging keys.
struct List<'a> {
    route: &'a Route<'a>,
    case_id: &'a str,
    bare: bool,
    items: &'a str,
    paging: Vec<&'a str>,
}

/// The list a GET on a collection (a plural last segment) answers; None when the answer is not a list.
fn list_of<'a>(route: &'a Route<'a>, answer: &'a Reply<'a>) -> Option<List<'a>> {
    static LIST_META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:meta|pagination|paging|page_?info|pageInfo|links)$").unwrap());
    static ROWS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:data|list)$").unwrap());
    if route.method != "GET" || !plural(route.route.rsplit('/').next().unwrap_or("")) {
        return None;
    }
    let list = |bare, items, paging| Some(List { route, case_id: answer.case_id, bare, items, paging });
    if answer.shape.is_array() {
        return list(true, "", vec![]);
    }
    let object = answer.shape.as_object()?;
    let (arrays, others): (Vec<&String>, Vec<&String>) = object.keys().partition(|key| object[*key].is_array());
    let other_object = others.iter().any(|key| object[*key].is_object() && !LIST_META.is_match(key));
    if arrays.len() != 1 || !(plural(arrays[0]) || ROWS.is_match(arrays[0])) || other_object {
        return None;
    }
    let nested = others.iter().filter_map(|key| object[*key].as_object()).flat_map(|meta| meta.keys());
    let paging =
        others.iter().copied().chain(nested).filter(|key| PAGING.iter().any(|(_, role)| role.is_match(key))).map(String::as_str).collect();
    list(false, arrays[0].as_str(), paging)
}

/// List answers: a bare array where the API's lists are objects; another name for the rows or a paging key than the
/// API's; a list with no paging at all where the API's lists are paged.
fn lists(api: &Api, found: &mut Found) {
    let all: Vec<List> = roots_of(api).into_iter().filter_map(|(route, answer)| list_of(route, answer)).collect();
    let wrapped: Vec<&List> = all.iter().filter(|list| !list.bare).collect();
    let shape = majority(all.iter().map(|list| list.bare));
    let items = majority(wrapped.iter().map(|list| list.items));
    let paged = majority(wrapped.iter().map(|list| !list.paging.is_empty()));
    for list in &all {
        if let Some(shape) = shape.as_ref().filter(|shape| list.bare && !shape.value) {
            let under = items.as_ref().map_or(String::new(), |items| format!(" under {}", items.value));
            let message = format!(
                "answers a bare array; {} of {} list routes answer an object with the rows{under} and paging: answer that object",
                shape.agree, shape.total
            );
            found.add(list.route, "envelope", "/", list.case_id, message);
        }
        if let Some(items) = items.as_ref().filter(|items| !list.bare && list.items != items.value) {
            let message = format!(
                "/{} holds the rows; {} of {} list routes call it {}: rename it {}",
                list.items, items.agree, items.total, items.value, items.value
            );
            found.add(list.route, "envelope", &format!("/{}", list.items), list.case_id, message);
        }
        if let Some(paged) = paged.as_ref().filter(|paged| paged.value && !list.bare && list.paging.is_empty()) {
            let message = format!(
                "returns the whole list with no paging; {} of {} list routes page theirs: add the API's paging keys",
                paged.agree, paged.total
            );
            found.add(list.route, "size", "/", list.case_id, message);
        }
    }
    for (role, pattern) in PAGING.iter() {
        paging_names(role, pattern, &wrapped, found);
    }
}

/// A paging key named unlike the API's other lists.
fn paging_names(role: &str, pattern: &Regex, wrapped: &[&List], found: &mut Found) {
    let named: Vec<(&List, &str)> =
        wrapped.iter().filter_map(|list| list.paging.iter().find(|key| pattern.is_match(key)).map(|key| (*list, *key))).collect();
    let Some(rule) = majority(named.iter().map(|(_, key)| *key)) else { return };
    let what = match role {
        "more" => "has-more flag",
        "next" => "next-page cursor",
        _ => "total",
    };
    for (list, key) in named.iter().filter(|(_, key)| *key != rule.value) {
        let message =
            format!("{key} is the {what}; {} of {} list routes call it {}: rename it {}", rule.agree, rule.total, rule.value, rule.value);
        found.add(list.route, "envelope", &format!("/{key}"), list.case_id, message);
    }
}

// ---- Errors and status ----

/// The form of an error answer, as a reader would name it.
fn error_form(answer: &Reply) -> String {
    if let Some(live) = answer.live.filter(|live| !live.text.is_empty() && !live.content_type.contains("json")) {
        return if live.content_type.contains("html") { "HTML" } else { "plain text" }.into();
    }
    if answer.live.is_some_and(|live| live.content_type.contains("problem+json")) {
        return "problem+json".into();
    }
    let Some(shape) = answer.shape.as_object() else {
        let kind = kind_of(&answer.shape);
        return if kind == "null" { "an empty body".into() } else { format!("a bare {kind}") };
    };
    let has = |key: &str| shape.contains_key(key);
    if has("title") && (has("type") || has("detail")) {
        return "problem+json".into();
    }
    if let Some(error) = shape.get("error") {
        return format!("{{ error: {} }}", kind_of(error));
    }
    if let Some(errors) = shape.get("errors") {
        return format!("{{ errors: {} }}", kind_of(errors));
    }
    if has("message") {
        return "{ message }".into();
    }
    format!("{{ {} }}", shape.keys().map(String::as_str).collect::<Vec<_>>().join(", "))
}

/// The form of one route's error answers with one status.
struct ErrorUnit<'a> {
    route: &'a Route<'a>,
    status: i64,
    form: String,
    case_id: &'a str,
}

/// The form of each route's error answers per status (a live answer wins), and the API's dominant one.
fn error_forms<'a>(api: &'a Api) -> (Vec<ErrorUnit<'a>>, Option<Rule<String>>) {
    let mut units: Ordered<(&str, i64), ErrorUnit> = Ordered::default();
    for route in &api.routes {
        for answer in route.answers.iter().filter(|answer| answer.status >= 400) {
            let unit = (route.key.as_str(), answer.status);
            if !units.contains(&unit) || answer.live.is_some() {
                units.set(unit, ErrorUnit { route, status: answer.status, form: error_form(answer), case_id: answer.case_id });
            }
        }
    }
    let units = units.into_values();
    let rule = majority(units.iter().map(|unit| unit.form.clone()));
    (units, rule)
}

/// 4xx and 5xx answers in another form than the API's dominant error form.
fn errors(api: &Api, found: &mut Found) {
    let (units, Some(rule)) = error_forms(api) else { return };
    for unit in units.iter().filter(|unit| unit.form != rule.value) {
        let message = format!(
            "the {} answer is {}; {} of {} error answers in this API are {}: answer in that form",
            unit.status, unit.form, rule.agree, rule.total, rule.value
        );
        found.add(unit.route, "errors", "/", unit.case_id, message);
    }
}

/// Status and body disagreeing: a 2xx whose body says it failed, a create answered with another status than the API's
/// creates, a 200 with an empty body where the API answers JSON, JSON labelled as something else.
fn status_and_body(api: &Api, found: &mut Found) {
    // A success answered in the API's own error form (problem+json, `{ error }`) is a failure with the wrong status.
    let own = error_forms(api).1.map(|rule| rule.value);
    for route in &api.routes {
        for answer in route.ok() {
            if let Some(failed) = failure_of(answer, own.as_deref()) {
                let message = format!("answers {} with {failed} in the body: answer a 4xx or 5xx status for a failure", answer.status);
                found.add(route, "status", "/", answer.case_id, message);
            }
        }
        for answer in &route.answers {
            let Some(live) = answer.live.filter(|live| !live.text.is_empty() && live.json.is_some() && !live.content_type.contains("json"))
            else {
                continue;
            };
            let label =
                if live.content_type.is_empty() { "with no content-type".into() } else { format!("content-type: {}", live.content_type) };
            found.add(route, "status", "/", answer.case_id, format!("answers JSON labelled {label}: send content-type: application/json"));
        }
    }
    creates(api, found);
    empty_bodies(api, found);
}

/// How a successful answer's body says it failed, if it does.
fn failure_of(answer: &Reply, own: Option<&str>) -> Option<String> {
    static ERROR_BODY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:error|errors|message|code|details?|status|statusCode|success|ok|requestId|request_id|traceId)$").unwrap()
    });
    if let Some(json) = answer.live.and_then(|live| live.json.as_ref()).and_then(Value::as_object) {
        let success = json.get("success") == Some(&Value::Bool(false));
        if success || json.get("ok") == Some(&Value::Bool(false)) {
            return Some(format!("\"{}\": false", if success { "success" } else { "ok" }));
        }
    }
    // The keys of a body that is only an error report; a record with an `error` field (an ad's delivery error) is not one.
    if let Some(shape) = answer.shape.as_object() {
        let error = shape.get("error").map_or("null", kind_of);
        if (error == "string" || error == "object") && shape.keys().all(|key| ERROR_BODY.is_match(key)) {
            return Some("an error".into());
        }
    }
    let own = own?;
    // A record with a `title` and a `type` is not a problem document: one carries its HTTP status as a number.
    let problem = || {
        let shape = answer.shape.as_object();
        let field = |key| shape.and_then(|shape| shape.get(key)).and_then(Value::as_str);
        answer.live.is_some_and(|live| live.content_type.contains("problem+json"))
            || (field("status") == Some("number") && field("title") == Some("string"))
    };
    let shaped = error_form(answer) == own && if own == "problem+json" { problem() } else { own.starts_with("{ error") };
    shaped.then(|| format!("a {own} error"))
}

/// A create (a POST to a collection) answered with another status than the API's creates.
fn creates(api: &Api, found: &mut Found) {
    static CREATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/[a-z][A-Za-z0-9_-]*s$").unwrap());
    let creates: Vec<(&Route, &Reply)> = api
        .routes
        .iter()
        .filter(|route| route.method == "POST" && CREATE.is_match(route.route))
        .filter_map(|route| route.ok().next().map(|answer| (route, answer)))
        // 202 says the work was queued, not done: a different answer, not another way of saying created.
        .filter(|(_, answer)| answer.status != 202)
        .collect();
    let Some(rule) = majority(creates.iter().map(|(_, answer)| answer.status)) else { return };
    for (route, answer) in creates.iter().filter(|(_, answer)| answer.status != rule.value) {
        let message = format!(
            "a create answers {}; {} of {} creates in this API answer {}: answer {}",
            answer.status, rule.agree, rule.total, rule.value, rule.value
        );
        found.add(route, "status", "/", answer.case_id, message);
    }
}

/// A 200 with an empty body where the API's routes answer with one.
fn empty_bodies(api: &Api, found: &mut Found) {
    let firsts = api.routes.iter().filter_map(|route| route.ok().next());
    let rule = majority(firsts.map(|answer| kind_of(&answer.shape) != "null" || answer.live.is_some_and(|live| !live.text.is_empty())));
    let Some(rule) = rule.filter(|rule| rule.value) else { return };
    for route in &api.routes {
        if let Some(empty) = route.ok().find(|answer| answer.status == 200 && answer.live.is_some_and(|live| live.text.is_empty())) {
            let message = format!(
                "answers 200 with an empty body; {} of {} routes answer with a body: answer 204, or the JSON the caller expects",
                rule.agree, rule.total
            );
            found.add(route, "status", "/", empty.case_id, message);
        }
    }
}

// ---- Values ----

static DATE_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z0-9](?:At|_at|Date|_date)$|^(?:date|timestamp)$").unwrap());

/// A string under a date key in a form that is not ISO 8601 (a locale or `Date.toString()` form).
fn locale_date(key: &str, value: &Value) -> bool {
    static ISO: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$")
            .unwrap()
    });
    value.as_str().is_some_and(|text| DATE_KEY.is_match(key) && !ISO.is_match(text) && date_parses(text))
}

/// Values in disguise in the live answers: a serialised `null`, `NaN` or `[object Object]`; float noise; booleans as
/// "true"/"false"; a date in a locale form.
fn values(api: &Api, found: &mut Found) {
    for route in &api.routes {
        // pointer -> its string values, and the first case
        let mut strings: Ordered<String, (Vec<&str>, &str)> = Ordered::default();
        for answer in route.ok() {
            for leaf in live_leaves(answer) {
                disguised(route, answer.case_id, &leaf, found);
                if let Value::String(text) = leaf.value {
                    let (seen, _) = strings.entry(leaf.pointer, || (vec![], answer.case_id));
                    if !seen.contains(&text.as_str()) {
                        seen.push(text.as_str());
                    }
                }
            }
        }
        for (pointer, (seen, case_id)) in
            strings.iter().filter(|(_, (seen, _))| seen.iter().all(|text| *text == "true" || *text == "false"))
        {
            found.add(route, "values", pointer, case_id, format!("{pointer} is the string \"{}\": answer a JSON boolean", seen[0]));
        }
    }
}

/// A leaf that is a value serialised by mistake, float noise or a locale date.
fn disguised(route: &Route, case_id: &str, leaf: &Leaf, found: &mut Found) {
    const NONSENSE: [&str; 7] = ["null", "undefined", "NaN", "Infinity", "-Infinity", "[object Object]", "Invalid Date"];
    static FLOAT_NOISE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[0-9]*?(?:0{6,}|9{6,})[0-9]{1,3}$").unwrap());
    let pointer = &leaf.pointer;
    match leaf.value {
        Value::String(text) if NONSENSE.contains(&text.as_str()) => {
            let message = format!("{pointer} is the string \"{text}\": a value was serialised by mistake; answer null or the real value");
            found.add(route, "values", pointer, case_id, message);
        }
        Value::Number(n) if FLOAT_NOISE.is_match(&js_number(n)) => {
            let message = format!("{pointer} carries binary float noise: round it before answering, and send money as integer minor units");
            found.add(route, "values", pointer, case_id, message);
        }
        _ => {}
    }
    if locale_date(leaf.key, leaf.value) {
        let message = format!("{pointer} is a date in a locale form: answer an ISO 8601 string (2026-01-31T09:30:00Z)");
        found.add(route, "values", pointer, case_id, message);
    }
}

/// One field that is null in some answers and missing in others, a list that is null in some and an array in others,
/// or a string that is "" in some and null in others: the caller has to handle every form.
fn absence(api: &Api, found: &mut Found) {
    for route in &api.routes {
        absence_of_route(route, found);
    }
}

/// A field's forms across answers (each with its first case), and the pointer of its object.
type Forms<'a> = (Ordered<String, &'a str>, String);

fn absence_of_route(route: &Route, found: &mut Found) {
    let mut fields: Ordered<String, Forms> = Ordered::default();
    // object pointer -> instances, and how many hold each key
    let mut objects: HashMap<String, (usize, HashMap<String, usize>)> = HashMap::new();
    let mut note = |pointer: String, form: &str, case_id| {
        let parent = pointer.rfind('/').map_or("", |at| &pointer[..at]).to_string();
        let (forms, _) = fields.entry(pointer, || (Ordered::default(), parent));
        if !forms.contains(form) {
            forms.set(form.to_string(), case_id);
        }
    };
    for answer in route.ok() {
        let mut instances = vec![];
        objects_of(&answer.shape, String::new(), &mut instances);
        for (pointer, object) in instances {
            let (count, keys) = objects.entry(pointer.clone()).or_default();
            *count += 1;
            for (key, value) in object {
                *keys.entry(key.clone()).or_default() += 1;
                note(format!("{pointer}/{key}"), kind_of(value), answer.case_id);
            }
        }
        for leaf in live_leaves(answer).into_iter().filter(|leaf| leaf.value.as_str() == Some("")) {
            note(leaf.pointer, "empty", answer.case_id);
        }
    }
    for (pointer, (forms, parent)) in fields.iter() {
        let Some(null_case) = forms.get("null") else { continue };
        let key = pointer.get(parent.len() + 1..).unwrap_or("");
        let missing = objects.get(parent).is_some_and(|(count, keys)| keys.get(key).copied().unwrap_or(0) < *count);
        let form = if missing {
            "missing in others"
        } else if forms.contains("array") {
            "a list in others"
        } else if forms.contains("empty") {
            "\"\" in others"
        } else {
            continue;
        };
        let list = if forms.contains("array") { " ([])" } else { "" };
        let message = format!("{pointer} is null in some answers and {form}: answer one form when it is empty{list}");
        found.add(route, "values", pointer, null_case, message);
    }
}

// ---- Exposure and size ----

static AUTH_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:auth|oauth[0-9]?|login|signin|sign-in|signup|sign-up|register|sessions?|tokens?|refresh|api-?keys)(?:/|$)")
        .unwrap()
});

/// What a response key exposes that should not leave the server, if anything.
fn exposed(route: &Route, key: &str, siblings: &Map<String, Value>) -> Option<&'static str> {
    static PASSWORD_KEY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:password|passwd|passwordhash|passworddigest|hashedpassword|encryptedpassword|salt|passwordsalt|totpsecret|mfasecret|otpsecret|resettoken|passwordresettoken)$").unwrap()
    });
    // Shown once by the write that creates or rotates them (an OAuth client's secret, a Stripe client secret, a
    // sign-in's token); a read that answers them again is the leak.
    static CREDENTIAL_KEY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^(?:clientsecret|apisecret|privatekey|secretkey|accesstoken|refreshtoken|sessiontoken|idtoken|authtoken|apikey|bearertoken)$",
        )
        .unwrap()
    });
    let name = key.to_lowercase().replace(['-', '_'], "");
    if PASSWORD_KEY.is_match(&name) {
        return Some("a password, hash or reset secret: never send it; drop it from the response");
    }
    if CREDENTIAL_KEY.is_match(&name) && route.method == "GET" && !AUTH_ROUTE.is_match(route.route) {
        return Some("a credential, on a read: answer it only once, from the write that creates it");
    }
    match key {
        "__v" => Some("Mongoose's version key: drop it from the response (select or toJSON)"),
        "_id" if siblings.contains_key("id") => Some("the database _id beside id: answer id only"),
        _ => None,
    }
}

/// Things that should not leave the server: secret-named keys, ORM artefacts, a soft-delete column to signed-out
/// callers; in the live answers, the request's own credentials echoed back, and a stack trace, file path or SQL in an
/// error.
fn exposure(api: &Api, found: &mut Found) {
    static DELETED_AT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^deleted_?at$").unwrap());
    for route in &api.routes {
        let anonymous = route.cases.iter().all(|item| item.actor == "anonymous");
        for answer in &route.answers {
            for field in fields_of(&answer.shape).into_iter().filter(|field| field.shape.as_str() != Some("null")) {
                let soft_delete = (anonymous && DELETED_AT.is_match(field.key))
                    .then_some("a soft-delete column, to signed-out callers: drop it from the response");
                if let Some(what) = exposed(route, field.key, field.siblings).or(soft_delete) {
                    found.add(route, "exposure", &field.pointer, answer.case_id, format!("answers {}, {what}", field.pointer));
                }
            }
        }
        for answer in &route.answers {
            leaks(route, answer, found);
        }
    }
}

/// A live answer that echoes the request's credentials, and an error answer that carries server internals.
fn leaks(route: &Route, answer: &Reply, found: &mut Found) {
    static LEAKS: LazyLock<[(&str, Regex); 3]> = LazyLock::new(|| {
        [
            (
                "a stack trace",
                Regex::new(r"(?:\\n|\n)\s*at [A-Za-z0-9_$.<>\[\] ]+ \(|(?-u:\b)at (?:async )?[A-Za-z0-9_$.<>]+ \((?:file://)?/[^)]*:[0-9]+:[0-9]+\)|Traceback \(most recent call last\)").unwrap(),
            ),
            (
                "a server file path",
                Regex::new(r"/(?:home|Users|var|srv|app|opt|usr)/[A-Za-z0-9_.@-]+/[A-Za-z0-9_./@-]*\.(?:[cm]?[jt]sx?|py|rb|go|java|php)(?-u:\b)|node_modules/").unwrap(),
            ),
            (
                "an SQL fragment",
                Regex::new(r#"(?-u:\b)SELECT\s[\s\S]{1,200}?\sFROM\s|(?-u:\b)INSERT\s+INTO\s|(?-u:\b)DELETE\s+FROM\s|syntax error at or near|violates (?:unique|foreign key|not-null) constraint|relation "[^"]+" does not exist|SQLITE_[A-Z]+"#).unwrap(),
            ),
        ]
    });
    // A sign-in or refresh route may hand back a token it issued; elsewhere an echoed credential is a leak.
    if answer.live.is_some_and(|live| !AUTH_ROUTE.is_match(route.route) && echoes(live)) {
        let message = "the answer echoes the request's credentials: never send Authorization or cookie values back".to_string();
        found.add(route, "exposure", "/", answer.case_id, message);
    }
    let text = answer.live.map_or("", |live| live.text.as_str());
    if let Some((leak, _)) = LEAKS.iter().find(|(_, pattern)| answer.status >= 400 && pattern.is_match(text)) {
        let message = format!("the {} answer carries {leak}: log it on the server and answer a plain message", answer.status);
        found.add(route, "exposure", "/", answer.case_id, message);
    }
}

/// Whether a live answer's text holds a credential value the request sent (whole, or a cookie's or header's part).
fn echoes(live: &Live) -> bool {
    static PARTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r";\s*|\s+").unwrap());
    let parts = live.sent.iter().flat_map(|value| PARTS.split(value).map(|part| part.find('=').map_or(part, |at| &part[at + 1..])));
    live.sent
        .iter()
        .map(String::as_str)
        .chain(parts)
        .filter(|secret| secret.encode_utf16().count() >= 8)
        .any(|secret| live.text.contains(secret))
}

/// Every array of at least five objects in a JSON value, with its pointer.
fn rows_of<'v>(value: &'v Value, pointer: String, out: &mut Vec<(String, &'v Vec<Value>)>) {
    match value {
        Value::Array(items) => {
            if items.len() >= 5 && items.iter().all(Value::is_object) {
                out.push((pointer.clone(), items));
            }
            items.iter().for_each(|item| rows_of(item, format!("{pointer}/*"), out));
        }
        Value::Object(fields) => fields.iter().for_each(|(key, item)| rows_of(item, format!("{pointer}/{key}"), out)),
        _ => {}
    }
}

/// The same sizeable object repeated in every row of a live list answer.
fn repeated(api: &Api, found: &mut Found) {
    for route in &api.routes {
        for answer in route.ok() {
            let mut lists = vec![];
            if let Some(json) = answer.live.and_then(|live| live.json.as_ref()) {
                rows_of(json, String::new(), &mut lists);
            }
            for (pointer, rows) in lists {
                for key in same_in_every_row(rows) {
                    let message = format!(
                        "{pointer}/*/{key} is the same object in all {} rows: send it once beside the list, or only its id",
                        rows.len()
                    );
                    found.add(route, "size", &format!("{pointer}/*/{key}"), answer.case_id, message);
                }
            }
        }
    }
}

/// The keys of the first row holding an object of 100 characters or more that every row repeats exactly.
fn same_in_every_row(rows: &[Value]) -> Vec<&str> {
    let Some(first) = rows[0].as_object() else { return vec![] };
    first
        .iter()
        .filter(|(key, value)| {
            let text = json_text(value);
            value.is_object()
                && text.encode_utf16().count() >= 100
                && rows.iter().all(|row| row.get(key.as_str()).map(json_text).is_some_and(|other| other == text))
        })
        .map(|(key, _)| key.as_str())
        .collect()
}

// ---- Requests ----

/// Requests: one field sent under several spellings across cases, a GET with a body, an ID in the body that names
/// another record than the path.
fn requests(api: &Api, found: &mut Found) {
    for route in &api.routes {
        spellings(route, found);
        for item in &route.cases {
            if item.method == "GET" && item.body.is_some() {
                let message = "a GET arrives with a body, which proxies and caches drop: move it to the query string".to_string();
                found.add(route, "requests", "/", &item.case_id, message);
            }
            if let Some((key, param)) = path_id_clash(item, api) {
                let message = format!(
                    "request /{key} names another record than the path's :{param}: take the ID from the path and drop it from the body"
                );
                found.add(route, "requests", &format!("/{key}"), &item.case_id, message);
            }
        }
    }
}

/// One request field sent under two or more spellings across a route's cases.
fn spellings(route: &Route, found: &mut Found) {
    // parent and words -> spellings
    let mut spellings: HashMap<String, Vec<String>> = HashMap::new();
    for (case_id, shape) in shapes(route, Side::Request, false) {
        for field in fields_of(&shape) {
            let seen = spellings.entry(format!("{}\0{}", field.parent, restyle(field.key, Style::Kebab))).or_default();
            if !seen.iter().any(|key| key == field.key) {
                seen.push(field.key.to_string());
            }
            if seen.len() == 2 {
                let names = some(seen.iter().map(|key| format!("{}/{key}", field.parent)));
                let message = format!("request {names} arrive across cases: clients disagree on the name; accept one");
                found.add(route, "requests", &field.pointer, case_id, message);
            }
        }
    }
}

/// A top-level body key that repeats a path parameter (`noteId` for `/notes/:id`) with another ID: the key and the
/// parameter.
fn path_id_clash(item: &Evidence, api: &Api) -> Option<(String, String)> {
    let body = item.body.as_ref()?.as_object()?;
    let template: Vec<&str> = item.route.split('/').collect();
    let path: Vec<&str> = item.path.split('/').collect();
    let norm = |name: &str| name.to_lowercase().replace(['-', '_'], "");
    for (index, segment) in template.iter().enumerate() {
        let Some(param) = segment.strip_prefix(':') else { continue };
        if !api.is_id(path.get(index).copied().unwrap_or("")) {
            continue;
        }
        let mut names = vec![norm(param)];
        if param == "id" && index > 0 && !template[index - 1].is_empty() {
            names.push(norm(&format!("{}Id", singular(template[index - 1]))));
        }
        let key = body.iter().find(|(name, value)| names.contains(&norm(name)) && value.as_str().is_some_and(|id| api.is_id(id)));
        if let Some((key, _)) = key.filter(|(_, value)| value.as_str() != path.get(index).copied()) {
            return Some((key.clone(), param.to_string()));
        }
    }
    None
}

// ---- Route names ----

static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^v[0-9]+(?:\.[0-9]+)?$").unwrap());

fn segments<'a>(route: &Route<'a>) -> Vec<&'a str> {
    route.route.split('/').filter(|part| !part.is_empty()).collect()
}

/// The path up to its version segment, as written and with any version (`/api/v*`).
fn prefix(route: &Route) -> (String, String) {
    let parts = segments(route);
    match parts.iter().position(|part| VERSION.is_match(part)) {
        None => (String::new(), "no version prefix".into()),
        Some(at) => (format!("/{}", parts[..=at].join("/")), format!("/{}", [&parts[..at], &["v*"][..]].concat().join("/"))),
    }
}

/// A static path segment, and whether a parameter follows it (it names a collection).
struct Static<'a> {
    route: &'a Route<'a>,
    part: &'a str,
    collection: bool,
}

/// Route naming from the templates alone: a version prefix laid out unlike the rest, a path segment cased against the
/// API's style, a singular collection among plural ones, a CRUD verb in a resource-style API, and one collection's
/// parameter named two ways.
fn route_names(api: &Api, found: &mut Found) {
    static OPS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^/(?:api/)?(?:health|healthz|ready|readyz|livez|ping|metrics|webhooks?|\.well-known|docs|openapi|swagger)(?-u:\b)")
            .unwrap()
    });
    let routes: Vec<&Route> = api.routes.iter().filter(|route| !OPS.is_match(route.route)).collect();
    version_prefix(&routes, found);
    let statics: Vec<Static> = routes
        .iter()
        .flat_map(|&route| {
            let parts = segments(route);
            (0..parts.len()).map(move |i| Static {
                route,
                part: parts[i],
                collection: parts.get(i + 1).is_some_and(|next| next.starts_with(':')),
            })
        })
        .filter(|item| !item.part.starts_with(':') && !VERSION.is_match(item.part))
        .collect();
    path_style(&statics, found);
    singular_collections(&statics, found);
    verbs(&routes, found);
    param_names(&routes, found);
}

/// A version prefix laid out unlike the API's other routes.
fn version_prefix(routes: &[&Route], found: &mut Found) {
    let Some(version) = majority(js_map(routes.iter().map(|route| (route.route, prefix(route).1)))) else { return };
    let usual = routes
        .iter()
        .map(|route| prefix(route))
        .find(|(_, shape)| *shape == version.value)
        .map(|(written, _)| written)
        .filter(|w| !w.is_empty());
    for route in routes {
        let (own, shape) = prefix(route);
        if shape == version.value {
            continue;
        }
        let has = if own.is_empty() { "no version prefix".to_string() } else { format!("the prefix {own}") };
        let start = if version.value == "no version prefix" { "without one" } else { version.value.as_str() };
        let remedy = usual.as_ref().map_or("drop the prefix".to_string(), |usual| format!("move it under {usual}"));
        let message = format!("the path has {has}; {} of {} routes start {start}: {remedy}", version.agree, version.total);
        found.add(route, "routes", "", route.first_case(), message);
    }
}

/// Path segments cased against the API's style, each reported once.
fn path_style(statics: &[Static], found: &mut Found) {
    let styled: Vec<(&Static, Style)> = js_map(
        statics.iter().filter_map(|item| style_of(item.part).filter(|style| *style != Style::Word).map(|style| (item.part, (item, style)))),
    );
    let Some(rule) = majority(styled.iter().map(|(_, style)| *style)) else { return };
    for (item, style) in styled.iter().filter(|(_, style)| *style != rule.value) {
        let message = format!(
            "the path segment {} is {}; {} of {} multi-word path segments are {}: rename it {}",
            item.part,
            style_name(*style),
            rule.agree,
            rule.total,
            style_name(rule.value),
            restyle(item.part, rule.value)
        );
        found.add(item.route, "routes", "", item.route.first_case(), message);
    }
}

/// Only a singular whose plural the API also uses: `/user/:id` beside `/users`. Other singular segments are often
/// actions or kinds (`/invites/join/:account`), not collections.
fn singular_collections(statics: &[Static], found: &mut Found) {
    let names: HashSet<&str> = statics.iter().map(|item| item.part).collect();
    let collections: Vec<&Static> = js_map(statics.iter().filter(|item| item.collection).map(|item| (item.part, item)));
    let Some(many) = majority(collections.iter().map(|item| plural(item.part))).filter(|rule| rule.value) else { return };
    for item in collections.iter().filter(|item| !plural(item.part) && names.contains(plural_of(item.part).as_str())) {
        let plural = plural_of(item.part);
        let message = format!(
            "the collection /{} is singular, and the API also has /{plural}; {} of {} collections are plural: use /{plural}",
            item.part, many.agree, many.total
        );
        found.add(item.route, "routes", "", item.route.first_case(), message);
    }
}

/// The first path segment that starts with a CRUD verb; `add-ons` and `set-ups` are nouns.
fn verb_of<'a>(route: &Route<'a>) -> Option<&'a str> {
    static VERB: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:get|create|update|delete|fetch|list|add|remove|edit|save|retrieve|insert|modify|do|make)$").unwrap()
    });
    static PARTICLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:ons?|ups?|ins?|outs?)$").unwrap());
    segments(route).into_iter().find(|part| {
        let kebab = restyle(part, Style::Kebab);
        let (first, rest) = kebab.split_once('-').unwrap_or((&kebab, ""));
        VERB.is_match(first) && !PARTICLE.is_match(rest)
    })
}

/// A CRUD verb in the path where the API's routes name resources.
fn verbs(routes: &[&Route], found: &mut Found) {
    let resources = majority(js_map(routes.iter().map(|route| (route.route, verb_of(route).is_none()))));
    let Some(rule) = resources.filter(|rule| rule.value) else { return };
    for route in routes {
        let Some(verb) = verb_of(route) else { continue };
        let message = format!(
            "the path segment {verb} is a verb; {} of {} routes name resources and let the method say the action: use {} on the resource",
            rule.agree, rule.total, route.method
        );
        found.add(route, "routes", "", route.first_case(), message);
    }
}

/// One collection's parameter named two ways (`/users/:id` and `/users/:userId`), compared only between routes that
/// use it in the same position, since `/users/:id` beside `/users/:user_id/orders` is a convention of its own.
fn param_names(routes: &[&Route], found: &mut Found) {
    // Only ID parameters are compared: `:slug` beside `:id` addresses the record by another value, not another name.
    static ID_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^:(?:.*(?:id|Id|ID)|[a-z]id)$").unwrap());
    // prefix and position -> name -> routes
    let mut groups: Ordered<String, Ordered<&str, Vec<&Route>>> = Ordered::default();
    for &route in routes {
        let parts: Vec<&str> = route.route.split('/').collect();
        for (index, &part) in parts.iter().enumerate().filter(|(_, part)| ID_PARAM.is_match(part)) {
            let before: Vec<&str> = parts[..index].iter().map(|item| if item.starts_with(':') { ":" } else { item }).collect();
            let id = format!("{}\0{}", before.join("/"), index == parts.len() - 1);
            groups.entry(id, Ordered::default).entry(part, Vec::new).push(route);
        }
    }
    for (id, names) in groups.iter().filter(|(_, names)| names.len() >= 2) {
        let mut sorted: Vec<(&&str, &Vec<&Route>)> = names.iter().collect();
        sorted.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| js_cmp(a.0, b.0)));
        let (top, users) = sorted[0];
        let after = id.split('\0').next().unwrap_or("");
        let others = format!("{} other route{}", users.len(), if users.len() == 1 { "" } else { "s" });
        for (name, list) in &sorted[1..] {
            for route in list.iter() {
                let message = format!("the parameter after {after} is {name}; {others} there call it {top}: use {top}");
                found.add(route, "routes", "", route.first_case(), message);
            }
        }
    }
}

// ---- Date.parse ----
// Whether V8's Date.parse reads a string as a date: its ES5 ISO parser, then its legacy parser (dateparser-inl.h),
// which reads month names, AM/PM, time zone names and offsets, skips other words before the first number and anything
// in parentheses, and rejects only what it cannot place. A string "11/10/2026", "Jan 5" or "2026" is a date to it.

#[derive(Clone, Copy, PartialEq)]
enum Word {
    Month,
    AmPm,
    Zone,
    TimeSeparator,
    Other,
}

#[derive(Clone, Copy, PartialEq)]
enum Token {
    /// A numeral's value (at most nine significant digits) and length.
    Number(i64, usize),
    Symbol(char),
    /// A word's kind, value and length.
    Word(Word, i64, usize),
    Space,
    Unknown,
    End,
}

const KEYWORDS: [(&str, Word, i64); 27] = [
    ("jan", Word::Month, 1),
    ("feb", Word::Month, 2),
    ("mar", Word::Month, 3),
    ("apr", Word::Month, 4),
    ("may", Word::Month, 5),
    ("jun", Word::Month, 6),
    ("jul", Word::Month, 7),
    ("aug", Word::Month, 8),
    ("sep", Word::Month, 9),
    ("oct", Word::Month, 10),
    ("nov", Word::Month, 11),
    ("dec", Word::Month, 12),
    ("am", Word::AmPm, 0),
    ("pm", Word::AmPm, 12),
    ("ut", Word::Zone, 0),
    ("utc", Word::Zone, 0),
    ("z", Word::Zone, 0),
    ("gmt", Word::Zone, 0),
    ("cdt", Word::Zone, -5),
    ("cst", Word::Zone, -6),
    ("edt", Word::Zone, -4),
    ("est", Word::Zone, -5),
    ("mdt", Word::Zone, -6),
    ("mst", Word::Zone, -7),
    ("pdt", Word::Zone, -7),
    ("pst", Word::Zone, -8),
    ("t", Word::TimeSeparator, 0),
];

/// A word's kind by its first three characters; only a month name may be longer than its keyword.
fn keyword(prefix: [u32; 3], length: usize) -> (Word, i64) {
    let padded = |name: &str| {
        let mut out = [0u32; 3];
        name.chars().enumerate().for_each(|(i, c)| out[i] = c as u32);
        out
    };
    KEYWORDS
        .iter()
        .find(|(name, word, _)| padded(name) == prefix && (length <= 3 || *word == Word::Month))
        .map_or((Word::Other, 0), |(_, word, value)| (*word, *value))
}

fn date_tokens(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let (mut i, mut out) = (0, vec![]);
    while i < chars.len() {
        let (c, start) = (chars[i], i);
        let token = if c.is_ascii_digit() {
            let mut value = 0;
            while chars.get(i) == Some(&'0') {
                i += 1;
            }
            let digits = chars[i..].iter().take_while(|c| c.is_ascii_digit()).count();
            chars[i..i + digits].iter().take(9).for_each(|d| value = value * 10 + i64::from(d.to_digit(10).unwrap_or(0)));
            i += digits;
            Token::Number(value, i - start)
        } else if ":-+.)".contains(c) {
            i += 1;
            Token::Symbol(c)
        } else if c >= 'A' && !c.is_whitespace() {
            i += chars[i..].iter().take_while(|c| **c >= 'A' && !c.is_whitespace()).count();
            let mut prefix = [0u32; 3];
            chars[start..i].iter().take(3).enumerate().for_each(|(at, c)| prefix[at] = *c as u32 | 0x20);
            let length = chars[start..i].iter().map(|c| c.len_utf16()).sum();
            let (word, value) = keyword(prefix, length);
            Token::Word(word, value, length)
        } else if c.is_whitespace() {
            i += chars[i..].iter().take_while(|c| c.is_whitespace()).count();
            Token::Space
        } else {
            i += if c == '(' { parenthesized(&chars[i..]) } else { 1 };
            Token::Unknown
        };
        out.push(token);
    }
    out.push(Token::End);
    out
}

/// The length of a parenthesised comment, nested ones included (to the end when it is not closed).
fn parenthesized(chars: &[char]) -> usize {
    let (mut balance, mut i) = (0, 0);
    loop {
        match chars[i] {
            ')' => balance -= 1,
            '(' => balance += 1,
            _ => {}
        }
        i += 1;
        if balance <= 0 || i >= chars.len() {
            return i;
        }
    }
}

fn within(n: i64, low: i64, high: i64) -> bool {
    (low..=high).contains(&n)
}

#[derive(Default)]
struct Zone {
    sign: Option<i64>,
    hour: Option<i64>,
    minute: Option<i64>,
}

impl Zone {
    fn set(&mut self, offset_hours: i64) {
        self.sign = Some(if offset_hours < 0 { -1 } else { 1 });
        self.hour = Some(offset_hours.abs());
        self.minute = Some(0);
    }

    fn is_expecting(&self, n: i64) -> bool {
        self.hour.is_some() && self.minute.is_none() && within(n, 0, 59)
    }

    fn is_utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }
}

/// V8's date parser state: the date's numbers and named month, the time's parts, the zone.
#[derive(Default)]
struct DateParser {
    tokens: Vec<Token>,
    at: usize,
    day: Vec<i64>,
    month: Option<i64>,
    iso: bool,
    time: Vec<i64>,
    hour_offset: Option<i64>,
    zone: Zone,
}

fn date_parses(text: &str) -> bool {
    let mut parser = DateParser { tokens: date_tokens(text), ..DateParser::default() };
    parser.es5().is_some_and(|first| parser.legacy(first).is_some() && parser.finish().is_some())
}

impl DateParser {
    fn peek(&self) -> Token {
        self.tokens[self.at]
    }

    fn next(&mut self) -> Token {
        let token = self.tokens[self.at];
        self.at = (self.at + 1).min(self.tokens.len() - 1);
        token
    }

    fn skip(&mut self, symbol: char) -> bool {
        let found = self.peek() == Token::Symbol(symbol);
        if found {
            self.next();
        }
        found
    }

    /// The next token's value when it is a numeral of exactly `length` digits within a range.
    fn fixed(&self, length: usize, low: i64, high: i64) -> Option<i64> {
        match self.peek() {
            Token::Number(n, l) if l == length && within(n, low, high) => Some(n),
            _ => None,
        }
    }

    /// The ES5 form `[+-yy]yyyy[-MM[-DD]][THH:mm[:ss[.sss]][Z|+hh:mm]]`. None: not a date. Otherwise the token the
    /// legacy parser starts from (End when the whole string was read).
    fn es5(&mut self) -> Option<Token> {
        let year = match self.peek() {
            Token::Symbol(sign @ ('+' | '-')) => {
                let token = self.next();
                let Some(year) = self.fixed(6, 0, i64::MAX) else { return Some(token) };
                self.next();
                if sign == '-' && year == 0 {
                    return Some(token);
                }
                if sign == '-' {
                    -year
                } else {
                    year
                }
            }
            _ => {
                let Some(year) = self.fixed(4, 0, i64::MAX) else { return Some(self.next()) };
                self.next();
                year
            }
        };
        self.day.push(year);
        for (low, high) in [(1, 12), (1, 31)] {
            if !self.skip('-') {
                break;
            }
            let Some(n) = self.fixed(2, low, high) else { return Some(self.next()) };
            self.next();
            self.day.push(n);
        }
        if !matches!(self.peek(), Token::Word(Word::TimeSeparator, _, _)) {
            if self.peek() != Token::End {
                return Some(self.next());
            }
        } else {
            self.next();
            self.es5_time()?;
        }
        if self.zone.hour.is_none() && self.time.is_empty() {
            self.zone.set(0);
        }
        self.iso = true;
        Some(Token::End)
    }

    /// `HH:mm[:ss[.sss]][Z|+hh:mm|+hhmm]` to the end, after the T.
    fn es5_time(&mut self) -> Option<()> {
        let hour = self.fixed(2, 0, 24)?;
        let top = if hour == 24 { 0 } else { 59 };
        self.next();
        self.time.push(hour);
        let minute = if self.skip(':') { self.fixed(2, 0, top) } else { None }?;
        self.next();
        self.time.push(minute);
        if self.skip(':') {
            let second = self.fixed(2, 0, top)?;
            self.next();
            self.time.push(second);
            if self.skip('.') {
                let Token::Number(ms, _) = self.peek() else { return None };
                if hour == 24 && ms > 0 {
                    return None;
                }
                self.next();
                self.time.push(0);
            }
        }
        self.es5_zone()?;
        (self.peek() == Token::End).then_some(())
    }

    fn es5_zone(&mut self) -> Option<()> {
        match self.peek() {
            Token::Word(Word::Zone, 0, 1) => {
                self.next();
                self.zone.set(0);
            }
            Token::Symbol(sign @ ('+' | '-')) => {
                self.next();
                self.zone.sign = Some(if sign == '+' { 1 } else { -1 });
                if let Token::Number(both, 4) = self.peek() {
                    self.next();
                    (within(both / 100, 0, 23) && within(both % 100, 0, 59)).then_some(())?;
                    (self.zone.hour, self.zone.minute) = (Some(both / 100), Some(both % 100));
                } else {
                    self.zone.hour = Some(self.fixed(2, 0, 23)?);
                    self.next();
                    self.skip(':').then_some(())?;
                    self.zone.minute = Some(self.fixed(2, 0, 59)?);
                    self.next();
                }
            }
            _ => {}
        }
        Some(())
    }

    /// The legacy parser, from `token` to the end. None: not a date.
    fn legacy(&mut self, mut token: Token) -> Option<()> {
        let mut has_number = !self.day.is_empty();
        while token != Token::End {
            match token {
                Token::Number(n, _) => {
                    has_number = true;
                    self.legacy_number(n)?;
                }
                Token::Word(word, value, _) => self.legacy_word(word, value, has_number)?,
                Token::Symbol(sign @ ('+' | '-')) if self.zone.is_utc() || !self.time.is_empty() => {
                    has_number = true;
                    self.legacy_offset(sign)?;
                }
                Token::Symbol('+' | '-' | ')') if has_number => return None,
                _ => {}
            }
            token = self.next();
        }
        Some(())
    }

    fn time_add(&mut self, n: i64) -> bool {
        let room = self.time.len() < 4;
        if room {
            self.time.push(n);
        }
        room
    }

    fn time_add_final(&mut self, n: i64) {
        if self.time_add(n) {
            self.time.resize(4, 0);
        }
    }

    fn time_expecting(&self, n: i64) -> bool {
        match self.time.len() {
            1 | 2 => within(n, 0, 59),
            3 => within(n, 0, 999),
            _ => false,
        }
    }

    fn legacy_number(&mut self, n: i64) -> Option<()> {
        if self.skip(':') {
            if self.skip(':') {
                self.time.is_empty().then_some(())?;
                self.time.extend([n, 0]);
            } else {
                self.time_add(n).then_some(())?;
                self.skip('.');
            }
        } else if self.skip('.') && self.time_expecting(n) {
            self.time_add(n);
            let Token::Number(..) = self.next() else { return None };
            self.time_add_final(0);
        } else if self.zone.is_expecting(n) {
            self.zone.minute = Some(n);
        } else if self.time_expecting(n) {
            self.time_add_final(n);
            let ends = matches!(self.peek(), Token::End | Token::Space | Token::Word(Word::Zone, 0, 1) | Token::Symbol('+' | '-'));
            ends.then_some(())?;
        } else {
            (self.day.len() < 3).then_some(())?;
            self.day.push(n);
            self.skip('-');
        }
        Some(())
    }

    fn legacy_word(&mut self, word: Word, value: i64, has_number: bool) -> Option<()> {
        match word {
            Word::AmPm if !self.time.is_empty() => self.hour_offset = Some(value),
            Word::Month => {
                self.month = Some(value);
                self.skip('-');
            }
            Word::Zone if has_number => self.zone.set(value),
            // Other words may only come before the first number, and apart from it.
            _ => (!has_number && !matches!(self.peek(), Token::Number(..))).then_some(())?,
        }
        Some(())
    }

    /// A UTC offset after a time or UTC: `+1`, `+0100`, `+01:00`.
    fn legacy_offset(&mut self, sign: char) -> Option<()> {
        self.zone.sign = Some(if sign == '-' { -1 } else { 1 });
        let (n, length) = match self.peek() {
            Token::Number(n, length) => {
                self.next();
                (n, length)
            }
            _ => (0, 0),
        };
        (self.zone.hour, self.zone.minute) = match length {
            _ if self.peek() == Token::Symbol(':') => (Some(n), None),
            1 | 2 => (Some(n), Some(0)),
            3 | 4 => (Some(n / 100), Some(n % 100)),
            _ => return None,
        };
        Some(())
    }

    /// Whether the parts make a valid date within JavaScript's time range.
    fn finish(&self) -> Option<()> {
        let (year, month, day) = self.date()?;
        let (hour, minute, second) = self.clock()?;
        // ponytail: a date without a zone is read as UTC, not local time, so a date within a day of the range's ends may
        // be judged wrongly; pass the local offset if that ever matters.
        let offset = self.zone.sign.map_or(0, |sign| sign * (self.zone.hour.unwrap_or(0) * 60 + self.zone.minute.unwrap_or(0)));
        let days = days_from_civil(year, month) + day - 1;
        let ms = (days * 86_400 + hour * 3_600 + minute * 60 + second - offset * 60) * 1_000;
        (ms.abs() <= 8_640_000_000_000_000).then_some(())
    }

    /// The year, month and day, by V8's rules for which number is which.
    fn date(&self) -> Option<(i64, i64, i64)> {
        let mut comp = self.day.clone();
        if comp.is_empty() {
            return None;
        }
        comp.resize(3, 1);
        let is_day = |n| within(n, 1, 31);
        let (mut year, month, day) = match self.month {
            None if self.iso || !is_day(comp[0]) => (comp[0], comp[1], comp[2]),
            None => (comp[2], comp[0], comp[1]),
            Some(month) if !is_day(comp[0]) => (comp[0], month, comp[1]),
            Some(month) => (comp[1], month, comp[0]),
        };
        if !self.iso && within(year, 0, 99) {
            year += if year < 50 { 2000 } else { 1900 };
        }
        (within(month, 1, 12) && is_day(day)).then_some((year, month, day))
    }

    fn clock(&self) -> Option<(i64, i64, i64)> {
        let mut comp = self.time.clone();
        comp.resize(4, 0);
        let (mut hour, minute, second, ms) = (comp[0], comp[1], comp[2], comp[3]);
        if let Some(offset) = self.hour_offset {
            within(hour, 0, 12).then_some(())?;
            hour = hour % 12 + offset;
        }
        let valid = within(hour, 0, 23) && within(minute, 0, 59) && within(second, 0, 59) && within(ms, 0, 999);
        (valid || (hour == 24 && minute == 0 && second == 0 && ms == 0)).then_some((hour, minute, second))
    }
}

/// Days from 1970-01-01 to the first of a month (any year, proleptic Gregorian).
fn days_from_civil(year: i64, month: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5;
    era * 146_097 + of_era * 365 + of_era / 4 - of_era / 100 + day_of_year - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_parse_reads_what_v8_reads() {
        // Each checked against `Date.parse` in Node.
        let dates = [
            "11/10/2026",
            "Jan 5",
            "Jan 5, 2026",
            "Tue Nov 10 2026 09:30:00 GMT+0000 (Coordinated Universal Time)",
            "2026",
            "2026-01",
            "2026/01/31",
            "12",
            "Mon, 05 Jan 2026 10:00:00 GMT",
            "5 January 2026",
            "January 2026",
            "abc 2020",
            "11.10.2026",
            "+002026-01-31",
            "yesterday at 5",
            "0",
            "-1",
            "2026-1-5",
            "Sat 2026",
            "(hi) 2026",
            "2026 GMT-0800",
            "2026-01-31T10:00Z",
            "2026T10:00",
            "3.5",
            "july 4 1776",
            "4 jul",
            "sept 9 99",
            "2026-01-31 10:00:00 +0100",
        ];
        let not = [
            "pending",
            "N/A",
            "1 week",
            "tomorrow",
            "31/12/2026",
            "2026-13-01",
            "10:30",
            "10:30 PM",
            "13:00 PM",
            "x1",
            "2020 abc",
            "2026-01-31T25:00",
            "1/1/999999",
            "Z",
            "12:00:00.123456",
            "2026)",
            "GMT+1 2026",
            "1e5",
            "1 2 3 4",
            "T10",
        ];
        for text in dates {
            assert!(date_parses(text), "{text} is a date");
        }
        for text in not {
            assert!(!date_parses(text), "{text} is not a date");
        }
    }

    #[test]
    fn shapes_and_names_follow_javascript() {
        let shape = shape_of(Some(&serde_json::json!({ "b": [1, "x", 2], "10": null, "a": { "2": true, "1": [] } })));
        assert_eq!(json_text(&shape), r#"{"10":"null","a":{"1":[],"2":"boolean"},"b":["number","string"]}"#);
        assert_eq!(restyle("userHTTPCard_id", Style::Kebab), "user-http-card-id");
        assert!(plural("userProfiles") && plural("data") && !plural("status") && !plural("access"));
        assert_eq!([plural_of("category"), plural_of("box"), singular("boxes"), singular("notes")], ["categories", "boxes", "box", "note"]);
        assert_eq!(js_number(&Number::from_f64(0.30000000000000004).unwrap()), "0.30000000000000004");
        assert_eq!(js_number(&Number::from_f64(1.2e-7).unwrap()), "1.2e-7");
    }
}
