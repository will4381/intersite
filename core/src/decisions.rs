//! One decision read in many places: the same environment variable read in several files, the same feature flag
//! checked in several files, or the same `kind`/`type` value branched on in several files. Each copy is a place the
//! next change has to find; the decision belongs in one module that the rest import.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use oxc_syntax::operator::BinaryOperator;
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet};

use crate::text::{self, Lines};
use crate::{Answer, Finding, Request};

/// A copy this many files wide is a decision made in several places.
const MIN_FILES: usize = 3;
/// Properties that name which variant a value is: branching on them in many files is a union nobody owns.
const DISCRIMINANTS: [&str; 6] = ["kind", "type", "variant", "mode", "tier", "plan"];
/// Calls that ask whether a feature flag is on.
const FLAG_CALLS: [&str; 8] = ["isEnabled", "isFeatureEnabled", "useFlag", "useFeatureFlag", "getFlag", "featureEnabled", "useFeature", "flagEnabled"];
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

/// `process.env`, `import.meta.env`, `Bun.env`: the object an environment variable is read from.
pub fn is_env_object(text: &str) -> bool {
    matches!(text, "process.env" | "import.meta.env" | "Bun.env")
}

/// A string literal's value, or undefined.
pub fn string(e: &Expression) -> Option<String> {
    match e {
        Expression::StringLiteral(s) => Some(s.value.to_string()),
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => t.quasis.first().map(|q| q.value.raw.to_string()),
        _ => None,
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
        if is_env_object(self.text(it.object.span())) && !ENV_EXEMPT.contains(&it.property.name.as_str()) {
            self.add(Kind::Env, it.property.name.to_string(), it.span);
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        if is_env_object(self.text(it.object.span())) {
            if let Some(name) = string(&it.expression).filter(|n| !ENV_EXEMPT.contains(&n.as_str())) {
                self.add(Kind::Env, name, it.span);
            }
        }
        walk::walk_computed_member_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let callee = self.text(it.callee.span()).to_string();
        let first = it.arguments.first().and_then(|a| a.as_expression()).and_then(string);
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
        if matches!(it.operator, BinaryOperator::StrictEquality | BinaryOperator::StrictInequality | BinaryOperator::Equality | BinaryOperator::Inequality) {
            let pair = discriminant(&it.left).zip(string(&it.right)).or_else(|| discriminant(&it.right).zip(string(&it.left)));
            if let Some((prop, value)) = pair {
                self.add(Kind::Branch, format!("{prop} === \"{value}\""), it.span);
            }
        }
        walk::walk_binary_expression(self, it);
    }

    fn visit_switch_statement(&mut self, it: &SwitchStatement<'a>) {
        if let Some(prop) = discriminant(&it.discriminant) {
            for case in &it.cases {
                if let Some(value) = case.test.as_ref().and_then(string) {
                    self.add(Kind::Branch, format!("{prop} === \"{value}\""), case.span);
                }
            }
        }
        walk::walk_switch_statement(self, it);
    }
}

fn sites(path: &str, src: &str) -> Vec<Site> {
    crate::js::parse(path, src, |program| {
        let mut c = Collector { src, lines: Lines::new(src), sites: vec![] };
        c.visit_program(program);
        c.sites
    })
    .unwrap_or_default()
}

/// An env module: the one place a project reads and validates its environment, which is what the finding asks for.
pub fn is_env_module(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    let stem = name.split('.').next().unwrap_or(name);
    matches!(stem, "env" | "config" | "settings" | "environment") || file.contains("/env/") || file.contains("/config/")
}

/// The package a file belongs to: the nearest folder above it with a package.json, or the repository. Separate
/// packages of a monorepo are separate programs, each entitled to read its own environment and make its own decisions.
pub fn package_of(root: &str, file: &str, cache: &mut std::collections::HashMap<String, String>) -> String {
    let mut dir = file.rsplit_once('/').map_or("", |(d, _)| d).to_string();
    let start = dir.clone();
    loop {
        if let Some(p) = cache.get(&dir) {
            let p = p.clone();
            cache.insert(start, p.clone());
            return p;
        }
        if dir.is_empty() || std::path::Path::new(root).join(&dir).join("package.json").exists() {
            cache.insert(start, dir.clone());
            return dir;
        }
        dir = dir.rsplit_once('/').map_or("", |(d, _)| d).to_string();
    }
}

/// A file and one site in it.
type Located = (String, Site);
/// Package, kind, subject (the variable, flag or property) and the files it is in.
type MergeKey<'a> = (String, Kind, String, Vec<&'a str>);

pub fn run(request: &Request) -> Result<Answer, String> {
    let all: Vec<(String, Site)> = request
        .files
        .par_iter()
        .filter_map(|file| Some(sites(file, &text::read(&request.root, file)?).into_iter().map(|s| (file.clone(), s)).collect::<Vec<_>>()))
        .flatten()
        .collect();
    let mut packages = std::collections::HashMap::new();
    let mut groups: BTreeMap<(String, Kind, String), Vec<&Located>> = BTreeMap::new();
    for s in &all {
        if s.1.kind == Kind::Env && is_env_module(&s.0) {
            continue;
        }
        groups.entry((package_of(&request.root, &s.0, &mut packages), s.1.kind, s.1.key.clone())).or_default().push(s);
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
        let mut places: Vec<String> = files.iter().filter(|f| **f != file.as_str()).map(|f| {
            let line = list.iter().find(|(g, _)| g == f).map_or(0, |(_, s)| s.line);
            format!("{f}:{line}")
        }).collect();
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
            target: format!("decisions:{}:{slug}", match kind { Kind::Env => "env", Kind::Flag => "flag", Kind::Branch => "branch" }),
            message: format!("{file}:{} {what} (also {elsewhere}): {fix}", site.line),
        });
    }
    Ok(Answer { findings, summary: format!("{} environment reads, flag checks and variant branches in {} files", all.len(), request.files.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_env_reads_flags_and_variant_branches() {
        let s = sites("a.ts", "const k = process.env.STRIPE_KEY;\nconst m = process.env.NODE_ENV;\nif (isEnabled('new-checkout')) go();\nif (event.kind === 'refund') undo();\nswitch (shape.type) { case 'circle': break; default: }\nconst e = import.meta.env['VITE_API'];\n");
        let got: Vec<(u32, String)> = s.iter().map(|s| (s.line, s.key.clone())).collect();
        assert_eq!(got, vec![(1, "STRIPE_KEY".into()), (3, "new-checkout".into()), (4, ".kind === \"refund\"".into()), (5, ".type === \"circle\"".into()), (6, "VITE_API".into())]);
    }
}
