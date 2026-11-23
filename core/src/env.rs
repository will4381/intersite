//! The env check: a read of an environment variable the project declares nowhere. When a project lists its variables
//! (an `.env.example`-style template, a t3-env `createEnv`, a zod or valibot schema of UPPER_CASE keys in its env module,
//! envalid's `cleanEnv`), a new read of a name missing from every list is a typo or a variable invented on the spot,
//! and the deploy will not have it. Deployment files (wrangler, turbo, Docker, compose, CI workflows, fly, render,
//! netlify) also count as declaring the names they set, but do not turn the check on by themselves.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use oxc_syntax::operator::LogicalOperator;
use rayon::prelude::*;
use regex::Regex;
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use crate::decisions::{is_env_module, is_env_object, string};
use crate::text::{self, Lines};
use crate::{Answer, Finding, Request};

/// Variables set by the platform, the runtime or the tooling, never by the project's own deploy.
const EXEMPT: [&str; 44] = [
    "NODE_ENV", "CI", "PORT", "HOST", "HOSTNAME", "TZ", "HOME", "PATH", "PWD", "USER", "SHELL", "TERM", "LANG", "DEBUG", "TMPDIR",
    "NODE_OPTIONS", "NODE_DEBUG", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "NEXT_RUNTIME", "NEXT_PHASE", "ANALYZE",
    "SKIP_ENV_VALIDATION", "FORCE_COLOR", "NO_COLOR", "INIT_CWD", "JEST_WORKER_ID", "VITEST", "TEST", "DYNO", "K_SERVICE",
    "LAMBDA_TASK_ROOT", "AWS_REGION", "AWS_EXECUTION_ENV", "CODESPACES", "EDITOR", "VISUAL", "XDG_CONFIG_HOME", "APPDATA",
    "LOCALAPPDATA", "USERPROFILE",
];
const EXEMPT_PREFIX: [&str; 16] = [
    "npm_", "VERCEL", "NEXT_PUBLIC_VERCEL", "VITE_VERCEL", "NETLIFY", "CF_PAGES", "RENDER", "RAILWAY_", "FLY_", "GITHUB_",
    "RUNNER_", "HEROKU_", "AWS_LAMBDA_", "VITEST_", "PLAYWRIGHT_", "GITPOD_",
];

fn exempt(name: &str) -> bool {
    EXEMPT.contains(&name) || EXEMPT_PREFIX.iter().any(|p| name.starts_with(p)) || !name.bytes().any(|b| b.is_ascii_uppercase())
}

static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=").unwrap());
static UPPER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[A-Z][A-Z0-9_]{2,}\b").unwrap());
static UPPER_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]*$").unwrap());

/// Templates that list a project's variables: their presence turns the check on.
fn template(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (lower.starts_with(".env") && ["example", "sample", "template", "defaults", "dist", "schema"].iter().any(|w| lower.contains(w)))
        || matches!(lower.as_str(), "example.env" | "sample.env" | ".dev.vars.example" | ".env" | ".env.development" | ".env.production")
}

/// Files that set or pass variables for a deploy: what they name is declared, but they do not turn the check on.
fn deploy_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.starts_with(".env")
        || name == ".dev.vars"
        || matches!(name, "wrangler.toml" | "wrangler.json" | "wrangler.jsonc" | "turbo.json" | "fly.toml" | "render.yaml" | "netlify.toml" | "app.json" | "vercel.json" | "railway.json" | "railway.toml" | "Procfile" | "serverless.yml" | "serverless.yaml")
        || name.starts_with("Dockerfile")
        || name.starts_with("docker-compose")
        || name.starts_with("compose.")
        || path.contains(".github/workflows/")
        || path.contains(".gitlab-ci")
}

struct Read {
    name: String,
    line: u32,
    defaulted: bool,
}

#[derive(Default)]
struct Facts {
    reads: Vec<Read>,
    /// Names an env schema in this file declares.
    schema: Vec<String>,
}

struct Collector<'s> {
    src: &'s str,
    lines: Lines,
    facts: Facts,
    env_module: bool,
    defaulted: HashSet<u32>,
    assigned: HashSet<u32>,
}

fn keys(o: &ObjectExpression) -> Vec<String> {
    o.properties
        .iter()
        .filter_map(|p| match p {
            ObjectPropertyKind::ObjectProperty(p) => p.key.static_name().map(|k| k.to_string()),
            _ => None,
        })
        .collect()
}

impl Collector<'_> {
    fn text(&self, span: oxc_span::Span) -> &str {
        &self.src[span.start as usize..span.end as usize]
    }

    fn read(&mut self, name: String, span: oxc_span::Span) {
        if self.assigned.contains(&span.start) {
            return;
        }
        let line = self.lines.line(span.start as usize);
        let defaulted = self.defaulted.contains(&span.start) || self.src[span.end as usize..].starts_with("?.");
        self.facts.reads.push(Read { name, line, defaulted });
    }
}

impl<'a> Visit<'a> for Collector<'_> {
    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        self.assigned.insert(it.left.span().start);
        walk::walk_assignment_expression(self, it);
    }

    fn visit_logical_expression(&mut self, it: &LogicalExpression<'a>) {
        // Every operand of `a || b ?? c` but the last has a fallback.
        if matches!(it.operator, LogicalOperator::Coalesce | LogicalOperator::Or) && !matches!(&it.right, Expression::Identifier(i) if i.name == "undefined") {
            let mut left = &it.left;
            loop {
                self.defaulted.insert(left.span().start);
                match left.without_parentheses() {
                    Expression::LogicalExpression(l) if matches!(l.operator, LogicalOperator::Coalesce | LogicalOperator::Or) => {
                        self.defaulted.insert(l.right.span().start);
                        left = &l.left;
                    }
                    _ => break,
                }
            }
        }
        walk::walk_logical_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if is_env_object(self.text(it.object.span())) {
            self.read(it.property.name.to_string(), it.span);
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        if is_env_object(self.text(it.object.span())) {
            if let Some(name) = string(&it.expression) {
                self.read(name, it.span);
            }
        }
        walk::walk_computed_member_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (BindingPattern::ObjectPattern(o), Some(init)) = (&it.id, &it.init) {
            if is_env_object(self.text(init.span())) {
                for p in &o.properties {
                    if let Some(k) = p.key.static_name() {
                        let line = self.lines.line(p.span.start as usize);
                        let defaulted = matches!(p.value, BindingPattern::AssignmentPattern(_));
                        self.facts.reads.push(Read { name: k.to_string(), line, defaulted });
                    }
                }
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let callee = self.text(it.callee.span()).to_string();
        let args: Vec<&Expression> = it.arguments.iter().filter_map(|a| a.as_expression()).collect();
        if callee == "Deno.env.get" {
            if let Some(name) = args.first().and_then(|a| string(a)) {
                self.read(name, it.span);
            }
        }
        let last = callee.rsplit('.').next().unwrap_or("");
        if last == "createEnv" {
            if let Some(Expression::ObjectExpression(o)) = args.first() {
                for p in &o.properties {
                    if let ObjectPropertyKind::ObjectProperty(p) = p {
                        if matches!(p.key.static_name().as_deref(), Some("server" | "client" | "shared" | "runtimeEnv" | "experimental__runtimeEnv" | "vars")) {
                            if let Expression::ObjectExpression(inner) = &p.value {
                                self.facts.schema.extend(keys(inner));
                            }
                        }
                    }
                }
            }
        } else if last == "cleanEnv" {
            if let Some(Expression::ObjectExpression(o)) = args.get(1) {
                self.facts.schema.extend(keys(o));
            }
        } else if self.env_module && matches!(last, "object" | "strictObject" | "looseObject" | "Object" | "extend" | "merge") {
            if let Some(Expression::ObjectExpression(o)) = args.first() {
                let k = keys(o);
                if k.len() >= 2 && k.iter().all(|k| UPPER_KEY.is_match(k)) {
                    self.facts.schema.extend(k);
                }
            }
        }
        walk::walk_call_expression(self, it);
    }
}

fn collect(path: &str, src: &str) -> Option<Facts> {
    crate::js::parse(path, src, |program| {
        let mut c = Collector { src, lines: Lines::new(src), facts: Facts::default(), env_module: is_env_module(path), defaulted: HashSet::new(), assigned: HashSet::new() };
        c.visit_program(program);
        c.facts
    })
}

/// Names a deployment file sets: `KEY=` lines in env files, any UPPER_CASE word elsewhere.
fn declared_in(path: &str, text: &str) -> Vec<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.starts_with(".env") || name.starts_with(".dev.vars") || name.ends_with(".env") {
        ASSIGNMENT.captures_iter(text).map(|c| c[1].to_string()).collect()
    } else {
        UPPER.find_iter(text).map(|m| m.as_str().to_string()).collect()
    }
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != *cb)).min(row[j] + 1).min(row[j + 1] + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

fn dir(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |d| d.0)
}

/// Whether `ancestor` is `path`'s folder or one above it ("" is the repository top).
fn within(path: &str, ancestor: &str) -> bool {
    ancestor.is_empty() || path.starts_with(&format!("{ancestor}/"))
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let product: HashSet<&str> = request.options.get("product").and_then(|p| p.as_array()).map(|a| a.iter().filter_map(|s| s.as_str()).collect()).unwrap_or_default();
    let code: Vec<&String> = request.files.iter().filter(|f| product.contains(f.as_str())).collect();
    let facts: Vec<(&String, Facts)> = code.par_iter().filter_map(|f| Some((*f, collect(f, &text::read(&request.root, f)?)?))).collect();

    let mut declared: HashSet<String> = HashSet::new();
    let mut wildcards: Vec<String> = Vec::new();
    // Where the check is on, and the source to name: (folder, source path).
    let mut triggers: Vec<(String, String)> = Vec::new();
    for f in request.files.iter().filter(|f| deploy_file(f)) {
        let Some(text) = text::read(&request.root, f) else { continue };
        let name = f.rsplit('/').next().unwrap_or(f);
        if template(name) {
            triggers.push((dir(f).to_string(), f.clone()));
        }
        if name == "turbo.json" {
            static WILD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([A-Z][A-Z0-9_]*)\*""#).unwrap());
            wildcards.extend(WILD.captures_iter(&text).map(|c| c[1].to_string()));
        }
        declared.extend(declared_in(f, &text));
    }
    let mut cache = std::collections::HashMap::new();
    for (f, fx) in &facts {
        if !fx.schema.is_empty() {
            declared.extend(fx.schema.iter().cloned());
            triggers.push((crate::decisions::package_of(&request.root, f, &mut cache), (*f).clone()));
        }
    }
    let names: Vec<&String> = {
        let mut v: Vec<&String> = declared.iter().collect();
        v.sort();
        v
    };

    let mut findings: BTreeMap<String, (Finding, usize)> = BTreeMap::new();
    let mut checked = 0;
    for (f, fx) in &facts {
        // The nearest declaring source above the file; none means the project does not list its variables here.
        let Some((_, source)) = triggers.iter().rev().filter(|(d, _)| within(f, d)).max_by_key(|(d, _)| d.len()) else { continue };
        let name = f.rsplit('/').next().unwrap_or(f);
        if ["vitest", "jest", "playwright", "cypress", "setupTests", "test-setup", "setup-tests"].iter().any(|t| name.starts_with(t)) {
            continue;
        }
        let edge = f.contains("supabase/functions/");
        for r in &fx.reads {
            // Supabase sets these in every Edge Function.
            if !request.changed(f, r.line) || exempt(&r.name) || (edge && r.name.starts_with("SUPABASE_")) {
                continue;
            }
            checked += 1;
            if declared.contains(&r.name) || wildcards.iter().any(|w| r.name.starts_with(w)) {
                continue;
            }
            // A misspelling is one or two letters off a declared name; one the file also reads is a deliberate
            // alternative (`IDS || ID`), not a typo.
            let limit = if r.name.len() < 10 { 1 } else { 2 };
            let close = names.iter().map(|n| (distance(&r.name, n), *n)).filter(|(d, n)| *d > 0 && *d <= limit && !fx.reads.iter().any(|o| &o.name == *n)).min();
            // A variable read with a fallback is optional: the deploy needs it only when it is a misspelling.
            if r.defaulted && close.is_none() {
                continue;
            }
            let hint = close.map(|(_, n)| format!(" (did you mean {n}?)")).unwrap_or_default();
            let shown_source = crate::rel(&request.prefix, source);
            let message = format!("{f}:{} {} is not declared in {shown_source}{hint}: fix the name if it is a typo, or list it there so whoever deploys knows to set it", r.line, r.name);
            findings.entry(r.name.clone()).and_modify(|e| e.1 += 1).or_insert((Finding { file: (*f).clone(), line: r.line, target: format!("env:{}", r.name), message }, 0));
        }
    }
    let mut findings: Vec<Finding> = findings
        .into_values()
        .map(|(mut f, more)| {
            if more > 0 {
                f.message = f.message.replacen(" is not declared", &format!(" (read {} times) is not declared", more + 1), 1);
            }
            f
        })
        .collect();
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    Ok(Answer { findings, summary: format!("{checked} environment reads checked against {} declared names", declared.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_reads_and_schema_keys() {
        let f = collect("src/env.ts", "export const env = createEnv({ server: { DATABASE_URL: z.string() }, client: { NEXT_PUBLIC_URL: z.string() } });\nconst a = process.env.STRIPE_KEY;\nconst b = process.env.LOG_LEVEL ?? 'info';\nconst { RESEND_KEY, MAX = '3' } = process.env;\nprocess.env.TZ = 'UTC';\nconst c = import.meta.env['VITE_API'];\n").unwrap();
        let reads: Vec<(&str, u32, bool)> = f.reads.iter().map(|r| (r.name.as_str(), r.line, r.defaulted)).collect();
        assert_eq!(reads, vec![("STRIPE_KEY", 2, false), ("LOG_LEVEL", 3, true), ("RESEND_KEY", 4, false), ("MAX", 4, true), ("VITE_API", 6, false)]);
        assert_eq!(f.schema, vec!["DATABASE_URL", "NEXT_PUBLIC_URL"]);
    }

    #[test]
    fn reads_templates_and_suggests_close_names() {
        assert_eq!(declared_in(".env.example", "# Stripe\nSTRIPE_WEBHOOK_SECRET=\nexport RESEND_KEY=x\n# OPTIONAL_FLAG=1\n"), vec!["STRIPE_WEBHOOK_SECRET", "RESEND_KEY", "OPTIONAL_FLAG"]);
        assert_eq!(distance("STRIPE_WEBHOOK_SECRT", "STRIPE_WEBHOOK_SECRET"), 1);
        assert!(template(".env.local.example") && template(".dev.vars.example") && !template(".env.test"));
    }
}
