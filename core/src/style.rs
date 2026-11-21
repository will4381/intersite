//! The style-drift check: an added styling value that is almost, but not exactly, one the project already has (a
//! colour a hair off an existing one, a size a pixel off the scale), a literal equal to a token's value, a value off a
//! scale the project keeps closed, or a new token that duplicates an existing one. Values are read from CSS, style
//! objects, Tailwind classes and SwiftUI modifiers; tokens from CSS custom properties, SCSS variables and theme modules.

use fancy_regex::Regex as Fancy;
use rayon::prelude::*;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::{Answer, Finding, Request};

static HEX: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?<![\w&#$-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])").unwrap());
static FUNC: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?<![\w-])(?:rgba?|hsla?)\(\s*[\d.]+(?:deg)?%?\s*[,\s]\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)").unwrap());
static CSS_PROPS: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?<![\w-])(font-size|font-weight|line-height|letter-spacing|border(?:-[a-z]+)*-radius|padding(?:-[a-z]+)*|margin(?:-[a-z]+)*|gap|row-gap|column-gap|z-index|transition-duration|animation-duration)\s*:\s*([^;{}]+)").unwrap());
static JS_PROPS: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r#"(?<![\w$])(fontSize|fontWeight|lineHeight|letterSpacing|border\w*Radius|padding\w*|margin\w*|gap|rowGap|columnGap|zIndex)\s*:\s*(?:(['"`])([^'"`\n]+)\2|(-?[\d.]+)(?![\w.(]))"#).unwrap());
static TW_ARBITRARY: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?<![\w-])(text|leading|tracking|font|rounded(?:-[a-z]{1,2})?|p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|z|duration|bg|border(?:-[xytrbl])?|ring|fill|stroke|outline|from|via|to|decoration|caret|accent)-\[([^\]\s]+)\]").unwrap());
static SWIFT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.font\(\.system\(size:\s*([\d.]+)|\.padding\((?:\.[a-zA-Z]+,\s*)?([\d.]+)\)|cornerRadius(?::\s*|\()([\d.]+)").unwrap());
static CUSTOM_PROP: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?<![\w-])(--[\w-]+|\$[\w-]+)\s*:\s*([^;{}]+)").unwrap());
static THEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|/)(?:tailwind\.config\.[cm]?[jt]s|[\w-]*(?:tokens?|theme|colou?rs|palette)[\w-]*\.[cm]?[jt]s)$").unwrap());
static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:[jt]sx|vue|svelte|astro|html)$").unwrap());
static TOKEN_FILES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:css|scss|sass|less|[jt]sx|vue|svelte|astro|html)$").unwrap());
static SHARED_PKG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:|packages/[^/]+|shared|libs?/[^/]+|design-system|ui)$").unwrap());
static VAR_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"var\((--[\w-]+)").unwrap());
static TW_REF: LazyLock<Fancy> = LazyLock::new(|| Fancy::new(r"(?<![\w-])(?:bg|text|border|fill|stroke|ring|outline|from|via|to|decoration|divide|caret|accent|shadow)-([a-z][\w-]*)").unwrap());

const MAX_BYTES: u64 = 512 * 1024;
/** OKLab distance under which two colours read as the same: about the just-noticeable difference. */
const NEAR_COLOUR: f64 = 0.02;
/// A near miss must also be within this share of the value it misses, so 2.5px is not "nearly 2px".
const NEAR_SHARE: f64 = 0.15;
/// Uses an existing value needs before a new one is called a near miss of it.
const POPULAR: usize = 5;
/// References a numeric token needs before a literal with its value is sent to it: 400 or 1.2 match tokens by chance.
const NUMBER_TOKEN_REFS: usize = 10;

/// How far a number may sit from an existing one and still be a near miss, per category and unit.
fn near(cat: &str, unit: &str) -> Option<f64> {
    match (cat, unit) {
        ("font size" | "radius" | "spacing", "px") => Some(1.0),
        ("line height", "px") => Some(1.0),
        ("line height", "") => Some(0.05),
        ("letter spacing", "em") => Some(0.005),
        ("letter spacing", "px") => Some(0.25),
        _ => None,
    }
}

#[derive(Clone, Debug)]
struct Value {
    cat: &'static str,
    key: String,
    raw: String,
    num: Option<f64>,
    unit: String,
    rgba: Option<[f64; 4]>,
    token: Option<String>,
}

#[derive(Clone, Debug)]
struct Seen {
    v: Value,
    file: String,
    line: u32,
    pkg: String,
}

fn num_text(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { format!("{n}") }
}

fn hex2(n: f64) -> String {
    format!("{:02x}", n.clamp(0.0, 255.0).round() as u32)
}

/// A colour literal as `#rrggbb` (or `#rrggbbaa` when not opaque) and its channels.
pub fn parse_colour(raw: &str) -> Option<(String, [f64; 4])> {
    let (r, g, b, mut a);
    a = 1.0;
    if let Some(h) = raw.strip_prefix('#') {
        let h: String = if raw.len() <= 5 { h.chars().flat_map(|c| [c, c]).collect() } else { h.to_string() };
        let p = |i: usize| u32::from_str_radix(h.get(i..i + 2)?, 16).ok().map(f64::from);
        (r, g, b) = (p(0)?, p(2)?, p(4)?);
        if h.len() == 8 {
            a = p(6)? / 255.0;
        }
    } else {
        static NUMS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\d.]+%?").unwrap());
        let nums: Vec<&str> = NUMS.find_iter(raw).map(|m| m.as_str()).collect();
        // A function colour built from variables (`hsl(var(--ring))`) has no channels to read, so it is not a literal.
        if nums.len() < 3 {
            return None;
        }
        let pf = |s: &str| s.trim_end_matches('%').parse::<f64>().unwrap_or(f64::NAN);
        let val = |s: &str, max: f64| if s.ends_with('%') { pf(s) / 100.0 * max } else { pf(s) };
        if raw.starts_with("hsl") {
            let s = val(nums[1], 1.0) * if nums[1].ends_with('%') { 1.0 } else { 0.01 };
            let l = val(nums[2], 1.0) * if nums[2].ends_with('%') { 1.0 } else { 0.01 };
            [r, g, b] = hsl_to_rgb(pf(nums[0]), s, l);
        } else {
            (r, g, b) = (val(nums[0], 255.0), val(nums[1], 255.0), val(nums[2], 255.0));
        }
        if let Some(x) = nums.get(3) {
            a = val(x, 1.0);
        }
    }
    if [r, g, b, a].iter().any(|n| !n.is_finite()) {
        return None;
    }
    let alpha = if a >= 0.999 { String::new() } else { hex2(a * 255.0) };
    Some((format!("#{}{}{}{alpha}", hex2(r), hex2(g), hex2(b)), [r, g, b, a]))
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [f64; 3] {
    let k = |n: f64| (n + h / 30.0) % 12.0;
    let f = |n: f64| l - s * l.min(1.0 - l) * (-1f64).max((k(n) - 3.0).min(9.0 - k(n)).min(1.0));
    [f(0.0) * 255.0, f(8.0) * 255.0, f(4.0) * 255.0]
}

/// Perceptual distance between two colours in OKLab, where about 0.02 is just noticeable.
fn colour_distance(x: &[f64; 4], y: &[f64; 4]) -> f64 {
    if (x[3] - y[3]).abs() > 0.02 {
        return f64::INFINITY;
    }
    let (a, b) = (oklab(x), oklab(y));
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn oklab(c: &[f64; 4]) -> [f64; 3] {
    let lin = |c: f64| {
        let c = c / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (lin(c[0]), lin(c[1]), lin(c[2]));
    let l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b).cbrt();
    let m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b).cbrt();
    let s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b).cbrt();
    [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

fn is_neutral(key: &str) -> bool {
    key.starts_with("#000000") || key.starts_with("#ffffff")
}

/// A length, number or duration: rem becomes px (at 16px), s becomes ms, a bare number keeps no unit.
fn parse_number(raw: &str) -> Option<(f64, String)> {
    static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|ms|s|pt)?$").unwrap());
    let m = NUMBER.captures(raw.trim())?;
    let mut num: f64 = m[1].parse().ok()?;
    let mut unit = m.get(2).map_or("", |u| u.as_str()).to_string();
    if unit == "rem" {
        num *= 16.0;
        unit = "px".into();
    }
    if unit == "s" {
        num *= 1000.0;
        unit = "ms".into();
    }
    if unit == "pt" {
        unit = "px".into();
    }
    Some(((num * 1000.0).round() / 1000.0, unit))
}

fn category_of(prop: &str) -> Option<&'static str> {
    let mut p = String::new();
    for c in prop.chars() {
        if c.is_ascii_uppercase() {
            p.push('-');
            p.push(c.to_ascii_lowercase());
        } else {
            p.push(c);
        }
    }
    match p.as_str() {
        "font-size" => return Some("font size"),
        "font-weight" => return Some("font weight"),
        "line-height" => return Some("line height"),
        "letter-spacing" => return Some("letter spacing"),
        "z-index" => return Some("z-index"),
        _ => {}
    }
    if p.ends_with("radius") {
        Some("radius")
    } else if ["padding", "margin", "gap", "row-gap", "column-gap"].iter().any(|x| p.starts_with(x)) {
        Some("spacing")
    } else if p.ends_with("duration") {
        Some("duration")
    } else {
        None
    }
}

fn token_category(name: &str) -> Option<&'static str> {
    static FS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"font-size|^--text-|^\$text-|-fs-|^--fs-").unwrap());
    static Z: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"z-?index|^--z-").unwrap());
    if name.contains("radius") || name.contains("rounded") {
        Some("radius")
    } else if FS.is_match(name) {
        Some("font size")
    } else if name.contains("weight") {
        Some("font weight")
    } else if name.contains("leading") || name.contains("line-height") {
        Some("line height")
    } else if name.contains("tracking") || name.contains("letter-spacing") {
        Some("letter spacing")
    } else if ["spacing", "space", "gap", "gutter"].iter().any(|x| name.contains(x)) {
        Some("spacing")
    } else if Z.is_match(name) {
        Some("z-index")
    } else if name.contains("duration") {
        Some("duration")
    } else {
        None
    }
}

fn tw_category(prefix: &str) -> Option<&'static str> {
    Some(match prefix {
        "text" => "font size",
        "leading" => "line height",
        "tracking" => "letter spacing",
        "font" => "font weight",
        "z" => "z-index",
        "duration" => "duration",
        _ if prefix.starts_with("rounded") => "radius",
        _ if ["p", "m", "gap", "space"].iter().any(|x| prefix.starts_with(x)) => "spacing",
        _ => return None,
    })
}

/// Numeric values of one property declaration: `padding: 4px 8px` gives two. Zero, `auto` and expressions are skipped.
fn numbers(cat: &'static str, text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    if text.contains("var(") || text.contains("calc(") || text.contains('$') || text.contains('{') {
        return out;
    }
    for part in text.split_whitespace() {
        let Some((num, unit)) = parse_number(part) else { continue };
        // Negative margins and offsets are positioning, not spacing; a weight pair (`100 900`) is a font-face range.
        if num == 0.0 || (num < 0.0 && cat == "spacing") || (cat == "font weight" && text.trim().contains(' ')) {
            continue;
        }
        // A bare number is pixels in a style object, but a ratio for line height and a step for weight or z-index.
        let unit = if unit.is_empty() && matches!(cat, "font size" | "radius" | "spacing") { "px".to_string() } else { unit };
        out.push(Value { cat, key: format!("{}{unit}", num_text(num)), raw: part.to_string(), num: Some(num), unit, rgba: None, token: None });
    }
    out
}

fn fancy_all<'t>(re: &Fancy, text: &'t str) -> Vec<fancy_regex::Captures<'t>> {
    re.captures_iter(text).filter_map(|c| c.ok()).collect()
}

/// Every colour literal in a stretch of text.
fn colours(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for c in fancy_all(&HEX, text).into_iter().chain(fancy_all(&FUNC, text)) {
        let raw = c.get(0).unwrap().as_str();
        if let Some((key, rgba)) = parse_colour(raw) {
            out.push(Value { cat: "colour", key, raw: raw.to_string(), num: None, unit: String::new(), rgba: Some(rgba), token: None });
        }
    }
    out
}

/// A token definition on this line (`--color-ink: #333;`, `$space-2: 8px;`).
fn tokens(line: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for c in fancy_all(&CUSTOM_PROP, line) {
        let name = c.get(1).unwrap().as_str().to_string();
        let v = c.get(2).unwrap().as_str().trim();
        let colour = colours(v);
        if colour.len() == 1 && colour[0].raw.len() == v.len() {
            out.push(Value { token: Some(name.clone()), ..colour[0].clone() });
        }
        if let (Some(cat), Some((num, unit))) = (token_category(&name), parse_number(v)) {
            if num != 0.0 {
                out.push(Value { cat, key: format!("{}{unit}", num_text(num)), raw: v.to_string(), num: Some(num), unit, rgba: None, token: Some(name.clone()) });
            }
        }
        if out.is_empty() {
            out.push(Value { cat: "colour", key: String::new(), raw: v.to_string(), num: None, unit: String::new(), rgba: None, token: Some(name) });
        }
    }
    out
}

/// Lines whose colours are data or artwork rather than styling choices.
fn palette_line(code: &str) -> bool {
    static ART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"gradient\(|<(?:svg|path|circle|rect|ellipse|polygon|polyline|line|stop|g)\b|\b(?:fill|stroke|stopColor|stop-color)=").unwrap());
    static BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*["'`]#[0-9a-fA-F]+["'`]\s*,?\s*$"#).unwrap());
    static RECORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\b(?:name|label|title)\s*:\s*["'`]"#).unwrap());
    ART.is_match(code) || BARE.is_match(code) || RECORD.is_match(code) || fancy_all(&HEX, code).len() >= 3
}

/// Values in arbitrary Tailwind classes: `text-[13px]`, `bg-[#333]`.
fn tailwind(code: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for c in fancy_all(&TW_ARBITRARY, code) {
        let prefix = c.get(1).unwrap().as_str();
        let inner = c.get(2).unwrap().as_str();
        if let Some((key, rgba)) = parse_colour(inner).filter(|_| inner.starts_with('#') || inner.starts_with("rgb") || inner.starts_with("hsl")) {
            out.push(Value { cat: "colour", key, raw: inner.to_string(), num: None, unit: String::new(), rgba: Some(rgba), token: None });
            continue;
        }
        if let Some(cat) = tw_category(prefix) {
            out.extend(numbers(cat, inner));
        }
    }
    out
}

/// The styling values one source line uses, and the tokens it defines.
fn values_of(line: &str, kind: &str) -> Vec<Value> {
    static HTML_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<!--.*?-->").unwrap());
    static LINE_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|\s)//.*$").unwrap());
    static DEFINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"--[\w-]+\s*:").unwrap());
    if !line.bytes().any(|b| b.is_ascii_digit() || b == b'#') {
        return vec![];
    }
    let code = LINE_COMMENT.replace(&HTML_COMMENT.replace_all(line, ""), "").to_string();
    if kind == "css" || DEFINES.is_match(&code) {
        let defined: Vec<Value> = tokens(&code);
        if !defined.is_empty() {
            return defined.into_iter().filter(|v| !v.key.is_empty()).collect();
        }
    }
    let mut out = Vec::new();
    if kind == "theme" {
        return out;
    }
    if kind == "css" {
        for c in fancy_all(&CSS_PROPS, &code) {
            if let Some(cat) = category_of(c.get(1).unwrap().as_str()) {
                out.extend(numbers(cat, c.get(2).unwrap().as_str()));
            }
        }
    }
    if kind == "js" || kind == "markup" {
        for c in fancy_all(&JS_PROPS, &code) {
            if let Some(cat) = category_of(c.get(1).unwrap().as_str()) {
                let text = c.get(3).or_else(|| c.get(4)).map_or("", |m| m.as_str());
                out.extend(numbers(cat, text));
            }
        }
        out.extend(tailwind(&code));
    }
    if kind == "swift" {
        for c in SWIFT.captures_iter(&code) {
            let (cat, text) = if let Some(m) = c.get(1) { ("font size", m.as_str()) } else if let Some(m) = c.get(2) { ("spacing", m.as_str()) } else { ("radius", c.get(3).map_or("", |m| m.as_str())) };
            out.extend(numbers(cat, text));
        }
    }
    if !palette_line(&code) {
        let more: Vec<Value> = colours(&code).into_iter().filter(|c| !out.iter().any(|v| v.raw == c.raw)).collect();
        out.extend(more);
    }
    out
}

/// The text with block comments blanked, newlines kept. A `/*` counts only after whitespace or punctuation.
fn blank_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = text.as_bytes().to_vec();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let lead_ok = i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r' | b';' | b'{' | b'}' | b'(' | b',');
        if bytes[i] == b'/' && bytes[i + 1] == b'*' && lead_ok {
            if let Some(end) = text[i + 2..].find("*/") {
                let stop = i + 2 + end + 2;
                for b in &mut out[i..stop] {
                    if *b != b'\n' {
                        *b = b' ';
                    }
                }
                i = stop;
                continue;
            }
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

fn kind_of(path: &str) -> &'static str {
    if THEME.is_match(path) {
        "theme"
    } else if [".css", ".scss", ".sass", ".less"].iter().any(|e| path.ends_with(e)) {
        "css"
    } else if path.ends_with(".swift") {
        "swift"
    } else if MARKUP.is_match(path) {
        "markup"
    } else {
        "js"
    }
}

/// What a package can see: existing values with counts (in first-seen order) and tokens.
struct Inventory<'a> {
    order: Vec<String>,
    values: HashMap<String, (usize, &'a Value)>,
    tokens: Vec<&'a Seen>,
}

fn in_reach(from: &str, to: &str) -> bool {
    from == to || SHARED_PKG.is_match(from) || to.starts_with(&format!("{from}/"))
}

fn inventory_for<'a>(old: &'a [Seen], target: &str) -> Inventory<'a> {
    let mut inv = Inventory { order: vec![], values: HashMap::new(), tokens: vec![] };
    for s in old.iter().filter(|s| in_reach(&s.pkg, target)) {
        if s.v.token.is_some() {
            inv.tokens.push(s);
            continue;
        }
        let id = format!("{}\0{}", s.v.cat, s.v.key);
        match inv.values.get_mut(&id) {
            Some(e) => e.0 += 1,
            None => {
                inv.order.push(id.clone());
                inv.values.insert(id, (1, &s.v));
            }
        }
    }
    inv
}

fn uses(count: usize, lead: &str) -> String {
    if count == 0 {
        return String::new();
    }
    let s = if count == 1 { "" } else { "s" };
    if lead == " (" { format!(" (used {count} time{s})") } else { format!("{lead}used {count} time{s}") }
}

fn colour_finding(v: &Seen, inv: &Inventory, refs: &HashMap<String, usize>) -> Option<String> {
    let tokens: Vec<&Seen> = if TOKEN_FILES.is_match(&v.file) { inv.tokens.clone() } else { vec![] };
    let mut holders: Vec<&str> = Vec::new();
    for t in tokens.iter().filter(|t| t.v.cat == "colour" && t.v.key == v.v.key) {
        let name = t.v.token.as_deref().unwrap_or("");
        if !holders.contains(&name) {
            holders.push(name);
        }
    }
    let count = |name: &str| refs.get(name).copied().unwrap_or(0);
    if holders.len() == 1 && !is_neutral(&v.v.key) {
        return Some(format!("colour {} is the value of {}{}: use the token", v.v.raw, holders[0], uses(count(holders[0]), " (")));
    }
    if !holders.is_empty() || inv.values.contains_key(&format!("colour\0{}", v.v.key)) || is_neutral(&v.v.key) {
        return None;
    }
    let mut best: Option<(String, String, usize, f64)> = None;
    for t in &tokens {
        let d = match (&t.v.rgba, &v.v.rgba) {
            (Some(a), Some(b)) if t.v.cat == "colour" && !is_neutral(&t.v.key) => colour_distance(b, a),
            _ => f64::INFINITY,
        };
        if d < NEAR_COLOUR && best.as_ref().is_none_or(|b| d < b.3) {
            let name = t.v.token.clone().unwrap_or_default();
            best = Some((name.clone(), t.v.key.clone(), count(&name), d));
        }
    }
    if best.is_none() {
        for id in &inv.order {
            let (n, value) = inv.values[id];
            let d = match (&value.rgba, &v.v.rgba) {
                (Some(a), Some(b)) if value.cat == "colour" && n >= POPULAR && !is_neutral(&value.key) => colour_distance(b, a),
                _ => f64::INFINITY,
            };
            if d < NEAR_COLOUR && best.as_ref().is_none_or(|b| d < b.3) {
                best = Some((String::new(), value.key.clone(), n, d));
            }
        }
    }
    let (name, key, n, _) = best?;
    Some(if !name.is_empty() { format!("colour {} is nearly {key} ({name}{}): use the token", v.v.raw, uses(n, ", ")) } else { format!("colour {} is nearly {key} (used {n} times): use {key}", v.v.raw) })
}

fn number_finding(v: &Seen, inv: &Inventory, refs: &HashMap<String, usize>) -> Option<String> {
    let tokens: Vec<&Seen> = if TOKEN_FILES.is_match(&v.file) { inv.tokens.clone() } else { vec![] };
    let mut holders: Vec<&str> = Vec::new();
    for t in tokens.iter().filter(|t| t.v.cat == v.v.cat && t.v.key == v.v.key) {
        let name = t.v.token.as_deref().unwrap_or("");
        if !holders.contains(&name) {
            holders.push(name);
        }
    }
    let count = |name: &str| refs.get(name).copied().unwrap_or(0);
    if holders.len() == 1 && matches!(v.v.cat, "font size" | "radius") && count(holders[0]) >= NUMBER_TOKEN_REFS {
        return Some(format!("{} {} is the value of {}{}: use the token", v.v.cat, v.v.raw, holders[0], uses(count(holders[0]), " (")));
    }
    if !holders.is_empty() || inv.values.contains_key(&format!("{}\0{}", v.v.cat, v.v.key)) {
        return None;
    }
    // The scale: existing values of this category and unit, most used first (ties keep first-seen order).
    let mut list: Vec<(usize, &Value)> = inv.order.iter().map(|id| inv.values[id]).filter(|(_, e)| e.cat == v.v.cat && e.unit == v.v.unit).collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    let total: usize = list.iter().map(|e| e.0).sum();
    let steps: Vec<(usize, &Value)> = list.iter().filter(|e| e.0 >= 2).copied().collect();
    let covered: usize = steps.iter().take(12).map(|e| e.0).sum();
    // ponytail: "closed" means at most 12 values cover 97% of at least 40 uses; tuned on the corpus, not configurable
    let closed = total >= 40 && steps.len() <= 12 && covered as f64 >= 0.97 * total as f64;
    let num = v.v.num?;
    let tolerance = near(v.v.cat, &v.v.unit);
    let close = |n: f64| tolerance.is_some_and(|t| (n - num).abs() <= t + 1e-9 && (n - num).abs() <= NEAR_SHARE * n.abs());
    let near_list: Vec<&(usize, &Value)> = list.iter().filter(|e| e.0 >= POPULAR && e.1.num.is_some_and(close)).collect();
    if !near_list.is_empty() {
        let names: Vec<String> = near_list.iter().map(|e| format!("{} (used {} times)", e.1.key, e.0)).collect();
        let pick = if near_list.len() == 1 { near_list[0].1.key.clone() } else { "one of those".to_string() };
        return Some(format!("{} {} is nearly {}: use {pick}", v.v.cat, v.v.raw, names.join(" or ")));
    }
    if !closed || !matches!(v.v.cat, "font size" | "font weight" | "radius") {
        return None;
    }
    let mut sorted: Vec<f64> = steps.iter().take(12).filter_map(|e| e.1.num).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let share = (100.0 * steps.iter().take(12).map(|e| e.0).sum::<usize>() as f64 / total as f64).round() as i64;
    let below = sorted.iter().rev().find(|&&n| n < num);
    let above = sorted.iter().find(|&&n| n > num);
    let pick: Vec<String> = [below, above].into_iter().flatten().map(|n| format!("{}{}", num_text(*n), v.v.unit)).collect();
    let scale: Vec<String> = sorted.iter().map(|n| format!("{}{}", num_text(*n), v.v.unit)).collect();
    Some(format!("{} {} is off this project's scale ({}: {share}% of {total} uses): use {}", v.v.cat, v.v.raw, scale.join(", "), pick.join(" or ")))
}

/// The family a token belongs to: its name without the last segment (`--gray-750` is `--gray`).
fn family(name: &str) -> &str {
    name.rfind('-').filter(|&i| i > 0 && !name[i + 1..].is_empty()).map_or(name, |i| &name[..i])
}

fn token_finding(t: &Seen, inv: &Inventory) -> Option<String> {
    let name = t.v.token.as_deref()?;
    if inv.tokens.iter().any(|o| o.v.token.as_deref() == Some(name)) {
        return None;
    }
    // Semantic tokens share and nearly share values on purpose; only a sibling in the same family is a duplicate.
    for o in &inv.tokens {
        let other = o.v.token.as_deref().unwrap_or("");
        if o.v.cat != t.v.cat || o.v.unit != t.v.unit || family(other) != family(name) {
            continue;
        }
        if o.v.key == t.v.key {
            return Some(format!("token {name} ({}) duplicates {other}: use {other}", t.v.raw));
        }
        let (d, tolerance) = if t.v.cat == "colour" {
            (match (&t.v.rgba, &o.v.rgba) { (Some(a), Some(b)) => colour_distance(a, b), _ => f64::INFINITY }, NEAR_COLOUR)
        } else {
            ((t.v.num.unwrap_or(f64::NAN) - o.v.num.unwrap_or(f64::NAN)).abs(), near(t.v.cat, &t.v.unit).unwrap_or(-1.0))
        };
        if d < tolerance + 1e-9 {
            return Some(format!("token {name} ({}) is nearly {other} ({}): use {other}, or make the two clearly different", t.v.raw, o.v.raw));
        }
    }
    None
}

fn finding_for(v: &Seen, inv: &Inventory, refs: &HashMap<String, usize>) -> Option<String> {
    static PLAIN_SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?[jt]s$").unwrap());
    if v.v.token.is_some() {
        return token_finding(v, inv);
    }
    if v.v.cat == "colour" {
        return colour_finding(v, inv, refs);
    }
    // A style object in a plain script is usually for someone else's API (Stripe appearance, a chart library, an email).
    if PLAIN_SCRIPT.is_match(&v.file) { None } else { number_finding(v, inv, refs) }
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let packages: HashSet<String> = request.options.get("packages").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    let pkg = |file: &str| {
        let mut dir = std::path::Path::new(file).parent();
        while let Some(d) = dir.filter(|d| !d.as_os_str().is_empty()) {
            let s = d.to_string_lossy().replace('\\', "/");
            if packages.contains(&s) {
                return s;
            }
            dir = d.parent();
        }
        String::new()
    };
    let added = request.added_sets().unwrap_or_default();
    // Each file's values and token references, read in parallel, kept in file order.
    let per_file: Vec<(Vec<Seen>, Vec<Seen>, Vec<String>)> = request
        .files
        .par_iter()
        .map(|file| {
            let mut fresh = Vec::new();
            let mut old = Vec::new();
            let mut refs = Vec::new();
            let path = std::path::Path::new(&request.root).join(file);
            let Ok(meta) = std::fs::metadata(&path) else { return (fresh, old, refs) };
            if !meta.is_file() || meta.len() > MAX_BYTES {
                return (fresh, old, refs);
            }
            let Ok(text) = std::fs::read_to_string(&path) else { return (fresh, old, refs) };
            if text.contains('\0') {
                return (fresh, old, refs);
            }
            let kind = kind_of(file);
            let mine = added.get(file.as_str());
            let package = pkg(file);
            for (i, line) in blank_comments(&text).split('\n').enumerate() {
                if line.contains("var(") {
                    refs.extend(VAR_REF.captures_iter(line).map(|c| c[1].to_string()));
                }
                if kind == "markup" {
                    refs.extend(fancy_all(&TW_REF, line).into_iter().map(|c| format!("--color-{}", &c[1])));
                }
                for v in values_of(line, kind) {
                    let seen = Seen { v, file: file.clone(), line: i as u32 + 1, pkg: package.clone() };
                    if mine.is_some_and(|m| m.contains(&(i as u32 + 1))) { fresh.push(seen) } else { old.push(seen) }
                }
            }
            (fresh, old, refs)
        })
        .collect();
    let mut fresh = Vec::new();
    let mut old = Vec::new();
    let mut refs: HashMap<String, usize> = HashMap::new();
    for (f, o, r) in per_file {
        fresh.extend(f);
        old.extend(o);
        for name in r {
            *refs.entry(name).or_default() += 1;
        }
    }
    let mut by_pkg: HashMap<String, Inventory> = HashMap::new();
    let mut findings = Vec::new();
    let mut seen = HashSet::new();
    for v in &fresh {
        if !by_pkg.contains_key(&v.pkg) {
            by_pkg.insert(v.pkg.clone(), inventory_for(&old, &v.pkg));
        }
        let inv = &by_pkg[&v.pkg];
        let Some(message) = finding_for(v, inv, &refs) else { continue };
        let target = format!("{}:{}", v.file, v.v.token.clone().unwrap_or_else(|| v.v.key.clone()));
        if !seen.insert(target.clone()) {
            continue;
        }
        findings.push(Finding { file: v.file.clone(), line: v.line, target, message: format!("{}:{} {message}", v.file, v.line) });
    }
    Ok(Answer { findings, summary: format!("{} added styling values checked against {} in the repository", fresh.len(), old.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_colours_numbers_and_tokens() {
        assert_eq!(parse_colour("hsl(var(--ring))"), None);
        assert_eq!(parse_colour("rgb(var(--ink) / 0.5)"), None);
        assert_eq!(parse_colour("rgb(51, 51, 51)").map(|c| c.0), Some("#333333".into()));
        assert_eq!(parse_colour("#abc").map(|c| c.0), Some("#aabbcc".into()));
        assert_eq!(parse_number("1.5rem"), Some((24.0, "px".into())));
        let v = values_of(".a { font-size: 13px; color: #343434; }", "css");
        assert_eq!(v.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(), vec!["13px", "#343434"]);
        assert_eq!(values_of("  --color-ink: #333333;", "css")[0].token.as_deref(), Some("--color-ink"));
        assert_eq!(family("--gray-750"), "--gray");
        assert_eq!(blank_comments("a /* x\ny */ b"), "a     \n     b");
    }
}
