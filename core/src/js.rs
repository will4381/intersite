//! What the SQL and regex checks need from a JavaScript or TypeScript file, in one parse: SQL strings and the call
//! that runs them, database calls inside loops, and regular expressions with the name they are bound to.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::scope::ScopeFlags;

use crate::text::Lines;

pub struct SqlSite {
    pub line: u32,
    pub text: String,
}

pub struct DbInLoop {
    pub line: u32,
    pub call: String,
    pub loop_line: u32,
}

pub struct RegexSite {
    pub line: u32,
    pub pattern: String,
    pub name: Option<String>,
}

#[derive(Default)]
pub struct Facts {
    pub sql: Vec<SqlSite>,
    pub db_in_loops: Vec<DbInLoop>,
    pub regexes: Vec<RegexSite>,
}

/// Whether a string reads as a SQL statement, not prose that starts with "Select".
pub fn looks_like_sql(text: &str) -> bool {
    let t = text.trim_start().to_ascii_uppercase();
    let starts = ["SELECT ", "SELECT\n", "INSERT ", "UPDATE ", "DELETE ", "WITH ", "CREATE ", "ALTER ", "DROP "].iter().any(|k| t.starts_with(k));
    starts && [" FROM ", " INTO ", " SET ", " TABLE ", " INDEX ", "\nFROM ", "\nSET "].iter().any(|k| t.replace('\n', " \n").contains(k) || t.contains(k))
}

/// Database clients' usual names, for `prisma.user.findMany` and `db.select()`.
const CLIENTS: [&str; 10] = ["prisma", "db", "tx", "trx", "client", "database", "pool", "pg", "conn", "connection"];
const PRISMA_OPS: [&str; 7] = ["find", "create", "update", "delete", "upsert", "count", "aggregate"];

/// Whether a callee runs a query: `prisma.user.findMany`, `db.select`, `pool.query`, `supabase.from`.
fn is_db_call(callee: &str) -> bool {
    let parts: Vec<&str> = callee.trim_start_matches("this.").split('.').collect();
    let (Some(first), Some(last)) = (parts.first(), parts.last()) else { return false };
    let client = CLIENTS.contains(&first.trim_start_matches('_')) || first.to_ascii_lowercase().ends_with("prisma") || first.to_ascii_lowercase().ends_with("db");
    if first.to_ascii_lowercase().contains("supabase") && *last == "from" {
        return true;
    }
    if !client {
        return false;
    }
    match parts.len() {
        3 => PRISMA_OPS.iter().any(|op| last.starts_with(op)) || (parts[1] == "query" && last.starts_with("find")),
        2 => ["select", "insert", "update", "delete", "execute", "query", "$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"].contains(last),
        4 => parts[1] == "query" && last.starts_with("find"),
        _ => false,
    }
}

/// Array methods whose callback runs once per item: a query in one runs once per item too.
const PER_ITEM: [&str; 9] = ["map", "forEach", "flatMap", "filter", "reduce", "some", "every", "find", "findIndex"];

struct Walker<'s> {
    src: &'s str,
    lines: Lines,
    facts: Facts,
    /// The loop each enclosing function body sits in, innermost last: a function resets it, a per-item callback sets it.
    loops: Vec<Option<u32>>,
    pending_loop: Option<u32>,
    names: Vec<String>,
    seen_sql: std::collections::HashSet<u32>,
}

impl<'s> Walker<'s> {
    fn line(&self, offset: u32) -> u32 {
        self.lines.line(offset as usize)
    }

    fn text(&self, node: &impl GetSpan) -> &'s str {
        let span = node.span();
        &self.src[span.start as usize..span.end as usize]
    }

    fn current_loop(&self) -> Option<u32> {
        self.loops.last().copied().flatten()
    }

    fn with_loop(&mut self, line: u32, body: impl FnOnce(&mut Self)) {
        let saved = self.loops.last().copied().flatten();
        if let Some(top) = self.loops.last_mut() {
            *top = Some(line);
        }
        body(self);
        if let Some(top) = self.loops.last_mut() {
            *top = saved;
        }
    }

    fn sql(&mut self, offset: u32, text: String) {
        if self.seen_sql.insert(offset) {
            let line = self.line(offset);
            self.facts.sql.push(SqlSite { line, text });
        }
    }

    fn db_call(&mut self, offset: u32, call: &str) {
        if let Some(loop_line) = self.current_loop() {
            let line = self.line(offset);
            // `// oxlint-disable-next-line no-await-in-loop -- why` above the query or the loop: already decided.
            if self.waived(line) || self.waived(loop_line) {
                return;
            }
            self.facts.db_in_loops.push(DbInLoop { line, call: call.to_string(), loop_line });
        }
    }

    /// Whether the line above `line` waives await-in-loop with a reason.
    fn waived(&self, line: u32) -> bool {
        line >= 2 && self.src.lines().nth(line as usize - 2).is_some_and(|l| l.contains("no-await-in-loop") && l.contains("--"))
    }

    fn regex(&mut self, offset: u32, pattern: String) {
        let line = self.line(offset);
        let name = self.names.last().cloned();
        self.facts.regexes.push(RegexSite { line, pattern, name });
    }
}

/// The text of a template with each `${…}` as a positional parameter, `$1`, `$2`.
fn template_sql(t: &TemplateLiteral) -> String {
    let mut out = String::new();
    for (i, quasi) in t.quasis.iter().enumerate() {
        out.push_str(quasi.value.cooked.as_ref().map_or(quasi.value.raw.as_str(), |c| c.as_str()));
        if i + 1 < t.quasis.len() {
            out.push_str(&format!("${}", i + 1));
        }
    }
    out
}

fn last_segment(callee: &str) -> &str {
    callee.rsplit('.').next().unwrap_or(callee)
}

impl<'a, 's> Visit<'a> for Walker<'s> {
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        let frame = self.pending_loop.take();
        self.loops.push(frame);
        walk::walk_function(self, it, flags);
        self.loops.pop();
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        let frame = self.pending_loop.take();
        self.loops.push(frame);
        walk::walk_arrow_function_expression(self, it);
        self.loops.pop();
    }

    fn visit_for_statement(&mut self, it: &ForStatement<'a>) {
        let line = self.line(it.span.start);
        self.with_loop(line, |w| walk::walk_for_statement(w, it));
    }

    fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
        let line = self.line(it.span.start);
        self.with_loop(line, |w| walk::walk_for_of_statement(w, it));
    }

    fn visit_for_in_statement(&mut self, it: &ForInStatement<'a>) {
        let line = self.line(it.span.start);
        self.with_loop(line, |w| walk::walk_for_in_statement(w, it));
    }

    fn visit_while_statement(&mut self, it: &WhileStatement<'a>) {
        let line = self.line(it.span.start);
        self.with_loop(line, |w| walk::walk_while_statement(w, it));
    }

    fn visit_do_while_statement(&mut self, it: &DoWhileStatement<'a>) {
        let line = self.line(it.span.start);
        self.with_loop(line, |w| walk::walk_do_while_statement(w, it));
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let callee = self.text(&it.callee).to_string();
        if is_db_call(&callee) {
            self.db_call(it.span.start, &callee);
        }
        let method = last_segment(&callee);
        if ["query", "execute", "$queryRawUnsafe", "$executeRawUnsafe", "raw", "prepare", "unsafe", "exec", "run", "all", "get"].contains(&method) {
            if let Some(first) = it.arguments.first().and_then(|a| a.as_expression()) {
                let text = match first {
                    Expression::StringLiteral(s) => Some(s.value.as_str().to_string()),
                    Expression::TemplateLiteral(t) => Some(template_sql(t)),
                    _ => None,
                };
                if let Some(text) = text.filter(|t| looks_like_sql(t)) {
                    self.sql(first.span().start, text);
                }
            }
        }
        if callee == "RegExp" || callee == "new RegExp" {
            if let Some(Expression::StringLiteral(s)) = it.arguments.first().and_then(|a| a.as_expression()) {
                self.regex(s.span.start, s.value.as_str().to_string());
            }
        }
        let per_item = it.callee.as_member_expression().is_some() && PER_ITEM.contains(&method);
        if !per_item {
            walk::walk_call_expression(self, it);
            return;
        }
        self.visit_expression(&it.callee);
        let line = self.line(it.span.start);
        for argument in &it.arguments {
            let callback = matches!(argument.as_expression(), Some(Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)));
            if callback {
                self.pending_loop = Some(line);
            }
            self.visit_argument(argument);
            self.pending_loop = None;
        }
    }

    fn visit_new_expression(&mut self, it: &NewExpression<'a>) {
        if self.text(&it.callee) == "RegExp" {
            if let Some(Expression::StringLiteral(s)) = it.arguments.first().and_then(|a| a.as_expression()) {
                self.regex(s.span.start, s.value.as_str().to_string());
            }
        }
        walk::walk_new_expression(self, it);
    }

    fn visit_tagged_template_expression(&mut self, it: &TaggedTemplateExpression<'a>) {
        let tag = self.text(&it.tag).to_string();
        let method = last_segment(&tag);
        if ["sql", "SQL", "$queryRaw", "$executeRaw", "$queryRawUnsafe", "raw", "unsafe", "query"].contains(&method) {
            let text = template_sql(&it.quasi);
            if looks_like_sql(&text) {
                self.sql(it.quasi.span.start, text);
            }
            if method.starts_with('$') {
                self.db_call(it.span.start, &tag);
            }
        }
        walk::walk_tagged_template_expression(self, it);
    }

    fn visit_await_expression(&mut self, it: &AwaitExpression<'a>) {
        // `await sql\`…\`` runs the query (postgres.js); a bare sql`` may only build a fragment (Drizzle).
        if let Expression::TaggedTemplateExpression(t) = &it.argument {
            let tag = self.text(&t.tag).to_string();
            if last_segment(&tag) == "sql" {
                self.db_call(it.span.start, &tag);
            }
        }
        walk::walk_await_expression(self, it);
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        if looks_like_sql(it.value.as_str()) {
            self.sql(it.span.start, it.value.as_str().to_string());
        }
    }

    fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
        let text = template_sql(it);
        if looks_like_sql(&text) {
            self.sql(it.span.start, text);
        }
        walk::walk_template_literal(self, it);
    }

    fn visit_reg_exp_literal(&mut self, it: &RegExpLiteral<'a>) {
        self.regex(it.span.start, it.regex.pattern.text.as_str().to_string());
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let name = match &it.id {
            BindingPattern::BindingIdentifier(id) => Some(id.name.as_str().to_string()),
            _ => None,
        };
        if let Some(n) = &name {
            self.names.push(n.clone());
        }
        walk::walk_variable_declarator(self, it);
        if name.is_some() {
            self.names.pop();
        }
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        let key = it.key.static_name().map(|k| k.to_string());
        if let Some(k) = &key {
            self.names.push(k.clone());
        }
        walk::walk_object_property(self, it);
        if key.is_some() {
            self.names.pop();
        }
    }
}

/// The facts of one file, or None when it does not parse.
/// Parses a JavaScript or TypeScript file and hands its program to `f`; None when the parser gave up on it.
pub fn parse<R>(path: &str, src: &str, f: impl FnOnce(&Program<'_>) -> R) -> Option<R> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, src, SourceType::from_path(path).unwrap_or_default()).parse();
    (!parsed.panicked).then(|| f(&parsed.program))
}

pub fn facts(path: &str, src: &str) -> Option<Facts> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let parsed = Parser::new(&allocator, src, source_type).parse();
    if parsed.panicked {
        return None;
    }
    let mut walker = Walker { src, lines: Lines::new(src), facts: Facts::default(), loops: vec![None], pending_loop: None, names: vec![], seen_sql: Default::default() };
    walker.visit_program(&parsed.program);
    Some(walker.facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_sql_queries_in_loops_and_named_regexes() {
        let src = "const EMAIL = /^[^@]+@[^@]+$/;\nexport async function load(ids) {\n  for (const id of ids) {\n    await prisma.user.findUnique({ where: { id } });\n  }\n  await Promise.all(ids.map((id) => db.select().from(users)));\n  return pool.query(`SELECT * FROM users WHERE id = ${ids[0]}`);\n}\n";
        let f = facts("a.ts", src).unwrap();
        assert_eq!(f.db_in_loops.iter().map(|d| (d.line, d.call.as_str(), d.loop_line)).collect::<Vec<_>>(), vec![(4, "prisma.user.findUnique", 3), (6, "db.select", 6)]);
        assert_eq!(f.sql.len(), 1);
        assert_eq!(f.sql[0].text, "SELECT * FROM users WHERE id = $1");
        assert_eq!(f.regexes[0].name.as_deref(), Some("EMAIL"));
    }
}
