//! The tamper check: a change that weakens what judges the code instead of fixing the code. A strict type option
//! turned off, a lint rule downgraded or a path ignored, a gate or lint pack dropped, a baseline grown, a test
//! runner told to skip files, pass with no tests, retry or accept lower coverage, a CI step that ran the checks
//! removed or allowed to fail, and coverage-ignore pragmas or `process.exit(0)` added. The Node side passes each
//! changed evaluator file's text on the base and now; `hook` judges one proposed edit the same way.

use oxc_ast::ast::*;
use oxc_ast_visit::Visit;
use oxc_span::GetSpan;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::LazyLock;

use crate::graph::{basename, jsonc};
use crate::{Answer, Finding, Request};

/// One weakening: the key it is acknowledged by, and what weakened.
pub struct Weakening {
    pub key: String,
    pub what: String,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Defaults {
    run: Vec<String>,
    packs: Vec<String>,
    test_paths: Vec<String>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    defaults: Defaults,
    /// The lint and gates baseline files the config names.
    baselines: Vec<String>,
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum Kind {
    TsConfig,
    Lint,
    Intersite,
    Baseline,
    TestRunner,
    Package,
    Workflow,
    Source,
}

static TSCONFIG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[jt]sconfig(?:\.[\w.-]+)?\.json$").unwrap());
static LINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\.?oxlintrc(?:\.[\w-]+)?\.jsonc?|eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:json|jsonc|js|cjs|mjs|ya?ml))?|biome\.jsonc?|\.swiftlint\.ya?ml)$").unwrap()
});
static RUNNER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:vitest\.(?:config|workspace)|vite\.config|jest\.config|playwright\.config|stryker\.(?:conf|config))\.[\w.]+$").unwrap()
});
static WORKFLOW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)\.github/workflows/[^/]+\.ya?ml$").unwrap());
static SOURCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:[cm]?[jt]sx?|swift)$").unwrap());

fn kind(path: &str, ctx: &Context) -> Option<Kind> {
    let name = basename(path);
    if ctx.baselines.iter().any(|b| b == path || basename(b) == name && path.ends_with(b.as_str())) {
        return Some(Kind::Baseline);
    }
    if TSCONFIG.is_match(name) {
        Some(Kind::TsConfig)
    } else if LINT.is_match(name) {
        Some(Kind::Lint)
    } else if matches!(name, "intersite.yml" | "intersite.yaml" | "intersite.json") {
        Some(Kind::Intersite)
    } else if RUNNER.is_match(name) {
        Some(Kind::TestRunner)
    } else if name == "package.json" {
        Some(Kind::Package)
    } else if WORKFLOW.is_match(path) {
        Some(Kind::Workflow)
    } else if SOURCE.is_match(name) {
        Some(Kind::Source)
    } else {
        None
    }
}

// ---------- reading configs into one JSON shape ----------

fn yaml(text: &str) -> Option<Value> {
    serde_yaml::from_str::<Value>(text).ok()
}

/// The object literals of a JavaScript config that sit in no other object literal (`defineConfig({…})`, each entry
/// of a flat ESLint config array, `module.exports = {…}`), as one JSON array. What is not a literal becomes its
/// source text, so a changed expression still reads as changed.
fn js_config(path: &str, src: &str) -> Option<Value> {
    struct Objects<'s> {
        src: &'s str,
        found: Vec<Value>,
    }
    impl<'s> Objects<'s> {
        fn text(&self, span: oxc_span::Span) -> String {
            self.src[span.start as usize..span.end as usize].to_string()
        }
        fn object(&self, o: &ObjectExpression) -> Value {
            let mut map = Map::new();
            for p in &o.properties {
                match p {
                    ObjectPropertyKind::ObjectProperty(p) => {
                        let key = match &p.key {
                            PropertyKey::StaticIdentifier(id) => id.name.to_string(),
                            PropertyKey::StringLiteral(s) => s.value.to_string(),
                            PropertyKey::NumericLiteral(n) => n.value.to_string(),
                            k => format!("[{}]", self.text(k.span())),
                        };
                        map.insert(key, self.value(&p.value));
                    }
                    ObjectPropertyKind::SpreadProperty(s) => {
                        map.insert(format!("...{}", self.text(s.argument.span())), Value::Null);
                    }
                }
            }
            Value::Object(map)
        }
        fn value(&self, e: &Expression) -> Value {
            match e {
                Expression::ObjectExpression(o) => self.object(o),
                Expression::ArrayExpression(a) => Value::Array(
                    a.elements
                        .iter()
                        .map(|el| match el {
                            ArrayExpressionElement::SpreadElement(s) => Value::String(format!("...{}", self.text(s.argument.span()))),
                            ArrayExpressionElement::Elision(_) => Value::Null,
                            other => match other.as_expression() {
                                Some(e) => self.value(e),
                                None => Value::Null,
                            },
                        })
                        .collect(),
                ),
                Expression::StringLiteral(s) => Value::String(s.value.to_string()),
                Expression::NumericLiteral(n) => serde_json::Number::from_f64(n.value).map_or(Value::Null, Value::Number),
                Expression::BooleanLiteral(b) => Value::Bool(b.value),
                Expression::NullLiteral(_) => Value::Null,
                Expression::TemplateLiteral(t) if t.expressions.is_empty() => {
                    Value::String(t.quasis.iter().map(|q| q.value.raw.to_string()).collect())
                }
                Expression::UnaryExpression(u) if u.operator == UnaryOperator::UnaryNegation => match self.value(&u.argument) {
                    Value::Number(n) => serde_json::Number::from_f64(-n.as_f64().unwrap_or(0.0)).map_or(Value::Null, Value::Number),
                    _ => Value::String(self.text(u.span)),
                },
                Expression::ParenthesizedExpression(p) => self.value(&p.expression),
                Expression::TSAsExpression(t) => self.value(&t.expression),
                Expression::TSSatisfiesExpression(t) => self.value(&t.expression),
                other => Value::String(self.text(other.span())),
            }
        }
    }
    impl<'a> Visit<'a> for Objects<'_> {
        fn visit_object_expression(&mut self, it: &ObjectExpression<'a>) {
            let v = self.object(it);
            self.found.push(v);
        }
    }
    crate::js::parse(path, src, |program| {
        let mut o = Objects { src, found: vec![] };
        o.visit_program(program);
        Value::Array(o.found)
    })
}

// ---------- flattening ----------

const SEP: char = '\u{1}';

#[derive(Debug, Clone, PartialEq)]
enum Leaf {
    Scalar(Value),
    Member,
}

fn scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A rule severity: 0 off, 1 warn, 2 error.
fn severity(v: &Value) -> Option<u8> {
    match v {
        Value::Number(n) => n.as_u64().filter(|n| *n <= 2).map(|n| n as u8),
        Value::String(s) => match s.to_ascii_lowercase().as_str() {
            "off" | "allow" | "none" => Some(0),
            "warn" | "warning" | "info" => Some(1),
            "error" | "deny" | "on" => Some(2),
            _ => None,
        },
        Value::Bool(b) => Some(if *b { 2 } else { 0 }),
        Value::Array(a) => a.first().and_then(severity),
        Value::Object(o) => o.get("level").and_then(severity),
        _ => None,
    }
}

fn under_rules(path: &[String]) -> bool {
    path.iter().any(|s| s == "rules" || s == "categories")
}

/// Every leaf as `path → value`; a list of scalars becomes one `path[]=value` member per entry, and an object in a
/// list is keyed by its `files` (an ESLint override) so inserting one does not shift the others.
fn flatten(v: &Value, path: &mut Vec<String>, out: &mut BTreeMap<String, Leaf>) {
    if under_rules(path) && !path.last().is_some_and(|l| l == "rules" || l == "categories") {
        if let (Some(_), true) = (severity(v), matches!(v, Value::Array(_) | Value::Object(_))) {
            out.insert(
                path.join(&SEP.to_string()),
                Leaf::Scalar(match v {
                    Value::Array(a) => a[0].clone(),
                    Value::Object(o) => o["level"].clone(),
                    _ => unreachable!(),
                }),
            );
            return;
        }
    }
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                path.push(k.clone());
                flatten(child, path, out);
                path.pop();
            }
        }
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::Object(o) => {
                        let files = o.get("files").map(|f| match f {
                            Value::Array(a) => a.iter().map(scalar_text).collect::<Vec<_>>().join(","),
                            other => scalar_text(other),
                        });
                        path.push(files.map_or("[]".to_string(), |f| format!("[files={f}]")));
                        let mut rest = o.clone();
                        rest.remove("files");
                        flatten(&Value::Object(rest), path, out);
                        path.pop();
                    }
                    Value::Array(_) => {
                        path.push("[]".into());
                        flatten(item, path, out);
                        path.pop();
                    }
                    scalar => {
                        let last = path.pop().unwrap_or_default();
                        path.push(format!("{last}[]={}", scalar_text(scalar)));
                        out.insert(path.join(&SEP.to_string()), Leaf::Member);
                        path.pop();
                        path.push(last);
                    }
                }
            }
        }
        scalar => {
            out.insert(path.join(&SEP.to_string()), Leaf::Scalar(scalar.clone()));
        }
    }
}

fn flat(v: &Value) -> BTreeMap<String, Leaf> {
    let mut out = BTreeMap::new();
    flatten(v, &mut vec![], &mut out);
    out
}

/// A path as people write it: `compilerOptions.strict`, `[files=**/*.test.ts].rules.no-console`.
fn shown(path: &str) -> String {
    path.split(SEP).filter(|s| *s != "[]").collect::<Vec<_>>().join(".")
}

/// A member key split into its list's path and the member: `ignorePatterns[]=dist` is (`ignorePatterns`, `dist`).
fn member(path: &str) -> Option<(String, String)> {
    let last = path.rsplit(SEP).next()?;
    let (list, value) = last.split_once("[]=")?;
    let parent = &path[..path.len() - last.len()];
    Some((format!("{parent}{list}"), value.to_string()))
}

fn last_key(path: &str) -> &str {
    path.rsplit(SEP).next().unwrap_or(path)
}

/// Built output, dependencies and tool caches: ignoring them hides nothing anyone wrote.
static OUTPUT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[/*!])(?:node_modules|dist|build|out|coverage|\.next|\.nuxt|\.output|\.svelte-kit|\.turbo|\.vercel|\.wrangler|\.cache|\.expo|\.git|\.claude|\.intersite|tmp|temp|generated|__generated__|gen|public|static|vendor|vendors|third[-_]?party|storybook-static|playwright-report|test-results|target|DerivedData|Pods|\.build|\.swiftpm|\.react-router|\.astro|\.docusaurus|lib-cjs|lib-esm|esm|cjs|types|typings|android|ios|reports?|logs?|\.husky)(?:/|$|\*)|\.d\.[cm]?ts\b|\.min\.|\.(?:map|snap|lock|log|md|mdx|json|ya?ml|css|scss|svg|png|jpe?g|gif|webp|ico|html?)\b|(?:^|/)\*\*?/?\*?\.?[cm]?js$|\.config\.|routeTree\.gen|\.gen\.|worker-configuration|next-env|env\.d\.ts|-lock\.|lockfile|(?:^|/)components/ui(?:/|$)|(?:^|/)hooks/use-mobile\.tsx?$|^\.\.\.").unwrap()
});
/// Tests, stories and scripts: a build's tsconfig leaves them out on purpose.
static TEST_LIKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)test|spec|e2e|stories|story|cypress|playwright|fixture|mock|scripts?\b|bench|examples?\b|demo|docs?\b|\.config|vitest|jest|setup").unwrap()
});

static E2E: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)e2e|playwright|cypress").unwrap());

/// Lists whose new entries hide files from the check.
const IGNORE_LISTS: [&str; 10] = [
    "ignorePatterns",
    "ignores",
    "ignore",
    "exclude",
    "excluded",
    "testPathIgnorePatterns",
    "coveragePathIgnorePatterns",
    "modulePathIgnorePatterns",
    "testIgnore",
    "disabled_rules",
];
/// Lists whose lost entries stop the check from covering something.
const COVER_LISTS: [&str; 7] = ["include", "includes", "testMatch", "roots", "extends", "plugins", "opt_in_rules"];

const STRICT_FAMILY: [&str; 8] = [
    "noImplicitAny",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "noImplicitThis",
    "alwaysStrict",
    "useUnknownInCatchVariables",
];
const STRICT_EXTRA: [&str; 6] = [
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noImplicitOverride",
    "checkJs",
];

fn covers(kept: &str, lost: &str) -> bool {
    let k = kept.trim_start_matches("./").trim_end_matches("/**/*").trim_end_matches("/**").trim_end_matches('/');
    let l = lost.trim_start_matches("./");
    k == "**" || k == "." || l.starts_with(&format!("{k}/")) || l == k
}

fn number(v: &Leaf) -> Option<f64> {
    match v {
        Leaf::Scalar(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

/// The largest number written in a retry setting, including inside `process.env.CI ? 2 : 0`.
fn retry_count(v: Option<&Leaf>) -> f64 {
    static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d+\b").unwrap());
    match v {
        Some(Leaf::Scalar(Value::Number(n))) => n.as_f64().unwrap_or(0.0),
        Some(Leaf::Scalar(Value::String(s))) => DIGITS.find_iter(s).filter_map(|m| m.as_str().parse().ok()).fold(0.0, f64::max),
        _ => 0.0,
    }
}

fn sev_name(s: u8) -> &'static str {
    ["off", "warn", "error"][s as usize]
}

/// The weakenings between two flattened configs, for the rules every config kind shares.
fn compare(kind: Kind, before: &BTreeMap<String, Leaf>, now: &BTreeMap<String, Leaf>, out: &mut Vec<Weakening>) {
    let mut push = |key: String, what: String| out.push(Weakening { key, what });
    let path_of = |k: &str| k.split(SEP).map(str::to_string).collect::<Vec<_>>();
    // An override for vendored primitives or a tool's own config file (`files: ["components/ui/**"]`) hides nothing
    // anyone writes.
    let vendored = |k: &str| {
        k.split(SEP)
            .any(|s| s.strip_prefix("[files=").and_then(|f| f.strip_suffix(']')).is_some_and(|f| f.split(',').all(|g| OUTPUT.is_match(g))))
    };

    // Rule severities lowered, removed or newly turned off.
    for (k, was) in before {
        if !under_rules(&path_of(k)) || matches!(was, Leaf::Member) || vendored(k) {
            continue;
        }
        let Leaf::Scalar(was_v) = was else { continue };
        let Some(was_s) = severity(was_v) else { continue };
        let is_switch = matches!(last_key(k), "recommended" | "all");
        if !is_switch && matches!(was_v, Value::Bool(_)) {
            continue;
        }
        match now.get(k) {
            Some(Leaf::Scalar(v)) => {
                if let Some(s) = severity(v) {
                    if s < was_s {
                        push(shown(k), format!("{} lowered from {} to {}", shown(k), sev_name(was_s), sev_name(s)));
                    }
                }
            }
            None if was_s > 0 && !is_switch => push(shown(k), format!("{} ({}) removed", shown(k), sev_name(was_s))),
            _ => {}
        }
    }
    for (k, v) in now {
        if before.contains_key(k) || !under_rules(&path_of(k)) || vendored(k) {
            continue;
        }
        if let Leaf::Scalar(v) = v {
            if !matches!(v, Value::Bool(_)) && severity(v) == Some(0) {
                push(shown(k), format!("{} turned off", shown(k)));
            }
        }
    }

    // Entries added to an ignore list, and entries a coverage list lost.
    let lists = |m: &BTreeMap<String, Leaf>| -> BTreeMap<String, BTreeSet<String>> {
        let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for k in m.keys() {
            if let Some((list, value)) = member(k) {
                out.entry(list).or_default().insert(value);
            }
        }
        out
    };
    let (was_lists, now_lists) = (lists(before), lists(now));
    for (list, entries) in &now_lists {
        let name = last_key(list);
        let empty = BTreeSet::new();
        let was = was_lists.get(list).unwrap_or(&empty);
        let negations = name == "includes" || name == "include" && kind == Kind::Lint;
        if !IGNORE_LISTS.contains(&name) && !negations {
            continue;
        }
        for e in entries.difference(was) {
            if negations && !e.starts_with('!') {
                continue;
            }
            // A unit runner leaving end-to-end suites to their own runner (Playwright, Cypress) narrows nothing.
            if OUTPUT.is_match(e) || kind == Kind::TsConfig && TEST_LIKE.is_match(e) || kind == Kind::TestRunner && E2E.is_match(e) {
                continue;
            }
            // A lint tool told to skip tests skips the rules that keep them honest; anything else hides source.
            let what =
                if name == "disabled_rules" { format!("SwiftLint rule {e} disabled") } else { format!("{} now ignores {e}", shown(list)) };
            push(format!("{}:{e}", shown(list)), what);
        }
    }
    for (list, entries) in &was_lists {
        let name = last_key(list);
        if !COVER_LISTS.contains(&name) {
            continue;
        }
        let empty = BTreeSet::new();
        let kept = now_lists.get(list).unwrap_or(&empty);
        if kept.is_empty() && !now.keys().any(|k| k.starts_with(list.as_str())) && name != "extends" && name != "plugins" {
            // The whole list went away: back to the tool's default, which is usually everything.
            continue;
        }
        for e in entries.difference(kept) {
            if e.starts_with('!') || OUTPUT.is_match(e) || kept.iter().any(|k| covers(k, e)) {
                continue;
            }
            // An ESLint `extends`/`plugins` entry renamed to its newer spelling is a move, not a loss.
            let stem = |s: &str| s.trim_start_matches("plugin:").trim_start_matches("...").replace(['@', '/', '-', '.'], "").to_lowercase();
            if (name == "extends" || name == "plugins") && kept.iter().any(|k| stem(k).contains(&stem(e)) || stem(e).contains(&stem(k))) {
                continue;
            }
            let what = match name {
                "extends" => format!("{} no longer extends {e}", shown(list)),
                "plugins" => format!("{} no longer loads {e}", shown(list)),
                "opt_in_rules" => format!("SwiftLint rule {e} no longer opted in"),
                _ => format!("{} no longer covers {e}", shown(list)),
            };
            push(format!("{}:{e}", shown(list)), what);
        }
    }

    // Coverage thresholds lowered or removed.
    for (k, was) in before {
        if !k.to_ascii_lowercase().contains("threshold") {
            continue;
        }
        let Some(was_n) = number(was) else { continue };
        match now.get(k).and_then(number) {
            Some(n) if n < was_n => push(shown(k), format!("{} lowered from {was_n} to {n}", shown(k))),
            None if now.get(k).is_none() => push(shown(k), format!("{} ({was_n}) removed", shown(k))),
            _ => {}
        }
    }

    // A runner told to pass with no tests, or to retry.
    for (k, v) in now {
        let last = last_key(k);
        if last == "passWithNoTests" && *v == Leaf::Scalar(Value::Bool(true)) && before.get(k) != Some(v) {
            push(shown(k), format!("{} turned on: a run that finds no tests now passes", shown(k)));
        }
        if (last == "retry" || last == "retries") && retry_count(Some(v)) > retry_count(before.get(k)) {
            push(shown(k), format!("{} raised to {}: a failing test now passes if it passes once", shown(k), retry_count(Some(v))));
        }
    }
}

/// Strict type options turned off. A family option off by omission still counts as on while `strict` is on.
fn compare_tsconfig(before: &Value, now: &Value, out: &mut Vec<Weakening>) {
    let opts = |v: &Value| v.get("compilerOptions").cloned().unwrap_or(Value::Null);
    let (b, n) = (opts(before), opts(now));
    let extends = now.get("extends").is_some();
    let get = |o: &Value, k: &str| o.get(k).and_then(Value::as_bool);
    let effective = |o: &Value, k: &str| get(o, k).or_else(|| STRICT_FAMILY.contains(&k).then(|| get(o, "strict")).flatten());
    for k in std::iter::once("strict").chain(STRICT_FAMILY).chain(STRICT_EXTRA) {
        // A family option that follows `strict` on both sides is reported once, as `strict`.
        if effective(&b, k) != Some(true) || k != "strict" && STRICT_FAMILY.contains(&k) && get(&b, k).is_none() && get(&n, k).is_none() {
            continue;
        }
        match effective(&n, k) {
            Some(false) => out.push(Weakening { key: format!("compilerOptions.{k}"), what: format!("compilerOptions.{k} turned off") }),
            // Gone with an `extends` left: the base config may set it, so it is not known to be off.
            None if !extends => {
                out.push(Weakening { key: format!("compilerOptions.{k}"), what: format!("compilerOptions.{k} removed (it was on)") })
            }
            _ => {}
        }
    }
}

// ---------- package.json scripts ----------

static CHECK_SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:test|tests|check|lint|typecheck|type-check|types|tsc|ci|verify|validate)(?::[\w:-]+)?$").unwrap());
/// What makes a check command pass more easily: its failure swallowed, no tests counted as a pass, or fewer tests or
/// files run (only those changed or related, matching a name, minus an exclusion), or warnings hidden from a limit.
static FORGIVING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\|\|\s*(?:true\b|exit\s+0\b|:\s*(?:$|[;&|)]))|;\s*exit\s+0\b|--passWithNoTests\b|--pass-with-no-tests\b|--no-error-on-unmatched-pattern\b|\bcontinue-on-error\b|--(?:changed|onlyChanged|only-changed|findRelatedTests|lastCommit|testNamePattern|test-name-pattern|grep|exclude|ignore-pattern|quiet)\b").unwrap()
});
static TRIVIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:echo\b[^&|;]*|exit\s+0|true|:)?\s*$").unwrap());
static PATH_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\w.@-]*(?:/|\*)[^\s]*$|^[\w.-]+\.(?:[cm]?[jt]sx?|swift|json)$|^(?:src|lib|app|apps|packages|test|tests|spec|e2e|server|client|components|pages|api|core|shared)$").unwrap()
});

fn forgiving(cmd: &str) -> Vec<String> {
    FORGIVING.find_iter(cmd).map(|m| m.as_str().trim().to_string()).collect()
}

/// What a check command lost or gained that makes it pass more easily: `|| true`, a path no longer given, a
/// `--max-warnings 0` dropped, or the whole command replaced by an echo.
fn command_weakened(before: &str, now: &str) -> Option<String> {
    let gained: Vec<String> = forgiving(now).into_iter().filter(|f| !forgiving(before).contains(f)).collect();
    if !gained.is_empty() {
        return Some(format!("gained `{}`", gained.join("`, `")));
    }
    if TRIVIAL.is_match(now) && !TRIVIAL.is_match(before) {
        return Some(format!("became `{}`", now.trim()));
    }
    let now_tokens: HashSet<&str> = now.split_whitespace().collect();
    let mut seen = HashSet::new();
    let lost: Vec<&str> = before
        .split_whitespace()
        .filter(|t| seen.insert(*t))
        .filter(|t| (PATH_TOKEN.is_match(t) || *t == "--max-warnings" || *t == "--strict") && !now_tokens.contains(t))
        .collect();
    // A path that moved (`src/a` → `src/b` beside it) is not a loss; one dropped with nothing in its place is.
    let gained_paths = now.split_whitespace().filter(|t| PATH_TOKEN.is_match(t) && !before.split_whitespace().any(|b| b == *t)).count();
    if !lost.is_empty() && (lost.iter().any(|t| t.starts_with("--")) || gained_paths < lost.len()) {
        return Some(format!("no longer runs on `{}`", lost.join("`, `")));
    }
    None
}

/// A script with each `npm run x` (pnpm, yarn, bun) it calls replaced by x's own command, so a script split into
/// steps reads as the commands it still runs.
fn expand(cmd: &str, scripts: &Map<String, Value>, depth: u32) -> String {
    static RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)").unwrap());
    if depth > 4 {
        return cmd.to_string();
    }
    RUN.replace_all(cmd, |c: &regex::Captures| match scripts.get(&c[1]).and_then(Value::as_str) {
        Some(inner) => format!("( {} )", expand(inner, scripts, depth + 1)),
        None => c[0].to_string(),
    })
    .into_owned()
}

fn compare_scripts(before: &Value, now: &Value, out: &mut Vec<Weakening>) {
    let Some(was) = before.get("scripts").and_then(Value::as_object) else { return };
    let none = Map::new();
    let now_scripts = now.get("scripts").and_then(Value::as_object);
    let is = now_scripts.unwrap_or(&none);
    // A step another check script runs is judged through that script: its loss shows there once.
    let called = |name: &str| {
        was.iter().any(|(other, c)| {
            other != name
                && CHECK_SCRIPT.is_match(other)
                && c.as_str()
                    .is_some_and(|c| Regex::new(&format!(r"\brun\s+{}(?:\s|$|&|;|\|)", regex::escape(name))).is_ok_and(|re| re.is_match(c)))
        })
    };
    for (name, cmd) in was {
        let (Some(cmd), true) = (cmd.as_str(), CHECK_SCRIPT.is_match(name)) else { continue };
        match now_scripts.and_then(|s| s.get(name)).and_then(Value::as_str) {
            None => {
                // Renamed is fine: the same command under another name still runs.
                if !is.values().any(|v| v.as_str() == Some(cmd)) && !called(name) {
                    out.push(Weakening { key: format!("scripts.{name}"), what: format!("script `{name}` (`{cmd}`) removed") });
                }
            }
            Some(n) if !called(name) => {
                if let Some(how) = command_weakened(&expand(cmd, was, 0), &expand(n, is, 0)) {
                    out.push(Weakening { key: format!("scripts.{name}"), what: format!("script `{name}` {how}") });
                }
            }
            Some(_) => {}
        }
    }
}

// ---------- CI workflows ----------

static VERIFY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:test|tests|lint|typecheck|type-check|tsc|vitest|jest|playwright|eslint|oxlint|biome|intersite|pytest|clippy|xcodebuild\b[^\n]*\btest|swift\s+test|go\s+(?:test|vet))\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check\b").unwrap()
});

struct Step {
    job: String,
    name: Option<String>,
    run: String,
    soft: bool,
}

fn falsy_if(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(false)) => true,
        Some(Value::String(s)) => {
            let s = s.trim().trim_start_matches("${{").trim_end_matches("}}").trim();
            s == "false" || s == "0"
        }
        _ => false,
    }
}

fn soft(v: &Value) -> bool {
    matches!(v.get("continue-on-error"), Some(Value::Bool(true)))
        || v.get("continue-on-error").and_then(Value::as_str).is_some_and(|s| s.trim() == "true")
        || falsy_if(v.get("if"))
}

fn steps(wf: &Value) -> Vec<Step> {
    let mut out = Vec::new();
    for (job, j) in wf.get("jobs").and_then(Value::as_object).into_iter().flatten() {
        let job_soft = soft(j);
        for s in j.get("steps").and_then(Value::as_array).into_iter().flatten() {
            let Some(run) = s.get("run").and_then(Value::as_str) else { continue };
            if !VERIFY.is_match(run) {
                continue;
            }
            out.push(Step {
                job: job.clone(),
                name: s.get("name").and_then(Value::as_str).map(str::to_string),
                run: run.split_whitespace().collect::<Vec<_>>().join(" "),
                soft: job_soft || soft(s),
            });
        }
    }
    out
}

/// The events a workflow runs on.
fn triggers(wf: &Value) -> BTreeSet<String> {
    // YAML 1.1 readers turn `on` into `true`; serde_yaml keeps it a string, but accept both.
    let on = wf.get("on").or_else(|| wf.get("true"));
    match on {
        Some(Value::String(s)) => [s.clone()].into(),
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Some(Value::Object(o)) => o.keys().cloned().collect(),
        _ => BTreeSet::new(),
    }
}

fn first_words(run: &str, n: usize) -> String {
    run.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}

fn compare_workflow(before: &Value, now: Option<&Value>, out: &mut Vec<Weakening>) {
    let was = steps(before);
    if was.is_empty() {
        return;
    }
    let Some(now) = now else {
        let cmds: Vec<String> = was.iter().map(|s| format!("`{}`", first_words(&s.run, 4))).collect();
        out.push(Weakening { key: "deleted".into(), what: format!("workflow deleted, and it ran {}", cmds.join(", ")) });
        return;
    };
    let is = steps(now);
    for t in ["pull_request", "push", "merge_group"] {
        if triggers(before).contains(t) && !triggers(now).contains(t) {
            out.push(Weakening { key: format!("on.{t}"), what: format!("no longer runs on {t}, so its checks stop running there") });
        }
    }
    for s in &was {
        let same = is.iter().find(|n| n.run == s.run);
        let like = same.or_else(|| {
            is.iter().find(|n| n.job == s.job && (s.name.is_some() && n.name == s.name || first_words(&n.run, 2) == first_words(&s.run, 2)))
        });
        let short = first_words(&s.run, 4);
        match like {
            None => {
                if !is.iter().any(|n| n.run.contains(&s.run)) {
                    out.push(Weakening { key: format!("{}:{short}", s.job), what: format!("step `{short}` in job {} removed", s.job) });
                }
            }
            Some(n) => {
                if n.soft && !s.soft {
                    out.push(Weakening {
                        key: format!("{}:{short}", s.job),
                        what: format!(
                            "step `{short}` in job {} may now fail without failing the run (continue-on-error or `if: false`)",
                            s.job
                        ),
                    });
                } else if let Some(how) = command_weakened(&s.run, &n.run) {
                    out.push(Weakening { key: format!("{}:{short}", s.job), what: format!("step `{short}` in job {} {how}", s.job) });
                }
            }
        }
    }
}

// ---------- intersite.yml and baselines ----------

fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
}

fn compare_intersite(before: &Value, now: &Value, d: &Defaults, out: &mut Vec<Weakening>) {
    let at = |v: &Value, a: &str, b: &str| v.get(a).and_then(|s| s.get(b)).cloned();
    let list = |v: &Value, a: &str, b: &str, default: &[String]| strings(at(v, a, b).as_ref()).unwrap_or_else(|| default.to_vec());
    for g in list(before, "gates", "run", &d.run) {
        if !list(now, "gates", "run", &d.run).contains(&g) {
            out.push(Weakening { key: format!("gates.run:{g}"), what: format!("gates.run no longer runs {g}") });
        }
    }
    for p in list(before, "lint", "packs", &d.packs) {
        if !list(now, "lint", "packs", &d.packs).contains(&p) {
            out.push(Weakening { key: format!("lint.packs:{p}"), what: format!("lint.packs no longer has {p}") });
        }
    }
    let was_paths = list(before, "gates", "testPaths", &d.test_paths);
    for p in list(now, "gates", "testPaths", &d.test_paths) {
        if !was_paths.contains(&p) && !TEST_LIKE.is_match(&p) {
            out.push(Weakening {
                key: format!("gates.testPaths:{p}"),
                what: format!("gates.testPaths now counts {p} as tests, which the source checks then skip"),
            });
        }
    }
    for (key, default) in [("typeAware", false), ("ownRules", true)] {
        let get = |v: &Value| at(v, "lint", key).and_then(|x| x.as_bool()).unwrap_or(default);
        if get(before) && !get(now) {
            out.push(Weakening { key: format!("lint.{key}"), what: format!("lint.{key} turned off") });
        }
    }
    // Lint rule overrides share the generic severity reading.
    let rules = |v: &Value| flat(&serde_json::json!({ "rules": at(v, "lint", "rules").unwrap_or(Value::Null) }));
    compare(Kind::Intersite, &rules(before), &rules(now), out);
    // Protected paths and the project's own checks: dropping one stops it running.
    let entries = |v: &Value, a: &str, key: &dyn Fn(&Value) -> Option<String>| -> BTreeSet<String> {
        v.get(a)
            .map(|x| if a == "gates" { x.get("protected").cloned().unwrap_or(Value::Null) } else { x.clone() })
            .and_then(|x| x.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(key)
            .collect()
    };
    let protected_key = |e: &Value| strings(e.get("paths")).map(|p| p.join(","));
    for p in entries(before, "gates", &protected_key).difference(&entries(now, "gates", &protected_key)) {
        out.push(Weakening { key: format!("gates.protected:{p}"), what: format!("gates.protected no longer protects {p}") });
    }
    let checks = |v: &Value| -> BTreeMap<String, bool> {
        v.get("checks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| Some((c.get("name")?.as_str()?.to_string(), c.get("slow").and_then(Value::as_bool).unwrap_or(false))))
            .collect()
    };
    let now_checks = checks(now);
    for (name, slow) in checks(before) {
        match now_checks.get(&name) {
            None => out.push(Weakening { key: format!("checks:{name}"), what: format!("project check {name} removed") }),
            Some(true) if !slow => out.push(Weakening {
                key: format!("checks:{name}"),
                what: format!("project check {name} marked slow, so check no longer runs it without --full"),
            }),
            _ => {}
        }
    }
}

/// How many findings a baseline holds: counts add up, list entries count one each.
fn baseline_size(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::Array(a) => a.iter().map(|x| if x.is_object() || x.is_array() { baseline_size(x) } else { 1.0 }).sum(),
        Value::Object(o) => o.values().map(baseline_size).sum(),
        _ => 0.0,
    }
}

// ---------- source pragmas ----------

static IGNORE_PRAGMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?://|/\*)\s*(?:istanbul|c8|v8|node:coverage)\s+(?:ignore|disable)\b").unwrap());
static EXIT_ZERO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bprocess\.exit\(\s*0?\s*\)").unwrap());

/// Coverage-ignore pragmas in comments: one quoted in a string (a test of this very check) hides nothing.
fn pragmas(text: &str) -> usize {
    let spans = crate::text::code_spans(text);
    IGNORE_PRAGMA.find_iter(text).filter(|m| spans.iter().any(|&(s, _, string)| !string && s == m.start())).count()
}

/// `process.exit(0)` in code, not in a string or comment.
fn exits(text: &str) -> usize {
    let spans = crate::text::code_spans(text);
    EXIT_ZERO.find_iter(text).filter(|m| !spans.iter().any(|&(s, e, _)| (s..e).contains(&m.start()))).count()
}

fn setup_like(path: &str) -> bool {
    let name = basename(path).to_ascii_lowercase();
    // A hand-written test script may end with process.exit; a runner's setup or teardown file never should.
    name.contains("setup") || name.contains("teardown")
}

// ---------- judging one file ----------

/// The weakenings in one file's change from `before` to `now` (`now` None when deleted).
pub fn judge(path: &str, before: &str, now: Option<&str>, ctx: &Context) -> Vec<Weakening> {
    let Some(kind) = kind(path, ctx) else { return vec![] };
    let mut out = Vec::new();
    if before.trim().is_empty() && kind != Kind::Source {
        return out;
    }
    let parse = |text: &str| -> Option<Value> {
        match kind {
            Kind::Workflow | Kind::Intersite if !text.trim_start().starts_with('{') => yaml(text),
            Kind::Lint
                if path.ends_with(".yml")
                    || path.ends_with(".yaml")
                    || basename(path) == ".eslintrc" && !text.trim_start().starts_with('{') =>
            {
                yaml(text)
            }
            Kind::TestRunner => js_config(path, text),
            Kind::Lint if !path.contains(".json") && basename(path) != ".eslintrc" => js_config(path, text),
            _ => jsonc(text),
        }
    };
    match kind {
        Kind::Source => {
            let now = now.unwrap_or("");
            if pragmas(now) > pragmas(before) {
                out.push(Weakening {
                    key: "coverage-ignore".into(),
                    what: format!("{} coverage-ignore pragma(s) added: they hide this code from coverage", pragmas(now) - pragmas(before)),
                });
            }
            if setup_like(path) && exits(now) > exits(before) {
                out.push(Weakening {
                    key: "process.exit".into(),
                    what: "`process.exit(0)` added to a test setup file: the run ends as passed before every test has run".into(),
                });
            }
        }
        Kind::Workflow => {
            let Some(b) = parse(before) else { return out };
            let n = now.and_then(parse);
            if now.is_some() && n.is_none() {
                return out;
            }
            compare_workflow(&b, n.as_ref(), &mut out);
        }
        Kind::Baseline => {
            let (Some(b), Some(n)) = (jsonc(before), now.and_then(jsonc)) else { return out };
            let (was, is) = (baseline_size(&b), baseline_size(&n));
            if is > was {
                out.push(Weakening {
                    key: "grew".into(),
                    what: format!("baseline grew from {was} to {is} recorded findings: new findings were recorded instead of fixed"),
                });
            }
        }
        _ => {
            let Some(b) = parse(before) else { return out };
            let Some(now) = now else {
                if kind == Kind::Lint {
                    out.push(Weakening { key: "deleted".into(), what: "lint config deleted, so its rules no longer run".into() });
                }
                return out;
            };
            let Some(n) = parse(now) else { return out };
            match kind {
                Kind::Intersite => compare_intersite(&b, &n, &ctx.defaults, &mut out),
                Kind::Package => {
                    compare_scripts(&b, &n, &mut out);
                    let jest = |v: &Value| flat(&serde_json::json!({ "jest": v.get("jest").cloned().unwrap_or(Value::Null) }));
                    compare(kind, &jest(&b), &jest(&n), &mut out);
                }
                Kind::TsConfig => {
                    compare_tsconfig(&b, &n, &mut out);
                    let lists = |v: &Value| {
                        flat(
                            &serde_json::json!({ "include": v.get("include").cloned().unwrap_or(Value::Null), "exclude": v.get("exclude").cloned().unwrap_or(Value::Null) }),
                        )
                    };
                    compare(kind, &lists(&b), &lists(&n), &mut out);
                }
                _ => compare(kind, &flat(&b), &flat(&n), &mut out),
            }
        }
    }
    out
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    path: String,
    before: String,
    now: Option<String>,
}

const FIX: &str = "fix the code instead of loosening the check; if this change is right, acknowledge it with the reason";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    context: Context,
    changes: Vec<Change>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { context: ctx, changes } = request.options()?;
    let mut findings = Vec::new();
    let (mut pragmas_before, mut pragmas_now) = (0, 0);
    for c in &changes {
        if kind(&c.path, &ctx) == Some(Kind::Source) {
            pragmas_before += pragmas(&c.before);
            pragmas_now += pragmas(c.now.as_deref().unwrap_or(""));
        }
    }
    for c in &changes {
        for w in judge(&c.path, &c.before, c.now.as_deref(), &ctx) {
            // A pragma moved from one file to another hides nothing new.
            if w.key == "coverage-ignore" && pragmas_now <= pragmas_before {
                continue;
            }
            findings.push(Finding {
                file: c.path.clone(),
                line: 0,
                target: format!("{}:{}", c.path, w.key),
                message: format!("{}: {}: {FIX}", c.path, w.what),
            });
        }
    }
    Ok(Answer::new(
        findings,
        format!(
            "{} changed evaluator files checked",
            changes.iter().filter(|c| kind(&c.path, &ctx).is_some_and(|k| k != Kind::Source)).count()
        ),
    ))
}

/// One proposed edit, for the PreToolUse hook: tamper findings for an evaluator file, lost tests or assertions or a
/// new skip for a test file. Targets match the gates' own, so an acknowledgment of either lets the edit through.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HookOptions {
    path: String,
    before: String,
    /// The file after the edit; none when it deletes the file.
    now: Option<String>,
    /// Whether the file is a test.
    test: bool,
    context: Context,
}

pub fn hook(request: &Request) -> Result<Answer, String> {
    let HookOptions { path, before, now, test, context: ctx } = request.options()?;
    let (path, before, now) = (path.as_str(), before.as_str(), now.as_deref());
    let mut findings: Vec<Finding> = judge(path, before, now, &ctx)
        .into_iter()
        .map(|w| Finding { file: path.into(), line: 0, target: format!("tamper:{path}:{}", w.key), message: w.what })
        .collect();
    if test {
        let (was, is) = (crate::hygiene::test_counts(before), crate::hygiene::test_counts(now.unwrap_or("")));
        let mut lost = Vec::new();
        if is.0 < was.0 {
            lost.push(format!("tests {} → {}", was.0, is.0));
        }
        if is.1 < was.1 {
            lost.push(format!("assertions {} → {}", was.1, is.1));
        }
        if is.2 > was.2 {
            lost.push(format!("skipped, focused or inverted tests {} → {}", was.2, is.2));
        }
        if !lost.is_empty() {
            findings.push(Finding { file: path.into(), line: 0, target: format!("test-integrity:{path}"), message: lost.join(", ") });
        }
    }
    Ok(Answer::new(findings, String::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whats(path: &str, before: &str, now: &str) -> Vec<String> {
        let ctx = Context {
            defaults: Defaults {
                run: vec!["sql".into(), "unused".into()],
                packs: vec!["tests".into(), "slop".into()],
                test_paths: vec!["**/*.test.*".into()],
            },
            baselines: vec!["intersite-baseline.json".into()],
        };
        judge(path, before, Some(now), &ctx).into_iter().map(|w| w.what).collect()
    }

    #[test]
    fn strict_options_turned_off_or_dropped() {
        let before = r#"{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, // keep
          "paths": { "@/*": ["./src/*"] }, }, "include": ["src"] }"#;
        assert_eq!(
            whats(
                "tsconfig.json",
                before,
                r#"{ "compilerOptions": { "strict": true, "strictNullChecks": false, "noUncheckedIndexedAccess": true }, "include": ["src"] }"#
            ),
            ["compilerOptions.strictNullChecks turned off"]
        );
        assert_eq!(
            whats("tsconfig.json", before, r#"{ "compilerOptions": { "strict": true }, "include": ["src"] }"#),
            ["compilerOptions.noUncheckedIndexedAccess removed (it was on)"]
        );
        // Adding an alias, raising strictness or excluding build output and tests is fine.
        assert!(whats("tsconfig.json", before, r#"{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true, "paths": { "@/*": ["./src/*"], "~/*": ["./app/*"] } }, "include": ["src", "app"], "exclude": ["dist", "**/*.test.ts"] }"#).is_empty());
        assert_eq!(
            whats(
                "tsconfig.json",
                before,
                r#"{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true }, "include": ["src"], "exclude": ["src/legacy"] }"#
            ),
            ["exclude now ignores src/legacy"]
        );
    }

    #[test]
    fn lint_rules_downgraded_ignored_or_turned_off() {
        let before = r#"{ "plugins": ["typescript", "react"], "rules": { "no-console": "error", "typescript/no-explicit-any": ["error", {}] }, "ignorePatterns": ["dist"] }"#;
        assert_eq!(
            whats(
                ".oxlintrc.json",
                before,
                r#"{ "plugins": ["typescript", "react"], "rules": { "no-console": "warn", "typescript/no-explicit-any": ["error", {}] }, "ignorePatterns": ["dist"] }"#
            ),
            ["rules.no-console lowered from error to warn"]
        );
        assert_eq!(
            whats(
                ".oxlintrc.json",
                before,
                r#"{ "plugins": ["typescript", "react"], "rules": { "no-console": "error", "typescript/no-explicit-any": ["error", {}], "eqeqeq": "off" }, "ignorePatterns": ["dist", "src/billing"] }"#
            ),
            ["rules.eqeqeq turned off", "ignorePatterns now ignores src/billing"]
        );
        assert_eq!(
            whats(
                ".oxlintrc.json",
                before,
                r#"{ "plugins": ["typescript"], "rules": { "no-console": "error", "typescript/no-explicit-any": ["error", {}] }, "ignorePatterns": ["dist"] }"#
            ),
            ["plugins no longer loads react"]
        );
        assert!(whats(".oxlintrc.json", before, r#"{ "plugins": ["typescript", "react", "import"], "rules": { "no-console": "error", "typescript/no-explicit-any": ["error", {}], "eqeqeq": "error" }, "ignorePatterns": ["dist", ".next"] }"#).is_empty());
    }

    #[test]
    fn flat_eslint_config_read_with_oxc() {
        let before = "import js from '@eslint/js';\nexport default [js.configs.recommended, { files: ['src/**'], rules: { 'no-unused-vars': 'error' } }, { ignores: ['dist/**'] }];\n";
        let now = "import js from '@eslint/js';\nexport default [js.configs.recommended, { files: ['src/**'], rules: { 'no-unused-vars': 'off' } }, { ignores: ['dist/**', 'src/payments/**'] }];\n";
        assert_eq!(
            whats("eslint.config.js", before, now),
            ["[files=src/**].rules.no-unused-vars lowered from error to off", "ignores now ignores src/payments/**"]
        );
    }

    #[test]
    fn runner_configs_coverage_retries_and_no_tests() {
        let before = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['src/**/*.test.ts'], coverage: { thresholds: { lines: 90, branches: 80 } } } });\n";
        let now = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['src/billing/**'], passWithNoTests: true, retry: 3, coverage: { thresholds: { lines: 70 } } } });\n";
        let mut got = whats("vitest.config.ts", before, now);
        got.sort();
        assert_eq!(
            got,
            [
                "test.coverage.thresholds.branches (80) removed",
                "test.coverage.thresholds.lines lowered from 90 to 70",
                "test.exclude now ignores src/billing/**",
                "test.passWithNoTests turned on: a run that finds no tests now passes",
                "test.retry raised to 3: a failing test now passes if it passes once",
            ]
        );
        let raised = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['src/**/*.test.ts', 'lib/**/*.test.ts'], coverage: { thresholds: { lines: 95, branches: 80 } } } });\n";
        assert!(whats("vitest.config.ts", before, raised).is_empty());
    }

    #[test]
    fn package_scripts_that_stop_failing() {
        let before = r#"{ "scripts": { "test": "vitest run src lib", "lint": "eslint . --max-warnings 0", "build": "tsc" } }"#;
        assert_eq!(
            whats(
                "package.json",
                before,
                r#"{ "scripts": { "test": "vitest run src lib || true", "lint": "eslint . --max-warnings 0", "build": "tsc" } }"#
            ),
            ["script `test` gained `|| true`"]
        );
        assert_eq!(
            whats("package.json", before, r#"{ "scripts": { "test": "vitest run src", "lint": "eslint .", "build": "tsc" } }"#),
            ["script `test` no longer runs on `lib`", "script `lint` no longer runs on `--max-warnings`"]
        );
        assert_eq!(
            whats("package.json", before, r#"{ "scripts": { "test": "echo skipped", "lint": "eslint . --max-warnings 0" } }"#),
            ["script `test` became `echo skipped`"]
        );
        // Running only the tests a change touched, or one name, or hiding warnings from the limit, runs less.
        assert_eq!(
            whats(
                "package.json",
                before,
                r#"{ "scripts": { "test": "vitest run src lib --changed", "lint": "eslint . --max-warnings 0 --quiet", "build": "tsc" } }"#
            ),
            ["script `test` gained `--changed`", "script `lint` gained `--quiet`"]
        );
        assert_eq!(
            whats(
                "package.json",
                before,
                r#"{ "scripts": { "test": "vitest run src lib --testNamePattern billing", "lint": "eslint . --max-warnings 0", "build": "tsc" } }"#
            ),
            ["script `test` gained `--testNamePattern`"]
        );
        assert!(whats("package.json", before, r#"{ "scripts": { "test": "vitest run src lib --coverage", "lint": "oxlint . --max-warnings 0 && eslint . --max-warnings 0", "build": "tsc -b" } }"#).is_empty());
        // Split into steps that still run the same commands.
        let workspace = r#"{ "scripts": { "test": "npm run test --workspace frontend" } }"#;
        assert!(whats("package.json", workspace, r#"{ "scripts": { "test": "npm run test:frontend && npm run test:tooling", "test:frontend": "npm run test --workspace frontend", "test:tooling": "node --test scripts/lib/*.test.ts" } }"#).is_empty());
        // A step dropped from the chain shows once, on the script that ran it.
        let chain = r#"{ "scripts": { "lint": "npm run lint:code && npm run lint:routes", "lint:code": "eslint .", "lint:routes": "node scripts/check-routes.ts" } }"#;
        assert_eq!(
            whats("package.json", chain, r#"{ "scripts": { "lint": "npm run lint:code", "lint:code": "eslint ." } }"#),
            ["script `lint` no longer runs on `scripts/check-routes.ts`"]
        );
    }

    #[test]
    fn workflow_steps_removed_softened_or_untriggered() {
        let before = "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - name: Test\n        run: npm test\n      - run: npm run lint\n";
        assert_eq!(
            whats(".github/workflows/ci.yml", before, &before.replace("      - run: npm run lint\n", "")),
            ["step `npm run lint` in job ci removed"]
        );
        assert_eq!(
            whats(
                ".github/workflows/ci.yml",
                before,
                &before.replace("        run: npm test\n", "        run: npm test\n        continue-on-error: true\n")
            ),
            ["step `npm test` in job ci may now fail without failing the run (continue-on-error or `if: false`)"]
        );
        assert_eq!(
            whats(".github/workflows/ci.yml", before, &before.replace("  pull_request:\n", "")),
            ["no longer runs on pull_request, so its checks stop running there"]
        );
        assert!(whats(
            ".github/workflows/ci.yml",
            before,
            &before.replace("npm ci", "npm ci --prefer-offline").replace("npm test", "npm test -- --coverage")
        )
        .is_empty());
    }

    #[test]
    fn intersite_config_and_baselines() {
        let before = "project: x\ngates:\n  testCmd: npm test\n";
        assert_eq!(
            whats("intersite.yml", before, "project: x\ngates:\n  testCmd: npm test\n  run: [sql]\n"),
            ["gates.run no longer runs unused"]
        );
        assert_eq!(
            whats("intersite.yml", before, "project: x\nlint:\n  rules: { no-explicit-any: off }\ngates:\n  testCmd: npm test\n"),
            ["rules.no-explicit-any turned off"]
        );
        // An acknowledgment with a reason is the reviewed way out, not tampering.
        assert!(whats(
            "intersite.yml",
            before,
            "project: x\ngates:\n  testCmd: npm test\n  acknowledged:\n    - { gate: sql, target: a.sql, why: table is empty }\n"
        )
        .is_empty());
        assert_eq!(
            whats("intersite-baseline.json", r#"{ "a.ts": { "no-as-any": 1 } }"#, r#"{ "a.ts": { "no-as-any": 2 } }"#),
            ["baseline grew from 1 to 2 recorded findings: new findings were recorded instead of fixed"]
        );
    }

    #[test]
    fn pragmas_and_exit_in_setup() {
        assert_eq!(whats("src/a.ts", "export const a = 1;\n", "/* istanbul ignore next */\nexport const a = 1;\n").len(), 1);
        assert_eq!(whats("test/setup.ts", "", "afterAll(() => process.exit(0));\n").len(), 1);
        assert!(whats("src/cli.ts", "", "process.exit(0);\n").is_empty());
        // Quoted in a string (a test of this check, a doc example) hides nothing.
        assert!(whats("src/a.test.ts", "", "const sample = \"/* istanbul ignore next */\";\n// café\nconst exit = 'process.exit(0)';\n")
            .is_empty());
        assert!(whats("test/setup.ts", "", "const exit = 'process.exit(0)'; // process.exit(0)\n").is_empty());
    }
}
