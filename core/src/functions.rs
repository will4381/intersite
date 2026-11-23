//! The functions of a JavaScript or TypeScript file, in one parse: each one's name, lines and body, and its cognitive
//! complexity (SonarSource's definition), plus the operators a mutant may flip. Shared by `mutants`, `complexity` and
//! `coverage`.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::operator::{BinaryOperator, LogicalOperator, UnaryOperator};
use oxc_syntax::scope::ScopeFlags;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::text::Lines;

pub struct Func {
    /// Its own name, or `<callee> callback` for a function passed straight to a call.
    pub name: String,
    pub callback: bool,
    /// Not inside another function: its complexity includes every function nested in it.
    pub top: bool,
    pub line: u32,
    pub end_line: u32,
    /// Byte span of the body: the braces of a block, or the expression of an arrow's expression body.
    pub body: (u32, u32),
    pub expression_body: bool,
    pub empty: bool,
    pub complexity: u32,
}

/// An operator or boolean a mutant can flip.
pub struct Site {
    pub start: u32,
    pub from: &'static str,
    pub to: &'static str,
    pub line: u32,
    /// Lower is tried first: comparisons, then logic, then arithmetic, then negation, then booleans.
    pub rank: u8,
}

pub struct Shape {
    pub funcs: Vec<Func>,
    pub sites: Vec<Site>,
}

/// Calls whose arguments are never worth mutating: logging, telemetry and error reporting (Google's arid nodes).
static ARID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:console|logger|log|sentry|metrics|analytics|posthog|telemetry|tracer|statsd|mixpanel|amplitude|segment|datadog)(?:\.|$)|^(?:log|debug|trace|track\w*|log[A-Z]\w*|capture(?:Exception|Message|Event))$|(?:^|\.)(?:log(?:ger)?|console)\.\w+$").unwrap()
});

struct Frame {
    func: Option<usize>,
    /// Depth at which this function's body starts: its own nesting is `depth - d0`.
    d0: u32,
}

struct Walker<'s> {
    src: &'s str,
    lines: Lines,
    names: HashMap<u32, (String, bool)>,
    funcs: Vec<Func>,
    sites: Vec<Site>,
    frames: Vec<Frame>,
    depth: u32,
    arid: u32,
    types: u32,
    chain: bool,
}

impl<'s> Walker<'s> {
    fn line(&self, offset: u32) -> u32 {
        self.lines.line(offset as usize)
    }

    /// One structural increment: +1 for each named function around it, plus its nesting there when `nested`.
    fn add(&mut self, nested: bool) {
        for f in &self.frames {
            if let Some(i) = f.func {
                self.funcs[i].complexity += 1 + if nested { self.depth - f.d0 } else { 0 };
            }
        }
    }

    fn nested(&mut self, body: impl FnOnce(&mut Self)) {
        self.depth += 1;
        body(self);
        self.depth -= 1;
    }

    fn innermost(&self) -> Option<usize> {
        self.frames.iter().rev().find_map(|f| f.func)
    }

    fn site(&mut self, start: u32, from: &'static str, to: &'static str, rank: u8) {
        if self.arid == 0 && self.types == 0 {
            let line = self.line(start);
            self.sites.push(Site { start, from, to, line, rank });
        }
    }

    /// The operator's offset between its two operands, found in the text between them.
    fn operator_at(&self, left: Span, right: Span, op: &str) -> Option<u32> {
        let gap = self.src.get(left.end as usize..right.start as usize)?;
        gap.find(op).map(|i| left.end + i as u32)
    }

    fn enter(&mut self, span: Span, body: Option<&FunctionBody<'_>>, expression: bool, f: impl FnOnce(&mut Self)) {
        let outer = !self.frames.is_empty();
        if outer {
            self.depth += 1;
        }
        let func = match (self.names.get(&span.start).cloned(), body) {
            (Some((name, callback)), Some(body)) => {
                let top = self.frames.is_empty();
                let (line, end_line) = (self.line(span.start), self.line(span.end));
                self.funcs.push(Func { name, callback, top, line, end_line, body: (body.span.start, body.span.end), expression_body: expression, empty: body.statements.is_empty(), complexity: 0 });
                Some(self.funcs.len() - 1)
            }
            _ => None,
        };
        self.frames.push(Frame { func, d0: self.depth });
        f(self);
        self.frames.pop();
        if outer {
            self.depth -= 1;
        }
    }

    fn if_chain(&mut self, it: &IfStatement<'_>, else_if: bool) {
        self.add(!else_if);
        self.visit_expression(&it.test);
        self.nested(|w| w.visit_statement(&it.consequent));
        match &it.alternate {
            Some(Statement::IfStatement(inner)) => self.if_chain(inner, true),
            Some(other) => {
                self.add(false);
                self.nested(|w| w.visit_statement(other));
            }
            None => {}
        }
    }

    fn name(&mut self, expr: &Expression<'_>, name: String, callback: bool) {
        if matches!(expr, Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)) {
            self.names.insert(expr.span().start, (name, callback));
        }
    }
}

/// The operators of a chain of `&&`, `||` and `??` written without parentheses, left to right.
fn flatten(l: &LogicalExpression<'_>, out: &mut Vec<LogicalOperator>) {
    if let Expression::LogicalExpression(left) = &l.left {
        flatten(left, out);
    }
    out.push(l.operator);
    if let Expression::LogicalExpression(right) = &l.right {
        flatten(right, out);
    }
}

fn is_text(e: &Expression<'_>) -> bool {
    matches!(e, Expression::StringLiteral(_) | Expression::TemplateLiteral(_))
}

impl<'a> Visit<'a> for Walker<'_> {
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        if let Some(id) = &it.id {
            self.names.entry(it.span.start).or_insert((id.name.to_string(), false));
        }
        self.enter(it.span, it.body.as_deref(), false, |w| walk::walk_function(w, it, flags));
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.enter(it.span, Some(&it.body), it.expression, |w| walk::walk_arrow_function_expression(w, it));
    }

    fn visit_export_default_declaration(&mut self, it: &ExportDefaultDeclaration<'a>) {
        // `export default function () {}` has no name of its own; one with a name keeps it, as V8 reports it.
        if let ExportDefaultDeclarationKind::FunctionDeclaration(f) = &it.declaration {
            let name = f.id.as_ref().map_or("default".to_string(), |id| id.name.to_string());
            self.names.insert(f.span.start, (name, false));
        }
        walk::walk_export_default_declaration(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&it.id, &it.init) {
            self.name(init, id.name.to_string(), false);
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_method_definition(&mut self, it: &MethodDefinition<'a>) {
        if let Some(k) = it.key.static_name() {
            self.names.insert(it.value.span.start, (k.to_string(), false));
        }
        walk::walk_method_definition(self, it);
    }

    fn visit_property_definition(&mut self, it: &PropertyDefinition<'a>) {
        if let (Some(k), Some(v)) = (it.key.static_name(), &it.value) {
            self.name(v, k.to_string(), false);
        }
        walk::walk_property_definition(self, it);
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        if let Some(k) = it.key.static_name() {
            self.name(&it.value, k.to_string(), false);
        }
        walk::walk_object_property(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let callee = &self.src[it.callee.span().start as usize..it.callee.span().end as usize];
        if self.frames.is_empty() {
            for arg in &it.arguments {
                if let Some(e) = arg.as_expression() {
                    self.name(e, format!("{} callback", callee.split_whitespace().collect::<String>()), true);
                }
            }
        }
        if let (Expression::Identifier(id), Some(i)) = (&it.callee, self.innermost()) {
            if self.funcs[i].name == id.name.as_str() {
                self.add(false);
            }
        }
        let arid = ARID.is_match(callee);
        self.arid += arid as u32;
        walk::walk_call_expression(self, it);
        self.arid -= arid as u32;
    }

    fn visit_throw_statement(&mut self, it: &ThrowStatement<'a>) {
        self.arid += 1;
        walk::walk_throw_statement(self, it);
        self.arid -= 1;
    }

    fn visit_ts_type(&mut self, it: &TSType<'a>) {
        self.types += 1;
        walk::walk_ts_type(self, it);
        self.types -= 1;
    }

    fn visit_if_statement(&mut self, it: &IfStatement<'a>) {
        self.if_chain(it, false);
    }

    fn visit_conditional_expression(&mut self, it: &ConditionalExpression<'a>) {
        self.add(true);
        self.visit_expression(&it.test);
        self.nested(|w| {
            w.visit_expression(&it.consequent);
            w.visit_expression(&it.alternate);
        });
    }

    fn visit_switch_statement(&mut self, it: &SwitchStatement<'a>) {
        self.add(true);
        self.nested(|w| walk::walk_switch_statement(w, it));
    }

    fn visit_for_statement(&mut self, it: &ForStatement<'a>) {
        self.add(true);
        self.nested(|w| walk::walk_for_statement(w, it));
    }

    fn visit_for_in_statement(&mut self, it: &ForInStatement<'a>) {
        self.add(true);
        self.nested(|w| walk::walk_for_in_statement(w, it));
    }

    fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
        self.add(true);
        self.nested(|w| walk::walk_for_of_statement(w, it));
    }

    fn visit_while_statement(&mut self, it: &WhileStatement<'a>) {
        self.add(true);
        self.nested(|w| walk::walk_while_statement(w, it));
    }

    fn visit_do_while_statement(&mut self, it: &DoWhileStatement<'a>) {
        self.add(true);
        self.nested(|w| walk::walk_do_while_statement(w, it));
    }

    fn visit_catch_clause(&mut self, it: &CatchClause<'a>) {
        self.add(true);
        self.nested(|w| walk::walk_catch_clause(w, it));
    }

    fn visit_break_statement(&mut self, it: &BreakStatement<'a>) {
        if it.label.is_some() {
            self.add(false);
        }
    }

    fn visit_continue_statement(&mut self, it: &ContinueStatement<'a>) {
        if it.label.is_some() {
            self.add(false);
        }
    }

    fn visit_logical_expression(&mut self, it: &LogicalExpression<'a>) {
        if !std::mem::replace(&mut self.chain, false) {
            let mut ops = Vec::new();
            flatten(it, &mut ops);
            let runs = ops.windows(2).filter(|w| w[0] != w[1]).count() + 1;
            for _ in 0..runs {
                self.add(false);
            }
        }
        let swap = match it.operator {
            LogicalOperator::And => Some(("&&", "||")),
            LogicalOperator::Or => Some(("||", "&&")),
            LogicalOperator::Coalesce => None,
        };
        if let Some((from, to)) = swap {
            if let Some(at) = self.operator_at(it.left.span(), it.right.span(), from) {
                self.site(at, from, to, 1);
            }
        }
        self.chain = matches!(it.left, Expression::LogicalExpression(_));
        self.visit_expression(&it.left);
        self.chain = matches!(it.right, Expression::LogicalExpression(_));
        self.visit_expression(&it.right);
        self.chain = false;
    }

    fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
        let swap = match it.operator {
            BinaryOperator::StrictEquality => Some(("!==", 0)),
            BinaryOperator::StrictInequality => Some(("===", 0)),
            BinaryOperator::Equality => Some(("!=", 0)),
            BinaryOperator::Inequality => Some(("==", 0)),
            BinaryOperator::LessThan => Some((">=", 0)),
            BinaryOperator::GreaterEqualThan => Some(("<", 0)),
            BinaryOperator::GreaterThan => Some(("<=", 0)),
            BinaryOperator::LessEqualThan => Some((">", 0)),
            // Joining text with `+` builds messages: flipping it to `-` only makes NaN in a string nobody checks.
            BinaryOperator::Addition if !is_text(&it.left) && !is_text(&it.right) => Some(("-", 2)),
            BinaryOperator::Subtraction => Some(("+", 2)),
            _ => None,
        };
        if let Some((to, rank)) = swap {
            let from = it.operator.as_str();
            if let Some(at) = self.operator_at(it.left.span(), it.right.span(), from) {
                self.site(at, from, to, rank);
            }
        }
        walk::walk_binary_expression(self, it);
    }

    fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
        if it.operator == UnaryOperator::LogicalNot {
            self.site(it.span.start, "!", "", 3);
        }
        walk::walk_unary_expression(self, it);
    }

    fn visit_boolean_literal(&mut self, it: &BooleanLiteral) {
        let (from, to) = if it.value { ("true", "false") } else { ("false", "true") };
        self.site(it.span.start, from, to, 4);
    }
}

/// The functions and mutable operators of a file, or None when it does not parse.
pub fn read(path: &str, src: &str) -> Option<Shape> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, src, SourceType::from_path(path).unwrap_or_default()).parse();
    if parsed.panicked {
        return None;
    }
    let mut w = Walker { src, lines: Lines::new(src), names: HashMap::new(), funcs: vec![], sites: vec![], frames: vec![], depth: 0, arid: 0, types: 0, chain: false };
    w.visit_program(&parsed.program);
    Some(Shape { funcs: w.funcs, sites: w.sites })
}

/// A UTF-16 offset, as JavaScript counts, for a byte offset.
pub fn utf16(text: &str, byte: u32) -> usize {
    text[..byte as usize].encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complexity(src: &str) -> Vec<(String, u32)> {
        read("a.ts", src).unwrap().funcs.into_iter().filter(|f| f.top).map(|f| (f.name, f.complexity)).collect()
    }

    #[test]
    fn scores_cognitive_complexity_as_sonar_does() {
        // Sonar's own example: sumOfPrimes is 7.
        let src = "function sumOfPrimes(max) {\n  let total = 0;\n  OUT: for (let i = 1; i <= max; ++i) {\n    for (let j = 2; j < i; ++j) {\n      if (i % j == 0) {\n        continue OUT;\n      }\n    }\n    total += i;\n  }\n  return total;\n}\n";
        assert_eq!(complexity(src), vec![("sumOfPrimes".into(), 7)]);
        // if (+1), else if (+1), else (+1), a && b || c (+2), a nested ternary inside the if (+2).
        let src = "const f = (a, b, c) => {\n  if (a && b || c) { return a ? 1 : 2; } else if (b) { return 3; } else { return 4; }\n};\n";
        assert_eq!(complexity(src), vec![("f".into(), 7)]);
        // A callback nests: the `if` inside it costs 2 for the outer function. Recursion costs 1.
        let src = "export function walk(list) {\n  list.forEach((x) => { if (x) walk(x); });\n}\napp.get('/x', (req) => { if (req) return 1; });\n";
        assert_eq!(complexity(src), vec![("walk".into(), 3), ("app.get callback".into(), 1)]);
    }

    #[test]
    fn names_functions_as_v8_does() {
        let names = |src: &str| read("a.ts", src).unwrap().funcs.into_iter().map(|f| f.name).collect::<Vec<_>>();
        assert_eq!(names("export default function stats() {}\n"), vec!["stats"]);
        assert_eq!(names("export default function () {}\n"), vec!["default"]);
        assert_eq!(names("class C { total() {} handle = () => 1; }\nconst o = { go() {}, run: function () {} };\n"), vec!["total", "handle", "go", "run"]);
    }

    #[test]
    fn finds_mutable_operators_but_not_in_logs_errors_text_or_types() {
        let src = "type T = true;\nexport function f(a: number, b: number) {\n  console.log(a > b);\n  if (!a) throw new Error('bad ' + (a - b));\n  return a < b && b + 1;\n}\nconst s = 'a' + 'b';\n";
        let shape = read("a.ts", src).unwrap();
        let sites: Vec<(u32, &str, &str)> = shape.sites.iter().map(|s| (s.line, s.from, s.to)).collect();
        assert_eq!(sites, vec![(4, "!", ""), (5, "&&", "||"), (5, "<", ">="), (5, "+", "-")]);
        assert_eq!(&src[shape.sites[2].start as usize..][..1], "<");
        let f = &shape.funcs[0];
        assert_eq!((f.name.as_str(), f.line, f.end_line, f.empty), ("f", 2, 6, false));
        assert_eq!(&src[f.body.0 as usize..f.body.0 as usize + 1], "{");
    }
}
