//! The special-case check: production code that answers the tests instead of solving the problem. Two shapes, both
//! read only on the lines the change added: a branch on being under test (`NODE_ENV === "test"`, `VITEST`,
//! `JEST_WORKER_ID`, `typeof jest`, Swift's XCTest probes), and a hard-coded answer: a branch on one of a changed test's
//! own input literals that returns exactly the value that test expects for it.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use rayon::prelude::*;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::text::{self, Lines};
use crate::{rel, Answer, Finding, Request};

/// Probes for "am I running under a test runner".
static SNIFF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bNODE_ENV\b\s*[!=]==?\s*["'`]test["'`]|["'`]test["'`]\s*[!=]==?\s*(?:process\.env|import\.meta\.env)\.NODE_ENV\b|\b(?:import\.meta\.env\.MODE|\bMODE)\s*[!=]==?\s*["'`]test["'`]|\b(?:process\.env|import\.meta\.env)\.(?:VITEST(?:_\w+)?|JEST_WORKER_ID)\b|\btypeof\s+(?:jest|vi|vitest)\s*[!=]==?|\b(?:globalThis|window|global)\.(?:jest|vi|__vitest_worker__)\b|\bXCTestConfigurationFilePath\b|NSClassFromString\(\s*"XCTest(?:Case)?"\s*\)|\bXCTestSessionIdentifier\b"#).unwrap()
});
/// Another environment named beside the test one: the switch is "not production", not "under test".
static OTHER_ENV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["'`](?:development|dev|staging|preview|local|e2e)["'`]|\b(?:staging|STAGING)\b"#).unwrap());
/// Modules whose job is to describe the environment: a flag defined there is configuration, not a special case.
static ENV_MODULE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:env|config|configs|settings)(?:/|\.[^/]*$)|(?:^|/)[\w.-]*(?:env|environment|config)\.[cm]?[jt]s$").unwrap()
});

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum Lit {
    Str(String),
    Num(String),
}

impl Lit {
    fn shown(&self) -> String {
        match self {
            Lit::Str(s) => format!("\"{s}\""),
            Lit::Num(n) => n.clone(),
        }
    }
}

/// Literals too common to mean anything when they appear in both a test and the code.
fn telling(l: &Lit) -> bool {
    match l {
        Lit::Str(s) => s.chars().count() > 3,
        Lit::Num(n) => {
            let v: f64 = n.parse().unwrap_or(0.0);
            !([0.0, 1.0, -1.0, 2.0, 10.0, 100.0, 1000.0].contains(&v) || (v.fract() == 0.0 && (100.0..600.0).contains(&v)))
        }
    }
}

fn lit_of(e: &Expression) -> Option<Lit> {
    match e {
        Expression::StringLiteral(s) => Some(Lit::Str(s.value.to_string())),
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => {
            Some(Lit::Str(t.quasis.iter().map(|q| q.value.raw.to_string()).collect()))
        }
        Expression::NumericLiteral(n) => Some(Lit::Num(n.value.to_string())),
        Expression::UnaryExpression(u) if u.operator == UnaryOperator::UnaryNegation => match &u.argument {
            Expression::NumericLiteral(n) => Some(Lit::Num((-n.value).to_string())),
            _ => None,
        },
        Expression::ParenthesizedExpression(p) => lit_of(&p.expression),
        _ => None,
    }
}

/// Every telling literal inside an expression (a call's arguments, an object passed in).
fn literals_in(e: &Expression, out: &mut HashSet<Lit>) {
    struct All<'o>(&'o mut HashSet<Lit>);
    impl<'a> Visit<'a> for All<'_> {
        fn visit_expression(&mut self, it: &Expression<'a>) {
            if let Some(l) = lit_of(it).filter(telling) {
                self.0.insert(l);
            }
            walk::walk_expression(self, it);
        }
    }
    All(out).visit_expression(e);
}

/// One assertion: the literal inputs of what it checks, and the literal it expects.
struct Expectation {
    inputs: HashSet<Lit>,
    expected: Lit,
}

struct TestReader {
    /// What each variable was computed from: `const total = price("abc-123")`.
    from: HashMap<String, HashSet<Lit>>,
    found: Vec<Expectation>,
}

impl TestReader {
    fn inputs(&self, actual: &Expression) -> HashSet<Lit> {
        let mut out = HashSet::new();
        let args = match actual.without_parentheses() {
            Expression::AwaitExpression(a) => return self.inputs(&a.argument),
            Expression::Identifier(id) => return self.from.get(id.name.as_str()).cloned().unwrap_or_default(),
            Expression::CallExpression(c) => &c.arguments,
            Expression::NewExpression(c) => &c.arguments,
            _ => return out,
        };
        for e in args.iter().filter_map(|a| a.as_expression()) {
            literals_in(e, &mut out);
        }
        out
    }

    fn expect(&mut self, actual: &Expression, expected: &Expression) {
        let Some(expected) = lit_of(expected).filter(telling) else { return };
        let inputs = self.inputs(actual);
        if !inputs.is_empty() {
            self.found.push(Expectation { inputs, expected });
        }
    }
}

impl<'a> Visit<'a> for TestReader {
    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (Some(name), Some(init)) = (it.id.get_binding_identifier(), &it.init) {
            let inputs = self.inputs(init);
            if !inputs.is_empty() {
                self.from.insert(name.name.to_string(), inputs);
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::StaticMemberExpression(m) = &it.callee {
            let matcher = m.property.name.as_str();
            // expect(actual).toBe(expected), with .resolves allowed and .not (the opposite claim) left out.
            if matches!(matcher, "toBe" | "toEqual" | "toStrictEqual") {
                let mut object = &m.object;
                if let Expression::StaticMemberExpression(inner) = object {
                    if inner.property.name == "resolves" {
                        object = &inner.object;
                    }
                }
                if let Expression::CallExpression(e) = object {
                    if matches!(&e.callee, Expression::Identifier(id) if id.name == "expect") {
                        if let (Some(actual), Some(expected)) =
                            (e.arguments.first().and_then(|a| a.as_expression()), it.arguments.first().and_then(|a| a.as_expression()))
                        {
                            self.expect(actual, expected);
                        }
                    }
                }
            }
            if matches!(&m.object, Expression::Identifier(id) if id.name == "assert")
                && matches!(matcher, "equal" | "strictEqual" | "deepEqual" | "deepStrictEqual")
            {
                if let (Some(actual), Some(expected)) =
                    (it.arguments.first().and_then(|a| a.as_expression()), it.arguments.get(1).and_then(|a| a.as_expression()))
                {
                    self.expect(actual, expected);
                }
            }
        }
        walk::walk_call_expression(self, it);
    }
}

fn expectations(path: &str, src: &str) -> Vec<Expectation> {
    crate::js::parse(path, src, |program| {
        let mut r = TestReader { from: HashMap::new(), found: vec![] };
        r.visit_program(program);
        r.found
    })
    .unwrap_or_default()
}

/// The literals a condition compares something with by equality: `id === "abc-123"`, `"abc" == x`, joined by && and ||.
/// A condition that tests anything else as well (`status === "X" && expires < now`) is logic, not a looked-up answer,
/// so it yields nothing.
fn compared(e: &Expression, out: &mut Vec<Lit>) {
    if !only_literal_tests(e) {
        return;
    }
    fn collect(e: &Expression, out: &mut Vec<Lit>) {
        match e.without_parentheses() {
            Expression::BinaryExpression(b) => out.extend(lit_of(&b.left).into_iter().chain(lit_of(&b.right)).filter(data_like)),
            Expression::LogicalExpression(l) => {
                collect(&l.left, out);
                collect(&l.right, out);
            }
            _ => {}
        }
    }
    collect(e, out);
}

fn only_literal_tests(e: &Expression) -> bool {
    match e.without_parentheses() {
        Expression::BinaryExpression(b) => {
            matches!(b.operator, BinaryOperator::StrictEquality | BinaryOperator::Equality)
                && (lit_of(&b.left).is_some() || lit_of(&b.right).is_some())
        }
        Expression::LogicalExpression(l) => only_literal_tests(&l.left) && only_literal_tests(&l.right),
        _ => false,
    }
}

/// A test's data, not a name: `"abc-123"`, `"jo@x.io"`, `4200`. A bare word (`"admin"`, `"PENDING_REVIEW"`) is an enum
/// value or a keyword, and code branches on those by design.
fn data_like(l: &Lit) -> bool {
    match l {
        Lit::Num(_) => true,
        Lit::Str(s) => !s.chars().all(|c| c.is_ascii_alphabetic() || c == '_'),
    }
}

/// The literal a branch returns: `return 42`, or a block whose statements include one (not inside a nested function).
fn returned(s: &Statement) -> Option<(Lit, u32)> {
    match s {
        Statement::ReturnStatement(r) => r.argument.as_ref().and_then(lit_of).map(|l| (l, r.span.start)),
        Statement::BlockStatement(b) => b.body.iter().find_map(returned),
        _ => None,
    }
}

struct Hit {
    line: u32,
    input: Lit,
    expected: Lit,
    /// The function it is in, so a whole lookup table can be let off.
    scope: usize,
}

struct CodeReader<'s> {
    lines: Lines,
    added: &'s HashSet<u32>,
    pairs: &'s HashMap<Lit, HashSet<Lit>>,
    hits: Vec<Hit>,
    /// The enclosing functions, innermost last: (id, literal-to-literal branches seen in it).
    scopes: Vec<(usize, u32)>,
    next_scope: usize,
    /// Functions that map literals to literals in two or more branches: a lookup table, which is how a mapping is
    /// written, not a special case.
    tables: HashSet<usize>,
}

/// `"email"` → `"EMAIL"`: the answer is the input respelled, which is what a mapping does.
fn respelled(a: &Lit, b: &Lit) -> bool {
    let norm = |l: &Lit| match l {
        Lit::Str(s) => s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase(),
        Lit::Num(n) => n.clone(),
    };
    norm(a) == norm(b)
}

impl CodeReader<'_> {
    fn new<'s>(src: &str, added: &'s HashSet<u32>, pairs: &'s HashMap<Lit, HashSet<Lit>>) -> CodeReader<'s> {
        CodeReader { lines: Lines::new(src), added, pairs, hits: vec![], scopes: vec![(0, 0)], next_scope: 1, tables: HashSet::new() }
    }

    fn check(&mut self, conditions: &[Lit], answer: Option<(Lit, u32)>, at: u32) {
        let Some((answer, offset)) = answer else { return };
        if conditions.is_empty() {
            return;
        }
        let scope = self.scopes.last_mut().expect("module scope");
        scope.1 += 1;
        let scope = scope.0;
        let line = self.lines.line(offset as usize);
        if !self.added.contains(&line) && !self.added.contains(&self.lines.line(at as usize)) {
            return;
        }
        for input in conditions {
            if !respelled(input, &answer) && self.pairs.get(input).is_some_and(|expected| expected.contains(&answer)) {
                self.hits.push(Hit { line, input: input.clone(), expected: answer.clone(), scope });
                return;
            }
        }
    }

    fn in_scope(&mut self, body: impl FnOnce(&mut Self)) {
        self.scopes.push((self.next_scope, 0));
        self.next_scope += 1;
        body(self);
        let (id, branches) = self.scopes.pop().expect("pushed above");
        if branches >= 2 {
            self.tables.insert(id);
        }
    }

    fn finish(mut self) -> Vec<Hit> {
        let (id, branches) = self.scopes[0];
        if branches >= 2 {
            self.tables.insert(id);
        }
        let tables = self.tables;
        self.hits.into_iter().filter(|h| !tables.contains(&h.scope)).collect()
    }
}

impl<'a> Visit<'a> for CodeReader<'_> {
    fn visit_function(&mut self, it: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        self.in_scope(|s| walk::walk_function(s, it, flags));
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.in_scope(|s| walk::walk_arrow_function_expression(s, it));
    }

    fn visit_if_statement(&mut self, it: &IfStatement<'a>) {
        let mut conditions = vec![];
        compared(&it.test, &mut conditions);
        self.check(&conditions, returned(&it.consequent), it.span.start);
        walk::walk_if_statement(self, it);
    }

    fn visit_switch_statement(&mut self, it: &SwitchStatement<'a>) {
        for case in &it.cases {
            let Some(test) = case.test.as_ref().and_then(lit_of).filter(data_like) else { continue };
            self.check(&[test], case.consequent.iter().find_map(returned), case.span.start);
        }
        walk::walk_switch_statement(self, it);
    }

    fn visit_conditional_expression(&mut self, it: &ConditionalExpression<'a>) {
        let mut conditions = vec![];
        compared(&it.test, &mut conditions);
        self.check(&conditions, lit_of(&it.consequent).map(|l| (l, it.consequent.span().start)), it.span.start);
        walk::walk_conditional_expression(self, it);
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// The changed test files.
    tests: Vec<String>,
    /// The changed production files.
    production: Vec<String>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { tests, production } = request.options()?;
    let added = request.added.clone().unwrap_or_default();
    let empty = HashSet::new();

    // input literal → the literals tests expect for it.
    let mut pairs: HashMap<Lit, HashSet<Lit>> = HashMap::new();
    let per_test: Vec<Vec<Expectation>> =
        tests.par_iter().map(|t| text::read(&request.root, t).map(|src| expectations(t, &src)).unwrap_or_default()).collect();
    for e in per_test.into_iter().flatten() {
        for input in e.inputs {
            if input != e.expected {
                pairs.entry(input).or_default().insert(e.expected.clone());
            }
        }
    }

    let found: Vec<Finding> = production
        .par_iter()
        .flat_map_iter(|file| {
            let lines_added = added.get(file.as_str()).unwrap_or(&empty);
            let mut out = Vec::new();
            let Some(src) = text::read(&request.root, file) else { return out };
            let name = rel(&request.prefix, file);
            if !ENV_MODULE.is_match(file) {
                let all: Vec<&str> = src.lines().collect();
                for (i, line) in all.iter().enumerate() {
                    let n = i as u32 + 1;
                    let code = line.split("//").next().unwrap_or("");
                    // `NODE_ENV === "test" || NODE_ENV === "development"` switches a test-support feature on outside
                    // production; the cheat singles the test run out.
                    let near = all[i.saturating_sub(1)..(i + 3).min(all.len())].join(" ");
                    if lines_added.contains(&n) && SNIFF.is_match(code) && !code.contains("import.meta.vitest") && !OTHER_ENV.is_match(&near) {
                        out.push(Finding { file: file.clone(), line: n, target: format!("{name}:test-env"), message: format!("{name}:{n} branches on running under a test runner, so the tests check different code than production runs: make the behavior a parameter or dependency the test passes in, and do not detect the test environment") });
                    }
                }
            }
            if !pairs.is_empty() && !file.ends_with(".swift") {
                let hits = crate::js::parse(file, &src, |program| {
                    let mut r = CodeReader::new(&src, lines_added, &pairs);
                    r.visit_program(program);
                    r.finish()
                })
                .unwrap_or_default();
                for h in hits {
                    out.push(Finding {
                        file: file.clone(),
                        line: h.line,
                        target: format!("{name}:{}", h.input.shown()),
                        message: format!("{name}:{} returns {} when the input is {}, exactly what a changed test expects for that input: the code answers the test instead of computing it; write the general logic, and do not hard-code test values", h.line, h.expected.shown(), h.input.shown()),
                    });
                }
            }
            out
        })
        .collect();
    let mut findings = found;
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    Ok(Answer::new(findings, format!("{} changed source files checked against {} changed test files", production.len(), tests.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(test: &str, code: &str) -> Vec<(String, String)> {
        let mut pairs: HashMap<Lit, HashSet<Lit>> = HashMap::new();
        for e in expectations("a.test.ts", test) {
            for i in e.inputs {
                pairs.entry(i).or_default().insert(e.expected.clone());
            }
        }
        let added: HashSet<u32> = (1..=code.lines().count() as u32).collect();
        crate::js::parse("a.ts", code, |p| {
            let mut r = CodeReader::new(code, &added, &pairs);
            r.visit_program(p);
            r.finish().into_iter().map(|h| (h.input.shown(), h.expected.shown())).collect()
        })
        .unwrap()
    }

    #[test]
    fn a_branch_on_the_tests_input_returning_its_expected_value() {
        let test = "test('price', () => { expect(price('abc-123')).toBe(4200); const r = await total({ sku: 'sku-77' }); expect(r).toEqual(9900); });";
        assert_eq!(
            hits(test, "export function price(id) {\n  if (id === 'abc-123') return 4200;\n  return lookup(id);\n}\n"),
            [("\"abc-123\"".into(), "4200".into())]
        );
        assert_eq!(
            hits(test, "export function total(o) {\n  switch (o.sku) {\n    case 'sku-77':\n      return 9900;\n  }\n}\n"),
            [("\"sku-77\"".into(), "9900".into())]
        );
        assert_eq!(
            hits(test, "export const price = (id) => id === 'abc-123' ? 4200 : lookup(id);\n"),
            [("\"abc-123\"".into(), "4200".into())]
        );
    }

    #[test]
    fn real_logic_and_common_values_pass() {
        // A role check returning a different value, a status code, short strings: not the test's answer.
        let test = "test('role', () => { expect(canEdit('admin')).toBe(true); expect(status('missing-user')).toBe(404); expect(label('ok')).toBe('done'); });";
        assert!(hits(test, "export function canEdit(role) { if (role === 'admin') return true; return false; }\nexport function status(id) { if (id === 'missing-user') return 404; }\nexport function label(s) { if (s === 'ok') return 'done'; }\n").is_empty());
        // A mapping written as a switch or an if chain is a lookup table, and an answer that respells the input is a
        // mapping too.
        let test = "test('channel', () => { expect(channel('email')).toBe('EMAIL'); expect(status('succeeded')).toBe('COMPLETED'); });";
        assert!(hits(test, "export function channel(c) { if (c === 'email') return 'EMAIL'; return 'OTHER'; }\nexport function status(s) {\n  switch (s) {\n    case 'succeeded': return 'COMPLETED';\n    case 'failed': return 'FAILED';\n  }\n}\n").is_empty());
        // A condition that also tests something else is logic; a bare word is an enum value code branches on by design.
        let test = "test('s', () => { expect(customer('pending-review', past)).toBe('EXPIRED'); expect(review('PENDING_REVIEW')).toBe('EXPIRED'); });";
        assert!(hits(test, "export function customer(s, d) { if (s === 'pending-review' && d < now) return 'EXPIRED'; return s; }\nexport function review(s) { if (s === 'PENDING_REVIEW') return 'EXPIRED'; return s; }\n").is_empty());
        let test = "test('fee', () => { expect(fee('premium-plan')).toBe(2500); });";
        assert!(hits(test, "export function fee(plan) { return PLANS[plan].cents; }\n").is_empty());
        // .not claims the opposite, so it gives no expected value.
        let test = "test('x', () => { expect(code('abc-123')).not.toBe(4200); });";
        assert!(hits(test, "export function code(id) { if (id === 'abc-123') return 4200; }\n").is_empty());
    }

    #[test]
    fn test_environment_probes() {
        for line in [
            "if (process.env.NODE_ENV === 'test') return [];",
            "const fast = process.env.VITEST ? 0 : 500;",
            "if (typeof jest !== 'undefined') skip();",
            "if ProcessInfo.processInfo.environment[\"XCTestConfigurationFilePath\"] != nil { return }",
            "if (process.env.JEST_WORKER_ID) {",
        ] {
            assert!(SNIFF.is_match(line), "{line}");
        }
        assert!(OTHER_ENV.is_match("(env.NODE_ENV === \"development\" || env.NODE_ENV === \"test\") &&"));
        for line in [
            "if (process.env.NODE_ENV === 'production') {",
            "const isTest = file.endsWith('.test.ts');",
            "if (import.meta.vitest) {",
            "if (mode === 'testing') {",
        ] {
            assert!(!SNIFF.is_match(line) || line.contains("import.meta.vitest"), "{line}");
        }
    }
}
