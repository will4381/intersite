//! The states check: the values a workflow's columns may hold, and the code that writes and tests them. A column's
//! values are a closed set where the schema says so: a Prisma enum, a Postgres enum, or a CHECK that lists them. Code is
//! read where the table is certain: a Prisma call on the model, and SQL in a string that names the table. Three things
//! are reported. A value written or tested that the set does not have: the database refuses the write, the test is
//! never true. One list of values tested in three or more files: the rule "which states count" written many times, so
//! the next state has to be added to each. One change of state written in four or more functions across three or more
//! files: one step of the workflow, each copy free to forget what the others do with it.
//!
//! The first is the code and the schema disagreeing, which is a fact. The other two count copies, after the finding
//! that inconsistent changes to copied code are where its faults come from (Juergens et al., "Do code clones
//! matter?", ICSE 2009).

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use oxc_syntax::scope::ScopeFlags;
use rayon::prelude::*;
use regex::Regex;
use sqlparser::ast as sq;
use sqlparser::ast::{Visit as SqlVisit, Visitor};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::Location;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::ControlFlow;
use std::sync::LazyLock;

use crate::columns;
use crate::constraints::{self, text_of, unwrapped, Allowed};
use crate::datamodel::{self, Schemas};
use crate::text::{self, Lines};
use crate::{js, sql, Answer, Finding, Request};

/// A list is one rule written many times from this many files.
const LIST_FILES: usize = 3;
/// A change of state is one step written many times from this many functions, in this many files.
const STEP_FUNCTIONS: usize = 4;
const STEP_FILES: usize = 3;

/// How code reaches the database: Prisma writes an enum member's name, SQL the value the database stores.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Via {
    Prisma,
    Sql,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum How {
    Test,
    Insert,
    Update,
}

impl Allowed {
    /// The stored value a piece of code means by `value`, when the column may hold it.
    fn stored_for(&self, via: Via, value: &str) -> Option<String> {
        if via == Via::Prisma && !self.names.is_empty() {
            return self.names.get(value).cloned();
        }
        self.stored.contains(value).then(|| value.to_string())
    }

    /// The values as `via` writes them.
    fn spelled(&self, via: Via) -> Vec<&str> {
        let mut out: Vec<&str> = if via == Via::Prisma && !self.names.is_empty() {
            self.names.keys().map(String::as_str).collect()
        } else {
            self.stored.iter().map(String::as_str).collect()
        };
        out.sort_unstable();
        out
    }
}

/// What the schemas say of the columns code is read against.
#[derive(Default)]
struct Shape {
    /// (table, column) -> its values.
    sets: HashMap<(String, String), Allowed>,
    /// A Prisma accessor (`orderItem`) -> its table.
    accessors: HashMap<String, String>,
    /// (table, the name code uses) -> the column.
    keys: HashMap<(String, String), String>,
}

fn shape(schemas: &Schemas) -> Shape {
    let sets = constraints::allowed(schemas, &constraints::checks(&schemas.sql_files));
    let mut out = Shape { sets, ..Default::default() };
    for table in schemas.tables.values() {
        if table.source == 2 {
            out.accessors.insert(columns::lower_first(&table.model), table.name.clone());
        }
        for column in &table.columns {
            if out.sets.contains_key(&(table.name.clone(), column.name.clone())) {
                out.keys.insert((table.name.clone(), column.key.clone()), column.name.clone());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Code: the values written to and tested against those columns.

struct Use {
    table: String,
    column: String,
    value: String,
    how: How,
    via: Via,
    line: u32,
}

/// Several values tested in one go: `status IN ('a', 'b')`, `{ in: ["a", "b"] }`.
struct Listed {
    table: String,
    column: String,
    values: Vec<String>,
    via: Via,
    line: u32,
}

#[derive(Default)]
struct Seen {
    file: String,
    /// The package the file is in: a rule is written many times within one program.
    package: String,
    /// Code the product runs, not a script, a seed or a test's helper.
    product: bool,
    uses: Vec<Use>,
    lists: Vec<Listed>,
    /// Each named function's first line, last line and name.
    functions: Vec<(u32, u32, String)>,
}

impl Seen {
    /// The innermost named function a line is in, with the line it starts on; empty at the top of the file.
    fn function_at(&self, line: u32) -> String {
        let inside = self.functions.iter().filter(|f| f.0 <= line && line <= f.1).min_by_key(|f| f.1 - f.0);
        inside.map_or(String::new(), |f| format!("{}@{}", f.2, f.0))
    }
}

/// Prisma calls that take `where`, `data`, `create` or `update`.
const PRISMA_CALLS: [&str; 17] = [
    "findMany",
    "findFirst",
    "findUnique",
    "findFirstOrThrow",
    "findUniqueOrThrow",
    "count",
    "aggregate",
    "groupBy",
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
    "delete",
    "deleteMany",
];

struct Walker<'m> {
    shape: &'m Shape,
    lines: Lines,
    seen: Seen,
}

/// An object literal's properties by their static names.
fn entries<'b, 'a>(object: &'b ObjectExpression<'a>) -> Vec<(String, &'b Expression<'a>)> {
    object
        .properties
        .iter()
        .filter_map(|p| match p {
            ObjectPropertyKind::ObjectProperty(p) => Some((p.key.static_name()?.to_string(), &p.value)),
            ObjectPropertyKind::SpreadProperty(_) => None,
        })
        .collect()
}

/// The object literals of a value that is one, or an array of them.
fn objects<'b, 'a>(e: &'b Expression<'a>) -> Vec<&'b ObjectExpression<'a>> {
    let object = |e: &'b Expression<'a>| match e.get_inner_expression() {
        Expression::ObjectExpression(o) => Some(&**o),
        _ => None,
    };
    match e.get_inner_expression() {
        Expression::ArrayExpression(a) => a.elements.iter().filter_map(|e| e.as_expression()).filter_map(object).collect(),
        _ => object(e).into_iter().collect(),
    }
}

fn is_function(e: &Expression) -> bool {
    matches!(e.get_inner_expression(), Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_))
}

impl Walker<'_> {
    fn line(&self, offset: u32) -> u32 {
        self.lines.line(offset as usize)
    }

    fn function(&mut self, name: &str, span: oxc_span::Span) {
        let range = (self.line(span.start), self.line(span.end), name.to_string());
        self.seen.functions.push(range);
    }

    fn column(&self, table: &str, key: &str) -> Option<String> {
        self.shape.keys.get(&(table.to_string(), key.to_string())).cloned()
    }

    fn used(&mut self, table: &str, column: &str, value: &str, how: How, offset: u32) {
        let line = self.line(offset);
        self.seen.uses.push(Use { table: table.into(), column: column.into(), value: value.into(), how, via: Via::Prisma, line });
    }

    /// A `where`: its columns, and those under AND, OR and NOT. A relation's own filter is another table's.
    fn filter(&mut self, table: &str, object: &ObjectExpression) {
        for (key, value) in entries(object) {
            if matches!(key.as_str(), "AND" | "OR" | "NOT") {
                for inner in objects(value) {
                    self.filter(table, inner);
                }
            } else if let Some(column) = self.column(table, &key) {
                self.tested(table, &column, value);
            }
        }
    }

    fn tested(&mut self, table: &str, column: &str, value: &Expression) {
        let value = value.get_inner_expression();
        if let Some(text) = js::string(value, false) {
            self.used(table, column, text, How::Test, value.span().start);
            return;
        }
        let Expression::ObjectExpression(object) = value else { return };
        for (key, inner) in entries(object) {
            match (key.as_str(), inner.get_inner_expression()) {
                ("equals" | "not", _) => self.tested(table, column, inner),
                ("in" | "notIn", Expression::ArrayExpression(array)) => {
                    let found: Vec<(&str, u32)> = array
                        .elements
                        .iter()
                        .filter_map(|e| e.as_expression())
                        .filter_map(|e| Some((js::string(e.get_inner_expression(), false)?, e.span().start)))
                        .collect();
                    if found.len() == array.elements.len() && found.len() >= 2 {
                        let values = found.iter().map(|f| f.0.to_string()).collect();
                        let line = self.line(array.span.start);
                        self.seen.lists.push(Listed { table: table.into(), column: column.into(), values, via: Via::Prisma, line });
                    }
                    for (text, offset) in found {
                        self.used(table, column, text, How::Test, offset);
                    }
                }
                _ => {}
            }
        }
    }

    fn written(&mut self, table: &str, object: &ObjectExpression, how: How) {
        for (key, value) in entries(object) {
            let Some(column) = self.column(table, &key) else { continue };
            let value = value.get_inner_expression();
            // `{ set: "paid" }` is the long way to write "paid".
            let set = match value {
                Expression::ObjectExpression(o) => entries(o).into_iter().find(|(k, _)| k == "set").map(|(_, v)| v.get_inner_expression()),
                _ => None,
            };
            let value = set.unwrap_or(value);
            if let Some(text) = js::string(value, false) {
                self.used(table, &column, text, how, value.span().start);
            }
        }
    }

    /// `prisma.order.update({ where, data })`, `tx.order.findMany({ where })`.
    fn prisma(&mut self, call: &CallExpression) {
        let Some(member) = call.callee.get_inner_expression().as_member_expression() else { return };
        let Some(method) = member.static_property_name().filter(|m| PRISMA_CALLS.contains(m)) else { return };
        let Some(inner) = member.object().get_inner_expression().as_member_expression() else { return };
        let Some(table) = inner.static_property_name().and_then(|accessor| self.shape.accessors.get(accessor)).cloned() else { return };
        let Some(Expression::ObjectExpression(args)) =
            call.arguments.first().and_then(|a| a.as_expression()).map(|e| e.get_inner_expression())
        else {
            return;
        };
        for (key, value) in entries(args) {
            let how = match key.as_str() {
                "where" => How::Test,
                "update" => How::Update,
                "data" if method.starts_with("update") => How::Update,
                "data" | "create" => How::Insert,
                _ => continue,
            };
            for object in objects(value) {
                if how == How::Test {
                    self.filter(&table, object);
                } else {
                    self.written(&table, object, how);
                }
            }
        }
    }
}

impl<'a> Visit<'a> for Walker<'_> {
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        if let Some(id) = &it.id {
            self.function(id.name.as_str(), it.span);
        }
        walk::walk_function(self, it, flags);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (Some(id), Some(init)) = (it.id.get_binding_identifier(), it.init.as_ref().filter(|e| is_function(e))) {
            self.function(id.name.as_str(), init.span());
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_method_definition(&mut self, it: &MethodDefinition<'a>) {
        if let Some(name) = it.key.static_name() {
            self.function(&name, it.span);
        }
        walk::walk_method_definition(self, it);
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        if let Some(name) = it.key.static_name().filter(|_| is_function(&it.value)) {
            self.function(&name, it.span);
        }
        walk::walk_object_property(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        self.prisma(it);
        walk::walk_call_expression(self, it);
    }
}

/// The tables one SQL statement names, and what each name in it stands for.
#[derive(Default)]
struct Scope {
    /// A table's name or alias -> the table; None when the statement uses the name for two things, or for a subquery.
    names: HashMap<String, Option<String>>,
    /// Every relation the statement names, tables and CTEs alike.
    relations: HashSet<String>,
    ctes: HashSet<String>,
}

impl Scope {
    fn name(&mut self, name: String, table: Option<&str>) {
        let table = table.map(str::to_string);
        let slot = self.names.entry(name).or_insert_with(|| table.clone());
        if *slot != table {
            *slot = None;
        }
    }

    /// A name a CTE took is no table's in this statement.
    fn settle(&mut self) {
        let ctes = &self.ctes;
        for (name, table) in &mut self.names {
            if ctes.contains(name) || table.as_ref().is_some_and(|t| ctes.contains(t)) {
                *table = None;
            }
        }
    }

    /// The table a column is certainly of: the one its qualifier names, or the only relation the statement has.
    fn table(&self, qualifier: Option<&str>) -> Option<&str> {
        match qualifier {
            Some(q) => self.names.get(q)?.as_deref(),
            None => {
                let mut all = self.relations.iter();
                let only = all.next().filter(|t| !self.ctes.contains(*t))?;
                all.next().is_none().then_some(only.as_str())
            }
        }
    }

    /// The table and column an expression names, when the table is certain.
    fn column(&self, e: &sq::Expr) -> Option<(String, String)> {
        let (qualifier, column) = match unwrapped(e) {
            sq::Expr::Identifier(i) => (None, i),
            sq::Expr::CompoundIdentifier(parts) if parts.len() >= 2 => (Some(parts[parts.len() - 2].value.to_lowercase()), parts.last()?),
            _ => return None,
        };
        Some((self.table(qualifier.as_deref())?.to_string(), columns::ident(&column.to_string())))
    }
}

impl Visitor for Scope {
    type Break = ();

    fn pre_visit_query(&mut self, query: &sq::Query) -> ControlFlow<()> {
        self.ctes.extend(query.with.iter().flat_map(|w| &w.cte_tables).map(|cte| cte.alias.name.value.to_lowercase()));
        ControlFlow::Continue(())
    }

    fn pre_visit_relation(&mut self, relation: &sq::ObjectName) -> ControlFlow<()> {
        self.relations.insert(sql::bare(&relation.to_string()));
        ControlFlow::Continue(())
    }

    fn pre_visit_table_factor(&mut self, factor: &sq::TableFactor) -> ControlFlow<()> {
        match factor {
            sq::TableFactor::Table { name, alias, .. } => {
                let table = sql::bare(&name.to_string());
                self.name(table.clone(), Some(&table));
                if let Some(alias) = alias {
                    self.name(alias.name.value.to_lowercase(), Some(&table));
                }
            }
            sq::TableFactor::Derived { alias: Some(alias), .. } => self.name(alias.name.value.to_lowercase(), None),
            _ => {}
        }
        ControlFlow::Continue(())
    }
}

/// One column with the literals a statement sets it to or tests it against.
struct Found {
    at: (String, String),
    values: Vec<(String, Location)>,
    how: How,
    /// The values were written as one list.
    listed: bool,
}

/// The literals an assignment may leave in the column: the value itself, or each branch of a CASE.
fn results(value: &sq::Expr) -> Vec<(String, Location)> {
    match unwrapped(value) {
        sq::Expr::Case { conditions, else_result, .. } => {
            conditions.iter().map(|c| &c.result).chain(else_result.as_deref()).filter_map(text_of).collect()
        }
        other => text_of(other).into_iter().collect(),
    }
}

/// What an UPDATE sets and an INSERT's VALUES hold, by column.
fn sql_writes(statement: &sq::Statement) -> Vec<Found> {
    let named = |name: &sq::ObjectName| name.0.last().and_then(|p| p.as_ident()).map(|i| columns::ident(&i.to_string()));
    match statement {
        sq::Statement::Update(update) => {
            let sq::TableFactor::Table { name, .. } = &update.table.relation else { return vec![] };
            let table = sql::bare(&name.to_string());
            let set = |a: &sq::Assignment| match &a.target {
                sq::AssignmentTarget::ColumnName(target) => {
                    Some(Found { at: (table.clone(), named(target)?), values: results(&a.value), how: How::Update, listed: false })
                }
                sq::AssignmentTarget::Tuple(_) => None,
            };
            update.assignments.iter().filter_map(set).collect()
        }
        sq::Statement::Insert(insert) => {
            let sq::TableObject::TableName(name) = &insert.table else { return vec![] };
            let table = sql::bare(&name.to_string());
            let Some(sq::SetExpr::Values(values)) = insert.source.as_ref().map(|q| &*q.body) else { return vec![] };
            let cell = |(column, value): (&sq::ObjectName, &sq::Expr)| {
                Some(Found {
                    at: (table.clone(), named(column)?),
                    values: text_of(value).into_iter().collect(),
                    how: How::Insert,
                    listed: false,
                })
            };
            values.rows.iter().flat_map(|row| insert.columns.iter().zip(&row.content).filter_map(cell)).collect()
        }
        _ => vec![],
    }
}

/// What a statement's expressions test: `status = 'a'`, `status <> 'a'`, `status IN ('a', 'b')`, `status = ANY (ARRAY[…])`.
fn sql_tests(statement: &sq::Statement, scope: &Scope) -> Vec<Found> {
    let mut out = vec![];
    let _ = sq::visit_expressions(statement, |e: &sq::Expr| {
        let listed = |column: &sq::Expr, list: &[sq::Expr]| {
            let values: Vec<(String, Location)> = list.iter().filter_map(text_of).collect();
            Some(Found { at: scope.column(column)?, listed: values.len() == list.len(), values, how: How::Test })
        };
        match e {
            sq::Expr::BinaryOp { left, op: sq::BinaryOperator::Eq | sq::BinaryOperator::NotEq, right } => {
                let single = |column: &sq::Expr, value: &sq::Expr| {
                    Some(Found { at: scope.column(column)?, values: vec![text_of(value)?], how: How::Test, listed: false })
                };
                out.extend(single(left, right).or_else(|| single(right, left)));
            }
            sq::Expr::In { expr, target: sq::InTarget::List(list), .. } => out.extend(listed(expr, list)),
            sq::Expr::AnyOp { left, compare_op: sq::BinaryOperator::Eq, right, .. } => {
                if let sq::Expr::Array(array) = unwrapped(right) {
                    out.extend(listed(left, &array.elem));
                }
            }
            _ => {}
        }
        ControlFlow::<()>::Continue(())
    });
    out
}

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$(\d+)").unwrap());

/// The uses in one SQL string. Each statement is parsed on its own, as Postgres; one that does not parse is skipped.
fn sql_uses(site: &js::SqlSite, shape: &Shape, seen: &mut Seen) {
    let lines = Lines::new(&site.text);
    // A `${…}` that ran over several lines is one `$n` in the text: what follows it sits that many lines further down.
    let folded: Vec<(usize, u32)> = PLACEHOLDER
        .captures_iter(&site.text)
        .filter_map(|m| Some((m.get(0)?.start(), *site.folds.get(m[1].parse::<usize>().ok()?.checked_sub(1)?)?)))
        .collect();
    for (offset, piece) in sql::split(&site.text) {
        let Ok(statements) = Parser::parse_sql(&PostgreSqlDialect {}, piece) else { continue };
        let starts: Vec<usize> = std::iter::once(0).chain(piece.match_indices('\n').map(|(i, _)| i + 1)).collect();
        // The line of the file a place in the piece is on.
        let line = |at: Location| {
            let within = starts.get(at.line.saturating_sub(1) as usize).copied().unwrap_or(0) + at.column.saturating_sub(1) as usize;
            let place = (offset + within).min(site.text.len());
            site.line + lines.line(place) - 1 + folded.iter().filter(|f| f.0 < place).map(|f| f.1).sum::<u32>()
        };
        for statement in &statements {
            let mut scope = Scope::default();
            let _ = SqlVisit::visit(statement, &mut scope);
            scope.settle();
            for found in sql_writes(statement).into_iter().chain(sql_tests(statement, &scope)) {
                if !shape.sets.contains_key(&found.at) || found.values.is_empty() {
                    continue;
                }
                let (table, column) = found.at;
                if found.listed && found.values.len() >= 2 {
                    let values = found.values.iter().map(|v| v.0.clone()).collect();
                    seen.lists.push(Listed {
                        table: table.clone(),
                        column: column.clone(),
                        values,
                        via: Via::Sql,
                        line: line(found.values[0].1),
                    });
                }
                for (value, at) in found.values {
                    seen.uses.push(Use {
                        table: table.clone(),
                        column: column.clone(),
                        value,
                        how: found.how,
                        via: Via::Sql,
                        line: line(at),
                    });
                }
            }
        }
    }
}

/// Text a file has when it may query a database at all: a Prisma call's shape, or a SQL verb.
static QUERIES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\.(?:find|create|update|upsert|delete|count|aggregate|groupBy)\w*\(|(?i)\b(?:select|insert|update|delete)\s").unwrap()
});

fn read_code(root: &str, file: &str, shape: &Shape) -> Option<Seen> {
    let src = text::read(root, file).filter(|src| QUERIES.is_match(src))?;
    let mut seen = js::parse(file, &src, |program| {
        let mut walker = Walker { shape, lines: Lines::new(&src), seen: Seen { file: file.to_string(), ..Default::default() } };
        walker.visit_program(program);
        walker.seen
    })?;
    for site in js::facts(file, &src).map(|f| f.sql).unwrap_or_default() {
        sql_uses(&site, shape, &mut seen);
    }
    (!seen.uses.is_empty()).then_some(seen)
}

fn is_code(file: &str) -> bool {
    matches!(file.rsplit('.').next(), Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts")) && !file.ends_with(".d.ts")
}

// ---------------------------------------------------------------------------------------------------------------
// The findings.

/// Up to six of a column's values, for a message.
fn shown(values: &[&str]) -> String {
    let more = if values.len() > 6 { ", …" } else { "" };
    format!("{}{more}", values.iter().take(6).copied().collect::<Vec<_>>().join(", "))
}

/// The value a slip of the hand away, when there is one.
fn nearest<'v>(value: &str, values: &[&'v str]) -> Option<&'v str> {
    let lower = value.to_lowercase();
    let (distance, found) = values.iter().map(|v| (text::distance(&lower, &v.to_lowercase()), *v)).min()?;
    (distance <= 2 && distance * 3 <= value.len().max(found.len())).then_some(found)
}

/// A value the code writes or tests that the column cannot hold.
fn unknown(request: &Request, shape: &Shape, seen: &[Seen], out: &mut Vec<Finding>) {
    for (file, used) in seen.iter().flat_map(|s| s.uses.iter().map(move |u| (&s.file, u))) {
        let allowed = &shape.sets[&(used.table.clone(), used.column.clone())];
        if allowed.stored_for(used.via, &used.value).is_some() || !request.changed(file, used.line) {
            continue;
        }
        let spelled = allowed.spelled(used.via);
        let prisma_name = allowed.names.iter().find(|(_, stored)| **stored == used.value).map(|(name, _)| name);
        let hint = match (used.via, allowed.names.get(&used.value), prisma_name) {
            (Via::Sql, Some(stored), _) => format!(" '{}' is Prisma's name for the value; SQL holds '{stored}'.", used.value),
            (Via::Prisma, _, Some(name)) => format!(" '{}' is the stored value; Prisma's name for it is '{name}'.", used.value),
            _ => nearest(&used.value, &spelled).map_or(String::new(), |n| format!(" Did you mean '{n}'?")),
        };
        let (does, so) = match used.how {
            How::Test => (format!("tests {}.{} against '{}'", used.table, used.column, used.value), "the test is never true"),
            _ => (format!("writes '{}' to {}.{}", used.value, used.table, used.column), "the database refuses the write"),
        };
        out.push(Finding {
            file: file.clone(),
            line: used.line,
            target: format!("states:unknown:{}.{}={}", used.table, used.column, used.value),
            message: format!("{file}:{} {does}, which {} does not allow ({}): {so}.{hint}", used.line, allowed.by, shown(&spelled)),
        });
    }
}

/// A place in the code: its file and line.
type Site<'s> = (&'s String, u32);
/// (package, table, column, the stored values of one list) -> where it is written.
type Lists<'s> = BTreeMap<(&'s str, &'s str, &'s str, BTreeSet<String>), Vec<Site<'s>>>;
/// (package, table, column, a stored value) -> where it is set, and the functions those places are in.
type Steps<'s> = BTreeMap<(&'s str, &'s str, &'s str, String), (Vec<Site<'s>>, BTreeSet<(&'s String, String)>)>;

/// Where else a thing is written: up to three places and how many more.
fn elsewhere(sites: &[Site], but: Site) -> String {
    let mut others: Vec<String> = sites.iter().filter(|s| **s != but).map(|(file, line)| format!("{file}:{line}")).collect();
    others.dedup();
    let more = others.len().saturating_sub(3);
    others.truncate(3);
    format!("also {}{}", others.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() })
}

fn files_of(sites: &[Site]) -> usize {
    sites.iter().map(|s| s.0).collect::<BTreeSet<_>>().len()
}

/// One list of values tested in several files.
fn repeated_lists(request: &Request, shape: &Shape, seen: &[Seen], out: &mut Vec<Finding>) {
    let mut groups: Lists = BTreeMap::new();
    for (file, list) in seen.iter().filter(|s| s.product).flat_map(|s| s.lists.iter().map(move |l| (s, l))) {
        let allowed = &shape.sets[&(list.table.clone(), list.column.clone())];
        // A list with a value the column cannot hold is the first finding's, not a rule to name.
        let Some(values) = list.values.iter().map(|v| allowed.stored_for(list.via, v)).collect::<Option<BTreeSet<String>>>() else {
            continue;
        };
        if values.len() >= 2 {
            groups.entry((&file.package, &list.table, &list.column, values)).or_default().push((&file.file, list.line));
        }
    }
    groups.values_mut().for_each(|sites| sites.sort());
    for ((package, table, column, values), sites) in &groups {
        let files = files_of(sites);
        let Some(&at) = sites.iter().find(|(file, line)| request.changed(file, *line)).filter(|_| files >= LIST_FILES) else { continue };
        // The same list one value longer or shorter, where it is written most: the two may be one rule that drifted.
        let variant = groups
            .iter()
            .filter(|((p, t, c, other), _)| {
                (p, t, c) == (package, table, column)
                    && other.len().abs_diff(values.len()) == 1
                    && (other.is_subset(values) || values.is_subset(other))
            })
            .max_by_key(|(_, sites)| files_of(sites));
        let note = variant.map_or(String::new(), |((_, _, _, other), sites)| {
            let odd = other.symmetric_difference(values).next().map_or("", String::as_str);
            let how = if other.len() > values.len() { format!("with '{odd}' added") } else { format!("without '{odd}'") };
            let n = files_of(sites);
            format!(
                " {n} other file{} test{} it {how} ({}:{}): if that is the same rule, one of the two is behind.",
                if n == 1 { "" } else { "s" },
                if n == 1 { "s" } else { "" },
                sites[0].0,
                sites[0].1
            )
        });
        let list = values.iter().map(String::as_str).collect::<Vec<_>>().join(", ");
        out.push(Finding {
            file: at.0.clone(),
            line: at.1,
            target: format!("states:list:{table}.{column}:{}", values.iter().map(String::as_str).collect::<Vec<_>>().join(",")),
            message: format!(
                "{}:{} {table}.{column} is tested against ({list}) in {files} files ({}): one rule, which values count, written {files} times, and the next value has to be added to each. Name the list once and use that.{note}",
                at.0,
                at.1,
                elsewhere(sites, at)
            ),
        });
    }
}

/// One change of state written in several functions.
fn scattered_steps(request: &Request, shape: &Shape, seen: &[Seen], out: &mut Vec<Finding>) {
    let mut groups: Steps = BTreeMap::new();
    for (file, used) in seen.iter().filter(|s| s.product).flat_map(|s| s.uses.iter().filter(|u| u.how == How::Update).map(move |u| (s, u)))
    {
        let allowed = &shape.sets[&(used.table.clone(), used.column.clone())];
        let Some(value) = allowed.stored_for(used.via, &used.value) else { continue };
        let group = groups.entry((&file.package, &used.table, &used.column, value)).or_default();
        group.0.push((&file.file, used.line));
        group.1.insert((&file.file, file.function_at(used.line)));
    }
    groups.values_mut().for_each(|(sites, _)| sites.sort());
    for ((_, table, column, value), (sites, functions)) in &groups {
        let (files, functions) = (files_of(sites), functions.len());
        if files < STEP_FILES || functions < STEP_FUNCTIONS {
            continue;
        }
        let Some(&at) = sites.iter().find(|(file, line)| request.changed(file, *line)) else { continue };
        out.push(Finding {
            file: at.0.clone(),
            line: at.1,
            target: format!("states:step:{table}.{column}={value}"),
            message: format!(
                "{}:{} {table}.{column} is set to '{value}' in {functions} functions in {files} files ({}): one step of the workflow written {functions} times, each free to forget what the others do with it. Give the step one function and call it.",
                at.0,
                at.1,
                elsewhere(sites, at)
            ),
        });
    }
}

#[derive(serde::Deserialize, Default)]
struct Options {
    /// The files that are product code; absent, every file is.
    #[serde(default)]
    product: Option<HashSet<String>>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let options: Options = request.options()?;
    let shape = shape(&datamodel::schemas(request));
    if shape.sets.is_empty() {
        return Ok(Answer::new(vec![], "no column with a closed set of values".into()));
    }
    let mut seen: Vec<Seen> = request.files.par_iter().filter(|f| is_code(f)).filter_map(|f| read_code(&request.root, f, &shape)).collect();
    let mut packages = HashMap::new();
    for file in &mut seen {
        file.uses.sort_by_key(|u| u.line);
        file.lists.sort_by_key(|l| l.line);
        file.package = crate::graph::package_of(&request.root, &file.file, &mut packages);
        file.product = options.product.as_ref().is_none_or(|product| product.contains(&file.file));
    }
    // A value the column cannot hold is a slip with one fix. A rule written many times is the owner's to gather or
    // to leave: a suggestion.
    let (mut findings, mut suggestions) = (vec![], vec![]);
    unknown(request, &shape, &seen, &mut findings);
    repeated_lists(request, &shape, &seen, &mut suggestions);
    scattered_steps(request, &shape, &seen, &mut suggestions);
    let by_place = |a: &Finding, b: &Finding| (&a.file, a.line, &a.target).cmp(&(&b.file, b.line, &b.target));
    findings.sort_by(by_place);
    suggestions.sort_by(by_place);
    let uses: usize = seen.iter().map(|s| s.uses.len()).sum();
    let summary = format!(
        "{uses} values in code checked against {} closed sets of values, {} not allowed and {} suggestions",
        shape.sets.len(),
        findings.len(),
        suggestions.len()
    );
    Ok(Answer::new(findings, summary).suggesting(suggestions))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What fails, then what is suggested. With `added`, only those (file, lines) are the change's; `product` names
    /// the product code, every file when None.
    fn judged_as(name: &str, files: &[(&str, &str)], added: Option<&[(&str, &[u32])]>, product: Option<&[&str]>) -> [Vec<Finding>; 2] {
        let request = Request {
            command: "states".into(),
            root: text::temp_tree(&format!("states-{name}"), files),
            files: files.iter().map(|(p, _)| p.to_string()).collect(),
            added: added.map(|a| a.iter().map(|(f, l)| (f.to_string(), l.iter().copied().collect())).collect()),
            prefix: String::new(),
            database_url: None,
            options: product.map_or(serde_json::json!({}), |p| serde_json::json!({ "product": p })),
        };
        let answer = run(&request).unwrap();
        let text = |v: &serde_json::Value, key: &str| v[key].as_str().unwrap_or("").to_string();
        let suggested = answer.data.iter().flat_map(|d| d["suggestions"].as_array().cloned().unwrap_or_default());
        let finding = |s: serde_json::Value| Finding {
            file: text(&s, "file"),
            line: s["line"].as_u64().unwrap_or(0) as u32,
            target: text(&s, "target"),
            message: text(&s, "message"),
        };
        [answer.findings, suggested.map(finding).collect()]
    }

    /// Everything found, failing or suggested.
    fn found(name: &str, files: &[(&str, &str)], added: Option<&[(&str, &[u32])]>, product: Option<&[&str]>) -> Vec<Finding> {
        judged_as(name, files, added, product).concat()
    }

    fn targets(name: &str, files: &[(&str, &str)]) -> Vec<String> {
        found(name, files, None, None).into_iter().map(|f| f.target).collect()
    }

    const JOBS: &str = "enum JobHandler {\n  send_email @map(\"send.email\")\n  sync\n\n  @@map(\"job_handler\")\n}\n\nmodel Job {\n  id      String     @id\n  handler JobHandler\n  status  String\n\n  @@map(\"jobs\")\n}\n";
    const JOBS_SQL: &str = "create type job_handler as enum ('send.email', 'sync');\ncreate table jobs (id text primary key, handler job_handler not null, status text not null, constraint jobs_status_check check (status in ('pending', 'done')));\n";

    #[test]
    fn a_value_the_enum_or_check_does_not_allow_is_reported_where_prisma_writes_a_name_and_sql_the_stored_value() {
        let code = "export async function finish(prisma, id) {\n  await prisma.job.update({ where: { id, status: \"pending\" }, data: { status: \"finished\" } });\n  await prisma.job.findMany({ where: { handler: \"send_email\" } });\n  await prisma.$executeRaw`UPDATE jobs SET status = 'done' WHERE handler = 'send_email'::job_handler`;\n  await prisma.$queryRaw`\n    SELECT 1 FROM jobs j\n    WHERE j.id = ${\n      id\n    } AND j.status IN ('pending', 'donee') AND j.handler = 'send.email'`;\n}\n";
        let got = found("unknown", &[("prisma/schema.prisma", JOBS), ("migrations/001.sql", JOBS_SQL), ("src/jobs.ts", code)], None, None);
        assert_eq!(
            got.iter().map(|f| (f.line, f.target.as_str())).collect::<Vec<_>>(),
            vec![
                (2, "states:unknown:jobs.status=finished"),
                (4, "states:unknown:jobs.handler=send_email"),
                (9, "states:unknown:jobs.status=donee")
            ]
        );
        assert_eq!(
            got[0].message,
            "src/jobs.ts:2 writes 'finished' to jobs.status, which the check on jobs.status does not allow (done, pending): the database refuses the write."
        );
        assert!(
            got[1].message.ends_with("the test is never true. 'send_email' is Prisma's name for the value; SQL holds 'send.email'."),
            "{}",
            got[1].message
        );
        assert!(got[2].message.ends_with("Did you mean 'done'?"), "{}", got[2].message);
    }

    #[test]
    fn prisma_filters_are_read_through_and_or_not_in_and_set_and_a_relations_filter_is_another_tables() {
        let code = "export const load = (db) => db.job.findMany({ where: { OR: [{ status: \"pending\" }, { status: { not: \"gone\" } }], NOT: { status: { in: [\"done\", \"lost\"] } }, owner: { status: \"whatever\" } } });\nexport const save = (db, id) => db.job.upsert({ where: { id }, create: { id, status: \"new\" }, update: { status: { set: \"done\" } } });\n";
        assert_eq!(
            targets("filters", &[("prisma/schema.prisma", JOBS), ("migrations/001.sql", JOBS_SQL), ("src/jobs.ts", code)]),
            vec!["states:unknown:jobs.status=gone", "states:unknown:jobs.status=lost", "states:unknown:jobs.status=new"]
        );
    }

    #[test]
    fn a_check_is_read_as_the_migrations_leave_it_and_only_when_it_holds_the_column_to_a_list() {
        let first = "create table orders (id uuid primary key, status text check (status in ('new', 'paid')), kind text, note text, constraint orders_kind_check check ((kind = ANY (ARRAY['a'::text, 'b'::text]))), constraint orders_note_check check (note in ('x', 'y') or id is not null));\n";
        // Dropped and added again inside a guarded block, which no parser opens: the list is the later one.
        let second = "DO $$\nBEGIN\n  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;\n  ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IS NULL OR status IN ('new', 'paid', 'refunded'));\nEND $$;\n";
        let code = "export const refund = (db) => db.query(\"UPDATE orders SET status = 'refunded' WHERE kind = 'c' AND note = 'z'\");\n";
        assert_eq!(
            targets("checks", &[("migrations/001.sql", first), ("migrations/002.sql", second), ("src/orders.ts", code)]),
            vec!["states:unknown:orders.kind=c"]
        );
    }

    #[test]
    fn a_sql_enum_holds_the_values_added_and_renamed_since_it_was_made() {
        let sql = "create type mood as enum ('happy', 'sad');\nalter type mood add value 'calm';\nalter type mood rename value 'sad' to 'low';\ncreate table pets (id uuid primary key, mood mood);\n";
        let code =
            "export const moody = (pool) => pool.query(\"SELECT * FROM pets WHERE mood = 'sad' OR mood = 'calm' OR mood = 'low'\");\n";
        assert_eq!(targets("enums", &[("migrations/001.sql", sql), ("src/pets.ts", code)]), vec!["states:unknown:pets.mood=sad"]);
    }

    #[test]
    fn a_column_is_read_only_where_its_table_is_certain() {
        let sql = "create table jobs (id text primary key, status text check (status in ('pending', 'done')));\ncreate table runs (id text primary key, job_id text, status text check (status in ('ok', 'bad')));\n";
        // A CTE that takes the table's name, two tables and no qualifier, a subquery's alias: none is certainly jobs.
        let unsure = "export const a = (db) => db.query(\"WITH jobs AS (SELECT 'x' AS status) SELECT * FROM jobs WHERE status = 'nope'\");\nexport const b = (db) => db.query(\"SELECT * FROM jobs j JOIN runs r ON r.job_id = j.id WHERE status = 'nope'\");\nexport const c = (db) => db.query(\"SELECT * FROM (SELECT 'x' AS status FROM runs) j WHERE j.status = 'nope'\");\n";
        assert_eq!(targets("unsure", &[("migrations/001.sql", sql), ("src/a.ts", unsure)]), Vec::<String>::new());
        let sure = "export const d = (db) => db.query(\"SELECT * FROM jobs j JOIN runs r ON r.job_id = j.id WHERE j.status = 'nope' AND r.status <> 'ok'\");\nexport const e = (db) => db.query(\"INSERT INTO runs (id, status) VALUES ('1', 'good')\");\nexport const f = (db) => db.query(\"UPDATE runs SET status = CASE WHEN id = '1' THEN 'ok' ELSE 'worse' END\");\n";
        assert_eq!(
            targets("sure", &[("migrations/001.sql", sql), ("src/a.ts", sure)]),
            vec!["states:unknown:jobs.status=nope", "states:unknown:runs.status=good", "states:unknown:runs.status=worse"]
        );
    }

    const TICKETS: &str = "enum Status {\n  open\n  held\n  closed\n  lost\n}\n\nmodel Ticket {\n  id     String @id\n  status Status\n}\n";

    #[test]
    fn one_list_tested_in_three_files_and_one_step_written_in_four_functions_are_reported_once_each() {
        let waiting = |name: &str| {
            format!("export const {name} = (db) => db.ticket.findMany({{ where: {{ status: {{ in: [\"open\", \"held\"] }} }} }});\n")
        };
        let close = |name: &str| {
            format!("export const {name} = (db, id) => db.ticket.update({{ where: {{ id }}, data: {{ status: \"closed\" }} }});\n")
        };
        let a = format!("{}{}{}", waiting("waitingA"), close("closeA"), close("closeAgain"));
        let b = format!("{}{}", waiting("waitingB"), close("closeB"));
        let c = format!("{}{}", waiting("waitingC"), close("closeC"));
        let d = "export const all = (db) => db.ticket.findMany({ where: { status: { in: [\"open\", \"held\", \"lost\"] } } });\n";
        let files = [
            ("prisma/schema.prisma", TICKETS),
            ("src/a.ts", a.as_str()),
            ("src/b.ts", b.as_str()),
            ("scripts/c.ts", c.as_str()),
            ("src/d.ts", d),
        ];
        let [failing, got] = judged_as("copies", &files, None, None);
        assert_eq!(failing.len(), 0, "a rule written many times is suggested, and fails nothing");
        assert_eq!(
            got.iter().map(|f| (f.file.as_str(), f.line, f.target.as_str())).collect::<Vec<_>>(),
            vec![("scripts/c.ts", 1, "states:list:ticket.status:held,open"), ("scripts/c.ts", 2, "states:step:ticket.status=closed")]
        );
        assert_eq!(
            got[0].message,
            "scripts/c.ts:1 ticket.status is tested against (held, open) in 3 files (also src/a.ts:1, src/b.ts:1): one rule, which values count, written 3 times, and the next value has to be added to each. Name the list once and use that. 1 other file tests it with 'lost' added (src/d.ts:1): if that is the same rule, one of the two is behind."
        );
        assert_eq!(
            got[1].message,
            "scripts/c.ts:2 ticket.status is set to 'closed' in 4 functions in 3 files (also src/a.ts:2, src/a.ts:3, src/b.ts:2): one step of the workflow written 4 times, each free to forget what the others do with it. Give the step one function and call it."
        );
        // A change is judged where it adds a copy.
        let change = found("copies-change", &files, Some(&[("src/b.ts", &[1])]), None);
        assert_eq!(change.iter().map(|f| (f.file.as_str(), f.line)).collect::<Vec<_>>(), vec![("src/b.ts", 1)]);
        // A script is not the product's workflow: without it the list is in two files and the step in three functions.
        assert_eq!(found("copies-product", &files, None, Some(&["src/a.ts", "src/b.ts", "src/d.ts"])).len(), 0);
    }
}
