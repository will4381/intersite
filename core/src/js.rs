//! JavaScript and TypeScript helpers the checks share: parsing, string literals, environment reads, and what the SQL
//! and regex checks need from a file in one parse (SQL strings and the call that runs them, database calls inside
//! loops, and regular expressions with the name they are bound to).

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use oxc_syntax::scope::ScopeFlags;

use crate::text::Lines;

pub struct SqlSite {
    pub line: u32,
    /// A template's `${…}` written as `$1`, `$2`, … in order.
    pub text: String,
    /// The source of each `${…}`, for `$1` onwards: a Drizzle table interpolated as a table name is `keys`.
    pub params: Vec<String>,
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

/// A Supabase or knex `.delete()` / `.update()` on a table with no filter in its chain: every row.
pub struct Wipe {
    pub line: u32,
    pub method: String,
    pub table: String,
}

#[derive(Default)]
pub struct Facts {
    pub sql: Vec<SqlSite>,
    pub db_in_loops: Vec<DbInLoop>,
    pub regexes: Vec<RegexSite>,
    pub wipes: Vec<Wipe>,
}

/// Whether a string reads as a SQL statement, not prose that starts with "Select".
pub fn looks_like_sql(text: &str) -> bool {
    // TRUNCATE names only tables; written in capitals or with TABLE it is SQL, not "Truncate long names".
    let trimmed = text.trim_start();
    if trimmed.starts_with("TRUNCATE ") || trimmed.to_ascii_uppercase().starts_with("TRUNCATE TABLE ") {
        return true;
    }
    let t = trimmed.to_ascii_uppercase();
    let starts =
        ["SELECT ", "SELECT\n", "INSERT ", "UPDATE ", "DELETE ", "WITH ", "CREATE ", "ALTER ", "DROP "].iter().any(|k| t.starts_with(k));
    starts
        && [" FROM ", " INTO ", " SET ", " TABLE ", " INDEX ", "\nFROM ", "\nSET "]
            .iter()
            .any(|k| t.replace('\n', " \n").contains(k) || t.contains(k))
}

/// Database clients' usual names, for `prisma.user.findMany` and `db.select()`.
const CLIENTS: [&str; 10] = ["prisma", "db", "tx", "trx", "client", "database", "pool", "pg", "conn", "connection"];
const PRISMA_OPS: [&str; 7] = ["find", "create", "update", "delete", "upsert", "count", "aggregate"];

/// Whether a callee runs a query: `prisma.user.findMany`, `db.select`, `pool.query`, `supabase.from`.
fn is_db_call(callee: &str) -> bool {
    let parts: Vec<&str> = callee.trim_start_matches("this.").split('.').collect();
    let (Some(first), Some(last)) = (parts.first(), parts.last()) else { return false };
    let client = CLIENTS.contains(&first.trim_start_matches('_'))
        || first.to_ascii_lowercase().ends_with("prisma")
        || first.to_ascii_lowercase().ends_with("db");
    if first.to_ascii_lowercase().contains("supabase") && *last == "from" {
        return true;
    }
    if !client {
        return false;
    }
    match parts.len() {
        3 => PRISMA_OPS.iter().any(|op| last.starts_with(op)) || (parts[1] == "query" && last.starts_with("find")),
        2 => {
            ["select", "insert", "update", "delete", "execute", "query", "$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]
                .contains(last)
        }
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
    /// Calls already read as part of a longer chain, by span start.
    chained: std::collections::HashSet<u32>,
    /// Calls kept in a variable unawaited: a query builder whose filter is added later.
    kept: std::collections::HashSet<u32>,
}

/// Comparisons a Supabase (PostgREST) or knex query filters a column with.
pub const COMPARISONS: [&str; 12] = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains", "containedBy"];
/// The other methods that narrow such a query to some rows.
const ROW_FILTERS: [&str; 10] = ["overlaps", "match", "filter", "not", "or", "textSearch", "rangeGt", "rangeLt", "limit", "single"];

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

    fn sql(&mut self, offset: u32, text: String, params: Vec<String>) {
        if self.seen_sql.insert(offset) {
            let line = self.line(offset);
            self.facts.sql.push(SqlSite { line, text, params });
        }
    }

    fn params(&self, t: &TemplateLiteral) -> Vec<String> {
        t.expressions.iter().map(|e| self.text(e).to_string()).collect()
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

    /// A chain read from its outermost call: `supabase.from("t").delete()` with no `.eq(...)` after it.
    fn wipe(&mut self, top: &CallExpression) {
        let mut methods = Vec::new();
        let mut table = None;
        let mut call = top;
        while let Some(m) = call.callee.as_member_expression() {
            let Some(name) = m.static_property_name() else { break };
            methods.push(name);
            if name == "from" {
                if let Some(Expression::StringLiteral(s)) = call.arguments.first().and_then(|a| a.as_expression()) {
                    table = Some(s.value.to_string());
                }
                if !matches!(m.object(), Expression::Identifier(id) if ["Array", "Buffer", "Object"].contains(&id.name.as_str())) {
                    break;
                }
                table = None;
                break;
            }
            let Expression::CallExpression(inner) = m.object() else { break };
            self.chained.insert(inner.span.start);
            call = inner;
        }
        let Some(table) = table else { return };
        let Some(method) = methods.iter().find(|m| **m == "delete" || **m == "update") else { return };
        if self.kept.contains(&top.span.start)
            || methods
                .iter()
                .any(|m| COMPARISONS.contains(m) || ROW_FILTERS.contains(m) || m.starts_with("where") || m.starts_with("range"))
        {
            return;
        }
        let line = self.line(top.span.start);
        self.facts.wipes.push(Wipe { line, method: method.to_string(), table });
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
        if self.chained.insert(it.span.start) {
            self.wipe(it);
        }
        let callee = self.text(&it.callee).to_string();
        if is_db_call(&callee) {
            self.db_call(it.span.start, &callee);
        }
        let method = last_segment(&callee);
        if ["query", "execute", "$queryRawUnsafe", "$executeRawUnsafe", "raw", "prepare", "unsafe", "exec", "run", "all", "get"]
            .contains(&method)
        {
            if let Some(first) = it.arguments.first().and_then(|a| a.as_expression()) {
                let text = match first {
                    Expression::StringLiteral(s) => Some((s.value.as_str().to_string(), vec![])),
                    Expression::TemplateLiteral(t) => Some((template_sql(t), self.params(t))),
                    _ => None,
                };
                if let Some((text, params)) = text.filter(|(t, _)| looks_like_sql(t)) {
                    self.sql(first.span().start, text, params);
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
            let callback =
                matches!(argument.as_expression(), Some(Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)));
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
                let params = self.params(&it.quasi);
                self.sql(it.quasi.span.start, text, params);
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
            self.sql(it.span.start, it.value.as_str().to_string(), vec![]);
        }
    }

    fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
        let text = template_sql(it);
        if looks_like_sql(&text) {
            let params = self.params(it);
            self.sql(it.span.start, text, params);
        }
        walk::walk_template_literal(self, it);
    }

    fn visit_reg_exp_literal(&mut self, it: &RegExpLiteral<'a>) {
        self.regex(it.span.start, it.regex.pattern.text.as_str().to_string());
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let Some(Expression::CallExpression(call)) = &it.init {
            self.kept.insert(call.span.start);
        }
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

/// A string literal's value, or a template literal's with no substitutions: as written when `raw`, else with its
/// escapes applied.
pub fn string<'b>(e: &'b Expression, raw: bool) -> Option<&'b str> {
    match e {
        Expression::StringLiteral(s) => Some(s.value.as_str()),
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => {
            let q = &t.quasis.first()?.value;
            if raw {
                Some(q.raw.as_str())
            } else {
                q.cooked.as_ref().map(|c| c.as_str())
            }
        }
        _ => None,
    }
}

/// `process.env`, `import.meta.env`, `Bun.env`: the object an environment variable is read from.
pub fn is_env_object(text: &str) -> bool {
    matches!(text, "process.env" | "import.meta.env" | "Bun.env")
}

/// An env module: the one place a project reads and validates its environment.
pub fn is_env_module(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    let stem = name.split('.').next().unwrap_or(name);
    matches!(stem, "env" | "config" | "settings" | "environment") || file.contains("/env/") || file.contains("/config/")
}

/// Parses a JavaScript or TypeScript file and hands its program to `f`; None when the parser gave up on it.
pub fn parse<R>(path: &str, src: &str, f: impl FnOnce(&Program<'_>) -> R) -> Option<R> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, src, SourceType::from_path(path).unwrap_or_default()).parse();
    (!parsed.panicked).then(|| f(&parsed.program))
}

/// The facts of one file, or None when it does not parse.
pub fn facts(path: &str, src: &str) -> Option<Facts> {
    parse(path, src, |program| {
        let mut walker = Walker {
            src,
            lines: Lines::new(src),
            facts: Facts::default(),
            loops: vec![None],
            pending_loop: None,
            names: vec![],
            seen_sql: Default::default(),
            chained: Default::default(),
            kept: Default::default(),
        };
        walker.visit_program(program);
        walker.facts
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_sql_queries_in_loops_and_named_regexes() {
        let src = "const EMAIL = /^[^@]+@[^@]+$/;\nexport async function load(ids) {\n  for (const id of ids) {\n    await prisma.user.findUnique({ where: { id } });\n  }\n  await Promise.all(ids.map((id) => db.select().from(users)));\n  return pool.query(`SELECT * FROM users WHERE id = ${ids[0]}`);\n}\n";
        let f = facts("a.ts", src).unwrap();
        assert_eq!(
            f.db_in_loops.iter().map(|d| (d.line, d.call.as_str(), d.loop_line)).collect::<Vec<_>>(),
            vec![(4, "prisma.user.findUnique", 3), (6, "db.select", 6)]
        );
        assert_eq!(f.sql.len(), 1);
        assert_eq!(f.sql[0].text, "SELECT * FROM users WHERE id = $1");
        assert_eq!(f.regexes[0].name.as_deref(), Some("EMAIL"));
    }
}
