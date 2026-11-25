//! The value-drift check: the product says one number and the code another. Copy, docs or a comment that states a
//! fee, rate or price ("1.5% + $0.30 per payment") that the constant with the same name in code does not hold, or one
//! money rate defined twice with different values. Constants come from `const` declarations and the object literals
//! in them; claims from strings, JSX text and comments. A claim is matched to a constant by the words they share.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use rayon::prelude::*;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::text::{self, Lines};
use crate::{rel, Answer, Finding, Request};

/// Words that make a number a money number.
const MONEY: &[&str] = &[
    "fee",
    "commission",
    "tax",
    "vat",
    "gst",
    "price",
    "pricing",
    "cost",
    "payment",
    "earning",
    "revenue",
    "spend",
    "wage",
    "salary",
    "rent",
    "shipping",
    "donation",
    "wallet",
    "discount",
    "markup",
    "margin",
    "payout",
    "refund",
    "surcharge",
    "tip",
    "deposit",
    "subscription",
    "credit",
    "rebate",
    "royalty",
    "affiliate",
    "referral",
    "bonus",
    "penalty",
    "interest",
    "apr",
    "charge",
    "billing",
    "invoice",
    "coupon",
    "promo",
];
/// Name words that mark a sample amount for an illustration.
const SAMPLE: &[&str] = &["example", "sample", "demo", "preview", "placeholder", "mock", "fake", "dummy"];
/// Name words that say nothing about which number it is.
const VAGUE: &[&str] = &[
    "point",
    "const",
    "current",
    "default",
    "defaults",
    "initial",
    "value",
    "values",
    "config",
    "settings",
    "setting",
    "policy",
    "commercial",
    "the",
    "of",
    "a",
    "an",
    "in",
    "to",
    "and",
    "or",
    "for",
    "per",
];
/// Copy states fees and minimums in dollars; larger amounts are thresholds, plan prices or worked examples.
const MAX_CLAIM_CENTS: f64 = 10_000.0;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Fraction,
    Cents,
}

/// Unit words in a constant's name: what one unit is worth.
fn unit(word: &str) -> Option<(f64, Kind)> {
    Some(match word {
        "percent" | "pct" | "percentage" => (0.01, Kind::Fraction),
        "bps" | "basis" => (0.0001, Kind::Fraction),
        "rate" | "ratio" => (1.0, Kind::Fraction),
        "cents" | "cent" => (1.0, Kind::Cents),
        "dollars" | "dollar" | "usd" => (100.0, Kind::Cents),
        _ => return None,
    })
}

#[derive(Clone)]
struct Constant {
    file: String,
    line: u32,
    name: String,
    words: Vec<String>,
    key: String,
    kind: Option<Kind>,
    normal: f64,
}

struct Claim {
    file: String,
    line: u32,
    text: String,
    said: String,
    value: f64,
    kind: Kind,
    words: Vec<String>,
}

/// Lowercase words of a name or sentence, `fees` as `fee`, `maximum` as `max`.
fn words_of(text: &str) -> Vec<String> {
    static LOWER_UPPER: LazyLock<Regex> = LazyLock::new(|| Regex::new("([a-z0-9])([A-Z])").unwrap());
    static ACRONYM: LazyLock<Regex> = LazyLock::new(|| Regex::new("([A-Z]+)([A-Z][a-z])").unwrap());
    let spaced = ACRONYM.replace_all(&LOWER_UPPER.replace_all(text, "$1 $2"), "$1 $2").to_lowercase();
    spaced
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|w| !w.is_empty())
        .map(|w| match w {
            "maximum" => "max".to_string(),
            "minimum" => "min".to_string(),
            _ if w.len() > 4 && w.ends_with("ies") => format!("{}y", &w[..w.len() - 3]),
            _ if w.len() > 3 && w.ends_with('s') && !w.ends_with("is") && !w.ends_with("us") && !w.ends_with("ss") => {
                w[..w.len() - 1].to_string()
            }
            _ => w.to_string(),
        })
        .collect()
}

/// A money constant from its name path and value, or None. `words` are every name on the path, for matching copy;
/// `key` is the constant's own name, with the names around it only until one is a money word.
fn constant(file: &str, line: u32, path: &[String], value: f64) -> Option<Constant> {
    let mut found_unit = None;
    let parts: Vec<Vec<String>> = path
        .iter()
        .map(|part| {
            words_of(part)
                .into_iter()
                .filter(|w| {
                    if let Some(u) = unit(w) {
                        found_unit = Some(u);
                        return false;
                    }
                    !VAGUE.contains(&w.as_str()) && !w.chars().all(|c| c.is_ascii_digit())
                })
                .collect()
        })
        .collect();
    let mut words: Vec<String> = Vec::new();
    for w in parts.iter().flatten() {
        if !words.contains(w) {
            words.push(w.clone());
        }
    }
    if !words.iter().any(|w| MONEY.contains(&w.as_str())) || words.iter().any(|w| SAMPLE.contains(&w.as_str())) {
        return None;
    }
    let mut key: Vec<String> = Vec::new();
    for part in parts.iter().rev() {
        if key.iter().any(|w| MONEY.contains(&w.as_str())) {
            break;
        }
        key.extend(part.iter().cloned());
    }
    key.sort();
    key.dedup();
    Some(Constant {
        file: file.to_string(),
        line,
        name: path.join("."),
        words,
        key: key.join(" "),
        kind: found_unit.map(|u| u.1),
        normal: value * found_unit.map_or(1.0, |u| u.0),
    })
}

/// The number a constant expression comes to: literals and + - * / of them, under casts.
fn number_of(e: &Expression) -> Option<f64> {
    match e {
        Expression::NumericLiteral(n) => Some(n.value),
        Expression::ParenthesizedExpression(p) => number_of(&p.expression),
        Expression::TSAsExpression(t) => number_of(&t.expression),
        Expression::TSSatisfiesExpression(t) => number_of(&t.expression),
        Expression::UnaryExpression(u) if u.operator == UnaryOperator::UnaryNegation => number_of(&u.argument).map(|v| -v),
        Expression::BinaryExpression(b) => {
            let (a, c) = (number_of(&b.left)?, number_of(&b.right)?);
            match b.operator {
                BinaryOperator::Addition => Some(a + c),
                BinaryOperator::Subtraction => Some(a - c),
                BinaryOperator::Multiplication => Some(a * c),
                BinaryOperator::Division => Some(a / c),
                _ => None,
            }
        }
        _ => None,
    }
}

struct Reader<'s> {
    file: String,
    lines: &'s Lines,
    constants: Vec<Constant>,
    texts: Vec<(u32, String)>,
    /// The names leading to the value being walked, inside a `const`; None outside one.
    path: Option<Vec<String>>,
}

impl<'s> Reader<'s> {
    fn record(&mut self, path: &[String], offset: u32, value: Option<f64>) {
        // Zero is "none" or a starting value (`ZERO.feeCents`), never the rate.
        if let Some(v) = value.filter(|v| *v != 0.0) {
            if let Some(c) = constant(&self.file, self.lines.line(offset as usize), path, v) {
                self.constants.push(c);
            }
        }
    }

    fn with_path(&mut self, path: Option<Vec<String>>, f: impl FnOnce(&mut Self)) {
        let saved = std::mem::replace(&mut self.path, path);
        f(self);
        self.path = saved;
    }
}

impl<'a, 's> Visit<'a> for Reader<'s> {
    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        self.texts.push((it.span.start, it.value.to_string()));
    }

    fn visit_template_element(&mut self, it: &TemplateElement<'a>) {
        let text = it.value.cooked.as_ref().map_or(it.value.raw.as_str(), |c| c.as_str());
        self.texts.push((it.span.start, text.to_string()));
    }

    fn visit_jsx_text(&mut self, it: &JSXText<'a>) {
        self.texts.push((it.span.start, it.value.to_string()));
    }

    fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
        // A `const` and the object literals in it: a `let` is a running total or a starting value, not a setting.
        let path = (it.kind == VariableDeclarationKind::Const).then(Vec::new);
        self.with_path(path, |r| walk::walk_variable_declaration(r, it));
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let named = match (&self.path, &it.id) {
            (Some(_), BindingPattern::BindingIdentifier(id)) => Some(vec![id.name.to_string()]),
            _ => None,
        };
        if let Some(path) = &named {
            self.record(path, it.span.start, it.init.as_ref().and_then(number_of));
        }
        if let Some(init) = &it.init {
            self.with_path(named, |r| r.visit_expression(init));
        }
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        let named = match (&self.path, it.computed) {
            (Some(path), false) if !path.is_empty() => it.key.static_name().map(|k| {
                let mut p = path.clone();
                p.push(k.to_string());
                p
            }),
            _ => None,
        };
        if let Some(path) = &named {
            self.record(path, it.span.start, number_of(&it.value));
        }
        if let PropertyKey::StringLiteral(_) = &it.key {
            // A quoted key is a name, not copy.
        }
        self.with_path(named, |r| r.visit_expression(&it.value));
    }

    fn visit_object_expression(&mut self, it: &ObjectExpression<'a>) {
        walk::walk_object_expression(self, it);
    }

    fn visit_array_expression(&mut self, it: &ArrayExpression<'a>) {
        walk::walk_array_expression(self, it);
    }

    fn visit_expression(&mut self, it: &Expression<'a>) {
        // The path carries through object and array literals and TypeScript wrappers; any other node ends it.
        let keeps = matches!(
            it,
            Expression::ObjectExpression(_)
                | Expression::ArrayExpression(_)
                | Expression::TSAsExpression(_)
                | Expression::TSSatisfiesExpression(_)
                | Expression::ParenthesizedExpression(_)
        );
        if keeps {
            walk::walk_expression(self, it);
        } else {
            self.with_path(None, |r| walk::walk_expression(r, it));
        }
    }
}

/// Money constants and the text of every string, JSX text and comment in a file.
fn read(file: &str, src: &str) -> (Vec<Constant>, Vec<Claim>) {
    crate::js::parse(file, src, |program| {
        let lines = Lines::new(src);
        let mut reader = Reader { file: file.to_string(), lines: &lines, constants: vec![], texts: vec![], path: None };
        reader.visit_program(program);
        for comment in &program.comments {
            let span = comment.content_span();
            reader.texts.push((span.start, src[span.start as usize..span.end as usize].to_string()));
        }
        let claims = reader.texts.iter().flat_map(|(start, t)| claims_in(file, &lines, *start as usize, t)).collect();
        (reader.constants, claims)
    })
    .unwrap_or_default()
}

fn show(n: f64, kind: Kind) -> String {
    match kind {
        Kind::Cents => format!("${:.2}", n / 100.0),
        Kind::Fraction => {
            let pct = (n * 100.0 * 10_000.0).round() / 10_000.0;
            if pct.fract() == 0.0 {
                format!("{}%", pct as i64)
            } else {
                format!("{pct}%")
            }
        }
    }
}

/// The sentences of a text: split after . ; ! ? newline or |, unless a digit follows (1.5%).
fn sentences(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if matches!(b, b'.' | b';' | b'!' | b'?' | b'\n' | b'|')
            && !bytes.get(i + 1).is_some_and(|n| n.is_ascii_digit())
            && text.is_char_boundary(i + 1)
        {
            out.push((start, &text[start..i + 1]));
            start = i + 1;
        }
    }
    if start < text.len() {
        out.push((start, &text[start..]));
    }
    out
}

/// The money numbers a piece of copy states, one sentence at a time.
fn claims_in(file: &str, lines: &Lines, start: usize, text: &str) -> Vec<Claim> {
    static EXAMPLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\be\.g\.|\bfor (?:example|instance)\b|\bsuch as\b|\bimagine\b|\bsay\b|^\s*for an?\b|\bif\b|[{}]|=").unwrap()
    });
    static BOUNDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bbetween\b|\b0 ?%|\b100 ?%").unwrap());
    static FIGURE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(\d+(?:\.\d+)?)\s?(%|¢|bps\b|basis points)|\$(\d[\d,]*(?:\.\d{1,2})?)").unwrap());
    let mut out = Vec::new();
    for (at, sentence) in sentences(text) {
        // Worked examples, hypotheticals and code are not the product's number.
        if EXAMPLE.is_match(sentence) {
            continue;
        }
        let words = words_of(sentence);
        if !words.iter().any(|w| MONEY.contains(&w.as_str())) {
            continue;
        }
        // "between 0% and 100%" and "0% to 100%" are bounds an input accepts, not a rate the product charges.
        if BOUNDS.is_match(sentence) {
            continue;
        }
        for m in FIGURE.captures_iter(sentence) {
            let cents = match (m.get(3), m.get(2).map(|g| g.as_str())) {
                (Some(d), _) => Some(d.as_str().replace(',', "").parse::<f64>().unwrap_or(0.0) * 100.0),
                (None, Some("¢")) => m[1].parse::<f64>().ok(),
                _ => None,
            };
            if cents.is_some_and(|c| c >= MAX_CLAIM_CENTS) {
                continue;
            }
            let value = cents.unwrap_or_else(|| {
                let n: f64 = m[1].parse().unwrap_or(0.0);
                if &m[2] == "%" {
                    n / 100.0
                } else {
                    n / 10_000.0
                }
            });
            let shown: String = sentence.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
            out.push(Claim {
                file: file.to_string(),
                line: lines.line(start + at),
                text: shown,
                said: m[0].to_string(),
                value,
                kind: if cents.is_some() { Kind::Cents } else { Kind::Fraction },
                words: words.clone(),
            });
        }
    }
    out
}

/// The constants a claim is about: those sharing the most words with its sentence, at least two of them and one a
/// money word, of the same kind of number.
fn about<'c>(claim: &Claim, constants: &'c [Constant]) -> Vec<&'c Constant> {
    let mut best = 1;
    let mut found = Vec::new();
    for c in constants {
        if c.kind != Some(claim.kind) {
            continue;
        }
        let shared: Vec<&String> = c.words.iter().filter(|w| claim.words.contains(w)).collect();
        if shared.len() < 2 || !shared.iter().any(|w| MONEY.contains(&w.as_str())) {
            continue;
        }
        if shared.len() > best {
            best = shared.len();
            found = vec![c];
        } else if shared.len() == best {
            found.push(c);
        }
    }
    found
}

fn same(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let per_file: Vec<(Vec<Constant>, Vec<Claim>)> =
        request.files.par_iter().map(|f| text::read(&request.root, f).map(|src| read(f, &src)).unwrap_or_default()).collect();
    let mut constants = Vec::new();
    let mut claims = Vec::new();
    for (c, k) in per_file {
        constants.extend(c);
        claims.extend(k);
    }
    let name = |file: &str| rel(&request.prefix, file);
    let mut findings = Vec::new();
    let mut reported = std::collections::HashSet::new();
    for claim in &claims {
        let targets = about(claim, &constants);
        if targets.is_empty() || targets.iter().any(|c| same(c.normal, claim.value)) {
            continue;
        }
        if !request.changed(&claim.file, claim.line) && !targets.iter().any(|c| request.changed(&c.file, c.line)) {
            continue;
        }
        let c = targets[0];
        let target = format!("{}:{}", name(&claim.file), claim.said);
        if !reported.insert(target.clone()) {
            continue;
        }
        findings.push(Finding {
            file: claim.file.clone(),
            line: claim.line,
            target,
            message: format!(
                "{}:{} says {} (\"{}\") but {} is {} at {}:{}: read the number from the constant, or fix whichever is wrong",
                name(&claim.file),
                claim.line,
                claim.said,
                claim.text,
                c.name,
                show(c.normal, claim.kind),
                name(&c.file),
                c.line
            ),
        });
    }
    // One money rate in two files with two values: the code disagrees with itself.
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, Vec<&Constant>> = HashMap::new();
    for c in constants.iter().filter(|c| c.kind.is_some()) {
        let key = format!("{}:{}", if c.kind == Some(Kind::Cents) { "cents" } else { "fraction" }, c.key);
        if !by_key.contains_key(&key) {
            order.push(key.clone());
        }
        by_key.entry(key).or_default().push(c);
    }
    for key in order {
        let list = &by_key[&key];
        let first = list[0];
        let Some(other) = list.iter().find(|c| c.file != first.file && !same(c.normal, first.normal)) else { continue };
        if !list.iter().any(|c| request.changed(&c.file, c.line)) {
            continue;
        }
        // The finding sits on the changed one (or, judging everything, the later file), and names the other.
        let (a, b) = if request.changed(&first.file, first.line) && !request.changed(&other.file, other.line) {
            (*other, first)
        } else {
            (first, *other)
        };
        let kind = b.kind.unwrap_or(Kind::Fraction);
        let target = format!("{}:{}", name(&b.file), b.name);
        findings.push(Finding {
            file: b.file.clone(),
            line: b.line,
            target,
            message: format!(
                "{}:{} sets {} to {} but {}:{} sets {} to {}: keep one constant and import it",
                name(&b.file),
                b.line,
                b.name,
                show(b.normal, kind),
                name(&a.file),
                a.line,
                a.name,
                show(a.normal, a.kind.unwrap_or(kind))
            ),
        });
    }
    Ok(Answer::new(findings, format!("{} money figures in copy checked against {} money constants", claims.len(), constants.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rates_with_their_units_and_claims_in_copy() {
        let (constants, claims) = read("p.tsx", "export const PRICING = { paymentFeeBps: 150, paymentFeeFixedCents: 30 } as const;\nlet total = 0;\nexport const P = () => <p>The payment fee is 1.5% plus 30¢ per payment.</p>;\n");
        assert_eq!(
            constants.iter().map(|c| (c.name.as_str(), c.key.as_str(), (c.normal * 1e6).round() / 1e6)).collect::<Vec<_>>(),
            vec![("PRICING.paymentFeeBps", "fee payment", 0.015), ("PRICING.paymentFeeFixedCents", "fee fixed payment", 30.0)]
        );
        assert_eq!(claims.iter().map(|c| c.said.as_str()).collect::<Vec<_>>(), vec!["1.5%", "30¢"]);
        assert_eq!(show(0.0125, Kind::Fraction), "1.25%");
        assert_eq!(show(30.0, Kind::Cents), "$0.30");
    }
}
