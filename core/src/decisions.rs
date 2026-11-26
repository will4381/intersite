//! One decision read in many places: the same environment variable read in several files, the same feature flag
//! checked in several files, or the same `kind`/`type` value branched on in several files. Each copy is a place the
//! next change has to find; the decision belongs in one module that the rest import.
//!
//! One constant declared with one value in several files is the same thing in a smaller coin (a day in milliseconds,
//! a contract version, the API's address), and it is a suggestion: gathering it is cheap, and the copies are the
//! owner's to gather.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use oxc_syntax::operator::BinaryOperator;
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet};

use crate::text::{self, Lines};
use crate::{js, Answer, Finding, Request};

/// A copy this many files wide is a decision made in several places.
const MIN_FILES: usize = 3;
/// Properties that name which variant a value is: branching on them in many files is a union nobody owns.
const DISCRIMINANTS: [&str; 6] = ["kind", "type", "variant", "mode", "tier", "plan"];
/// Calls that ask whether a feature flag is on.
const FLAG_CALLS: [&str; 8] =
    ["isEnabled", "isFeatureEnabled", "useFlag", "useFeatureFlag", "getFlag", "featureEnabled", "useFeature", "flagEnabled"];
/// Variables a bundler or runtime branches on by design; reading them everywhere is how they work.
const ENV_EXEMPT: [&str; 9] = ["NODE_ENV", "CI", "DEBUG", "TZ", "DEV", "PROD", "MODE", "SSR", "BASE_URL"];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Env,
    Flag,
    Branch,
}

struct Site {
    kind: Kind,
    key: String,
    line: u32,
}

struct Collector<'s> {
    src: &'s str,
    lines: Lines,
    sites: Vec<Site>,
}

impl Collector<'_> {
    fn add(&mut self, kind: Kind, key: String, span: oxc_span::Span) {
        let line = self.lines.line(span.start as usize);
        self.sites.push(Site { kind, key, line });
    }

    fn text(&self, span: oxc_span::Span) -> &str {
        &self.src[span.start as usize..span.end as usize]
    }
}

/// The discriminant a comparison side reads, with the property it hangs off when there is one: `event.kind` is
/// `.kind`, `event.result.kind` is `.result.kind`, so two unions that share a property name stay apart.
fn discriminant(e: &Expression) -> Option<String> {
    let (object, prop) = match e {
        Expression::StaticMemberExpression(m) => (&m.object, m.property.name.as_str()),
        Expression::ChainExpression(c) => match &c.expression {
            ChainElement::StaticMemberExpression(m) => (&m.object, m.property.name.as_str()),
            _ => return None,
        },
        _ => return None,
    };
    if !DISCRIMINANTS.contains(&prop) {
        return None;
    }
    Some(match object {
        Expression::StaticMemberExpression(o) => format!(".{}.{prop}", o.property.name),
        _ => format!(".{prop}"),
    })
}

impl<'a> Visit<'a> for Collector<'_> {
    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if js::is_env_object(self.text(it.object.span())) && !ENV_EXEMPT.contains(&it.property.name.as_str()) {
            self.add(Kind::Env, it.property.name.to_string(), it.span);
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        if js::is_env_object(self.text(it.object.span())) {
            if let Some(name) = js::string(&it.expression, true).filter(|n| !ENV_EXEMPT.contains(n)).map(str::to_string) {
                self.add(Kind::Env, name, it.span);
            }
        }
        walk::walk_computed_member_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let callee = self.text(it.callee.span()).to_string();
        let first = it.arguments.first().and_then(|a| a.as_expression()).and_then(|e| js::string(e, true).map(str::to_string));
        if let Some(name) = first {
            if callee == "Deno.env.get" && !ENV_EXEMPT.contains(&name.as_str()) {
                self.add(Kind::Env, name, it.span);
            } else if FLAG_CALLS.contains(&callee.rsplit('.').next().unwrap_or("")) {
                self.add(Kind::Flag, name, it.span);
            }
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
        if matches!(
            it.operator,
            BinaryOperator::StrictEquality | BinaryOperator::StrictInequality | BinaryOperator::Equality | BinaryOperator::Inequality
        ) {
            let pair = discriminant(&it.left)
                .zip(js::string(&it.right, true).map(str::to_string))
                .or_else(|| discriminant(&it.right).zip(js::string(&it.left, true).map(str::to_string)));
            if let Some((prop, value)) = pair {
                self.add(Kind::Branch, format!("{prop} === \"{value}\""), it.span);
            }
        }
        walk::walk_binary_expression(self, it);
    }

    fn visit_switch_statement(&mut self, it: &SwitchStatement<'a>) {
        if let Some(prop) = discriminant(&it.discriminant) {
            for case in &it.cases {
                if let Some(value) = case.test.as_ref().and_then(|e| js::string(e, true).map(str::to_string)) {
                    self.add(Kind::Branch, format!("{prop} === \"{value}\""), case.span);
                }
            }
        }
        walk::walk_switch_statement(self, it);
    }
}

/// A constant a module declares at its top: `export const DAY_MS = 24 * 60 * 60 * 1000`.
struct Constant {
    name: String,
    value: String,
    line: u32,
}

/// The number an expression is, when it is literals multiplied, added, subtracted or divided.
fn number(e: &Expression) -> Option<f64> {
    match e.get_inner_expression() {
        Expression::NumericLiteral(n) => Some(n.value),
        Expression::BinaryExpression(b) => {
            let (left, right) = (number(&b.left)?, number(&b.right)?);
            match b.operator {
                BinaryOperator::Multiplication => Some(left * right),
                BinaryOperator::Addition => Some(left + right),
                BinaryOperator::Subtraction => Some(left - right),
                BinaryOperator::Division => Some(left / right),
                _ => None,
            }
        }
        _ => None,
    }
}

/// A statement that is a `const` at the top of a module, exported or not.
fn top_const<'b, 'a>(s: &'b Statement<'a>) -> Option<&'b VariableDeclaration<'a>> {
    let declaration = match s {
        Statement::VariableDeclaration(v) => &**v,
        Statement::ExportNamedDeclaration(e) => match &e.declaration {
            Some(Declaration::VariableDeclaration(v)) => &**v,
            _ => return None,
        },
        _ => return None,
    };
    (declaration.kind == VariableDeclarationKind::Const).then_some(declaration)
}

/// The top-level constants named in capitals (`MAX_UPLOAD_BYTES`) whose value is a number or one word of text. A
/// colour or a list of classes is the style checks' to judge.
fn constants(program: &Program, lines: &Lines) -> Vec<Constant> {
    let shouted = |name: &str| {
        name.len() >= 5 && name.contains('_') && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    };
    let word = |text: &str| {
        !text.is_empty() && text.len() <= 80 && !text.starts_with('#') && !text.contains(|c: char| c.is_whitespace() || c == '(')
    };
    let one = |d: &VariableDeclarator| {
        let name = d.id.get_binding_identifier().map(|id| id.name.as_str()).filter(|n| shouted(n))?;
        let init = d.init.as_ref()?;
        let text = || js::string(init.get_inner_expression(), false).filter(|t| word(t)).map(|t| format!("\"{t}\""));
        let value = number(init).map(|n| n.to_string()).or_else(text)?;
        Some(Constant { name: name.to_string(), value, line: lines.line(d.span.start as usize) })
    };
    program.body.iter().filter_map(top_const).flat_map(|v| &v.declarations).filter_map(one).collect()
}

/// What one file holds: its decision sites and the constants it declares.
type Read = (Vec<Site>, Vec<Constant>);

/// A file's decision sites and constants, in one parse.
fn read(path: &str, src: &str) -> Read {
    crate::js::parse(path, src, |program| {
        let mut c = Collector { src, lines: Lines::new(src), sites: vec![] };
        c.visit_program(program);
        let constants = constants(program, &c.lines);
        (c.sites, constants)
    })
    .unwrap_or_default()
}

#[cfg(test)]
fn sites(path: &str, src: &str) -> Vec<Site> {
    read(path, src).0
}

/// A constant's places: its file and line.
type Places<'a> = Vec<(&'a String, u32)>;

/// One constant declared with one value in several files of the repository.
fn copied_constants(request: &Request, all: &[(String, Constant)]) -> Vec<Finding> {
    // name -> value -> where it is declared so
    let mut by_name: BTreeMap<&str, BTreeMap<&str, Places>> = BTreeMap::new();
    for (file, constant) in all {
        by_name.entry(&constant.name).or_default().entry(&constant.value).or_default().push((file, constant.line));
    }
    let mut out = vec![];
    let files_of = |places: &Places| places.iter().map(|p| p.0).collect::<BTreeSet<_>>().len();
    for (name, values) in &by_name {
        // A name with two values each in several files (`STALE_TIME` per hook) is two rules that share a name.
        if values.values().filter(|places| files_of(places) >= MIN_FILES).count() != 1 {
            continue;
        }
        for (value, places) in values {
            let files = files_of(places);
            let Some(&(file, line)) = places.iter().find(|(f, l)| request.changed(f, *l)).filter(|_| files >= MIN_FILES) else { continue };
            let mut others: Vec<String> = places.iter().filter(|p| **p != (file, line)).map(|(f, l)| format!("{f}:{l}")).collect();
            let more = others.len().saturating_sub(3);
            others.truncate(3);
            let also = format!("{}{}", others.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() });
            // The same name with another value: one rule that drifted, or two rules that share a name.
            let odd = values.iter().find(|(other, _)| other != &value).map_or(String::new(), |(other, at)| {
                format!(" {}:{} declares it as {other}: if that is the same rule, one of the two is wrong.", at[0].0, at[0].1)
            });
            out.push(Finding {
                file: file.clone(),
                line,
                target: format!("decisions:constant:{name}"),
                message: format!("{file}:{line} the constant {name} is declared as {value} in {files} files (also {also}): one value kept in {files} places, each free to change alone. Declare it once and import it.{odd}"),
            });
        }
    }
    out
}

/// A file and one site in it.
type Located = (String, Site);
/// Package, kind, subject (the variable, flag or property) and the files it is in.
type MergeKey<'a> = (String, Kind, String, Vec<&'a str>);

pub fn run(request: &Request) -> Result<Answer, String> {
    let read: Vec<(&String, Read)> =
        request.files.par_iter().filter_map(|file| Some((file, read(file, &text::read(&request.root, file)?)))).collect();
    let mut all: Vec<(String, Site)> = vec![];
    let mut declared: Vec<(String, Constant)> = vec![];
    for (file, (sites, constants)) in read {
        all.extend(sites.into_iter().map(|s| (file.clone(), s)));
        declared.extend(constants.into_iter().map(|c| (file.clone(), c)));
    }
    let mut packages = std::collections::HashMap::new();
    let mut groups: BTreeMap<(String, Kind, String), Vec<&Located>> = BTreeMap::new();
    for s in &all {
        if s.1.kind == Kind::Env && js::is_env_module(&s.0) {
            continue;
        }
        groups.entry((crate::graph::package_of(&request.root, &s.0, &mut packages), s.1.kind, s.1.key.clone())).or_default().push(s);
    }
    // Values of one union branched on in the same files are one decision: `.type` checked for "a", "b" and "c" in the
    // same three files is one switch to write, not three findings.
    let mut merged: BTreeMap<MergeKey, (Vec<String>, Vec<&Located>)> = BTreeMap::new();
    for ((package, kind, key), list) in &groups {
        let files: BTreeSet<&str> = list.iter().map(|(f, _)| f.as_str()).collect();
        if files.len() < MIN_FILES {
            continue;
        }
        let (subject, value) = match kind {
            Kind::Branch => key.split_once(" === ").map_or((key.clone(), String::new()), |(p, v)| (p.to_string(), v.to_string())),
            _ => (key.clone(), String::new()),
        };
        let entry = merged.entry((package.clone(), *kind, subject, files.into_iter().collect())).or_default();
        entry.0.push(value);
        entry.1.extend(list.iter().copied());
    }
    let mut findings = Vec::new();
    for ((_, kind, subject, files), (values, list)) in &merged {
        // One value checked in many files is a caller handling a result (`if (r.kind === "duplicate") return`); a
        // dispatch over several values repeated in the same files is behaviour per variant spread out.
        if *kind == Kind::Branch && values.len() < 2 {
            continue;
        }
        let Some((file, site)) = list.iter().map(|s| (&s.0, &s.1)).find(|(f, s)| request.changed(f, s.line)) else { continue };
        let mut places: Vec<String> = files
            .iter()
            .filter(|f| **f != file.as_str())
            .map(|f| {
                let line = list.iter().find(|(g, _)| g == f).map_or(0, |(_, s)| s.line);
                format!("{f}:{line}")
            })
            .collect();
        let more = places.len().saturating_sub(4);
        places.truncate(4);
        let elsewhere = format!("{}{}", places.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() });
        let n = files.len();
        let (what, fix) = match kind {
            Kind::Env => (format!("the environment variable {subject} is read in {n} files"), "each read can parse it or default it differently: read and validate it once in an env module, and import the value"),
            Kind::Flag => (format!("the feature flag \"{subject}\" is checked in {n} files"), "turning it off or removing it means finding every copy: decide it once, where the feature starts, and pass the result down"),
            Kind::Branch => (format!("`{subject}` is branched on for {} in the same {n} files", values.join(", ")), "a new variant has to be added in each of them: keep the per-variant behaviour in one module, a switch over the union with a never default, or a table keyed by the variant"),
        };
        let key = format!("{subject}{}", values.first().map_or("", |v| v.as_str()));
        let slug = key.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect::<String>();
        findings.push(Finding {
            file: file.clone(),
            line: site.line,
            target: format!(
                "decisions:{}:{slug}",
                match kind {
                    Kind::Env => "env",
                    Kind::Flag => "flag",
                    Kind::Branch => "branch",
                }
            ),
            message: format!("{file}:{} {what} (also {elsewhere}): {fix}", site.line),
        });
    }
    let summary = format!("{} environment reads, flag checks and variant branches in {} files", all.len(), request.files.len());
    Ok(Answer::new(findings, summary).suggesting(copied_constants(request, &declared)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_constant_declared_with_one_value_in_three_files_is_suggested_and_the_file_that_differs_is_named() {
        let files = [
            ("src/a.ts", "export const DAY_MS = 24 * 60 * 60 * 1000;\nexport const API_VERSION = \"orders.v2\";\nconst BRAND_BLUE = \"#1773B0\";\n"),
            ("src/b.ts", "const DAY_MS = 86_400_000;\nconst API_VERSION = \"orders.v2\";\nconst BRAND_BLUE = \"#1773B0\";\n"),
            ("src/c.ts", "const DAY_MS = 86400000;\nfunction f() {\n  const API_VERSION = \"orders.v2\";\n  return API_VERSION;\n}\nconst BRAND_BLUE = \"#1773B0\";\n"),
            ("src/d.ts", "const DAY_MS = 1000;\nconst dayMs = 86400000;\n"),
        ];
        let request = Request {
            command: "decisions".into(),
            root: text::temp_tree("decisions-constants", &files),
            files: files.iter().map(|(p, _)| p.to_string()).collect(),
            added: None,
            prefix: String::new(),
            database_url: None,
            options: serde_json::json!({}),
        };
        let answer = run(&request).unwrap();
        assert_eq!(answer.findings.len(), 0, "a copied constant fails nothing");
        // A version in two files and inside a function is not three declarations; a colour is the style checks'.
        let suggested = answer.data.unwrap()["suggestions"].clone();
        assert_eq!(suggested.as_array().map(Vec::len), Some(1));
        assert_eq!(suggested[0]["target"], "decisions:constant:DAY_MS");
        assert_eq!(
            suggested[0]["message"],
            "src/a.ts:1 the constant DAY_MS is declared as 86400000 in 3 files (also src/b.ts:1, src/c.ts:1): one value kept in 3 places, each free to change alone. Declare it once and import it. src/d.ts:1 declares it as 1000: if that is the same rule, one of the two is wrong."
        );
    }

    #[test]
    fn finds_env_reads_flags_and_variant_branches() {
        let s = sites("a.ts", "const k = process.env.STRIPE_KEY;\nconst m = process.env.NODE_ENV;\nif (isEnabled('new-checkout')) go();\nif (event.kind === 'refund') undo();\nswitch (shape.type) { case 'circle': break; default: }\nconst e = import.meta.env['VITE_API'];\n");
        let got: Vec<(u32, String)> = s.iter().map(|s| (s.line, s.key.clone())).collect();
        assert_eq!(
            got,
            vec![
                (1, "STRIPE_KEY".into()),
                (3, "new-checkout".into()),
                (4, ".kind === \"refund\"".into()),
                (5, ".type === \"circle\"".into()),
                (6, "VITE_API".into())
            ]
        );
    }
}
