//! The columns check: the database the migrations and schemas declare, against what the code writes and names.
//! A column the change adds that nothing writes stays NULL in every row; a table or column the code names that the
//! schema does not have is invented (string-typed APIs like raw SQL and Supabase are checked by nothing else); a
//! change that removes the last write of a column leaves it NULL from then on. With `--all`, every nullable column
//! nothing writes and every table nothing uses is a cleanup to make.
//!
//! The model comes from SQL migrations (applied in path order), Prisma schemas and Drizzle tables, the latter two
//! winning over the SQL they generate. Writes come from Prisma, Drizzle, Supabase (and knex) calls, SQL in code and
//! in migrations (backfills, trigger functions). A write whose object is not a literal (`insert(row)`, a spread)
//! hides which columns it sets, so its table is never reported as unwritten.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use rayon::prelude::*;
use regex::Regex;
use sqlparser::ast::{
    visit_relations, AlterColumnOperation, AlterTableOperation, AssignmentTarget, ObjectType, RenameTableNameKind, Statement, TableFactor,
};
use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;
use std::sync::LazyLock;

use crate::sql::{bare, statements};
use crate::text::{self, Lines};
use crate::{js, Answer, Finding, Request};

/// Names with the line each is on.
type Named = Vec<(String, u32)>;

#[derive(Clone, Debug)]
struct Column {
    /// The database name (lowercase for SQL, which folds unquoted names).
    name: String,
    /// The name code uses: a Prisma field or Drizzle key (the database name for SQL).
    key: String,
    nullable: bool,
    /// Filled without code: a default, generated, identity, serial or `@updatedAt`.
    filled: bool,
    file: String,
    line: u32,
}

#[derive(Clone, Debug, Default)]
struct Table {
    /// The database name, lowercase.
    name: String,
    /// The Prisma model or Drizzle variable naming it in code; empty for SQL.
    model: String,
    /// 0 SQL, 1 Drizzle, 2 Prisma: a schema the ORM generates SQL from wins over that SQL.
    source: u8,
    columns: Vec<Column>,
    /// Every column is known: no spread in a Drizzle table, no `CREATE TABLE … AS`.
    complete: bool,
    file: String,
    line: u32,
    /// Prisma relation fields: (field, target model, foreign key fields this side holds).
    relations: Vec<(String, String, Vec<String>)>,
    /// Prisma compound unique names usable in `where`: `userId_postId`.
    compound: Vec<String>,
}

impl Table {
    /// The column a name means. SQL folds unquoted names, so for it case does not matter; Prisma and Drizzle code
    /// names fields exactly.
    fn column(&self, key: &str) -> Option<&Column> {
        let lower = key.to_lowercase();
        self.columns
            .iter()
            .find(|c| c.key == key || c.name == key)
            .or_else(|| self.columns.iter().find(|c| self.source == 0 && c.name.to_lowercase() == lower))
    }

    /// The column a key of Prisma or Drizzle code means: its field name exactly.
    fn field(&self, key: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.key == key)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The model: SQL migrations, Prisma, Drizzle.

static CREATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unlogged|foreign|materialized)\s+)?(table|view)\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)"#).unwrap()
});

/// The line of `column` inside the CREATE TABLE starting at `from` (1-based), or `from`.
fn column_line(lines: &[&str], from: u32, column: &str) -> u32 {
    for (i, line) in lines.iter().enumerate().skip(from.saturating_sub(1) as usize).take(400) {
        let t = line.trim_start().trim_start_matches('"').to_lowercase();
        if t.starts_with(column) && t[column.len()..].starts_with(|c: char| c.is_whitespace() || c == '"') {
            return i as u32 + 1;
        }
    }
    from
}

fn sql_column(def: &sqlparser::ast::ColumnDef, file: &str, line: u32) -> Column {
    let opts = def.options.iter().map(|o| o.option.to_string().to_uppercase()).collect::<Vec<_>>().join(" ");
    let ty = def.data_type.to_string().to_lowercase();
    let name = bare(&def.name.to_string());
    Column {
        key: name.clone(),
        name,
        nullable: !opts.contains("NOT NULL") && !opts.contains("PRIMARY KEY"),
        filled: opts.contains("DEFAULT") || opts.contains("GENERATED") || opts.contains("IDENTITY") || ty.contains("serial"),
        file: file.to_string(),
        line,
    }
}

/// The tables the SQL files leave behind, applied in path order, and every name ever created as a table or view
/// (so a statement the parser could not read still names a table that exists).
fn sql_model(files: &[(String, String)]) -> (HashMap<String, Table>, HashSet<String>, HashSet<String>) {
    let mut tables: HashMap<String, Table> = HashMap::new();
    let mut known = HashSet::new();
    let mut views = HashSet::new();
    for (file, src) in files {
        for m in CREATED.captures_iter(src) {
            let name = bare(&m[2]);
            if m[1].eq_ignore_ascii_case("view") {
                views.insert(name.clone());
            }
            known.insert(name);
        }
        let lines: Vec<&str> = src.lines().collect();
        for s in statements(file, 1, src, false) {
            match &s.statement {
                // IF NOT EXISTS on a table that exists does nothing; a schema dump beside the migrations does not
                // override them either.
                Statement::CreateTable(ct)
                    if tables.contains_key(&bare(&ct.name.to_string())) && (ct.if_not_exists || !file.contains("migrations/")) => {}
                Statement::CreateTable(ct) => {
                    let name = bare(&ct.name.to_string());
                    let mut columns: Vec<Column> =
                        ct.columns.iter().map(|c| sql_column(c, file, column_line(&lines, s.line, &bare(&c.name.to_string())))).collect();
                    for c in &ct.constraints {
                        let text = c.to_string().to_uppercase();
                        if text.contains("PRIMARY KEY") {
                            let inner = text.split_once('(').and_then(|(_, r)| r.split_once(')')).map_or("", |(l, _)| l).to_lowercase();
                            for key in inner.split(',').map(|k| bare(k.trim())) {
                                if let Some(col) = columns.iter_mut().find(|c| c.name == key) {
                                    col.nullable = false;
                                }
                            }
                        }
                    }
                    let complete = ct.query.is_none() && ct.like.is_none();
                    tables.insert(name.clone(), Table { name, columns, complete, file: file.clone(), line: s.line, ..Default::default() });
                }
                Statement::AlterTable(at) => {
                    let mut name = bare(&at.name.to_string());
                    for op in &at.operations {
                        if let AlterTableOperation::RenameTable { table_name: RenameTableNameKind::To(to) | RenameTableNameKind::As(to) } =
                            op
                        {
                            let to = bare(&to.to_string());
                            known.insert(to.clone());
                            if let Some(mut t) = tables.remove(&name) {
                                t.name = to.clone();
                                tables.insert(to.clone(), t);
                            }
                            name = to;
                            continue;
                        }
                        let Some(t) = tables.get_mut(&name) else { continue };
                        match op {
                            AlterTableOperation::AddColumn { column_def, .. } => {
                                let col = sql_column(column_def, file, s.line);
                                t.columns.retain(|c| c.name != col.name);
                                t.columns.push(col);
                            }
                            AlterTableOperation::DropColumn { column_names, .. } => {
                                let gone: Vec<String> = column_names.iter().map(|c| bare(&c.to_string())).collect();
                                t.columns.retain(|c| !gone.contains(&c.name));
                            }
                            AlterTableOperation::RenameColumn { old_column_name, new_column_name } => {
                                let (old, new) = (bare(&old_column_name.to_string()), bare(&new_column_name.to_string()));
                                if let Some(c) = t.columns.iter_mut().find(|c| c.name == old) {
                                    c.name = new.clone();
                                    c.key = new;
                                    c.file = file.clone();
                                    c.line = s.line;
                                }
                            }
                            AlterTableOperation::AlterColumn { column_name, op } => {
                                let col = bare(&column_name.to_string());
                                if let Some(c) = t.columns.iter_mut().find(|c| c.name == col) {
                                    match op {
                                        AlterColumnOperation::SetNotNull => c.nullable = false,
                                        AlterColumnOperation::DropNotNull => c.nullable = true,
                                        AlterColumnOperation::SetDefault { .. } => c.filled = true,
                                        AlterColumnOperation::DropDefault => c.filled = false,
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Statement::Drop { object_type: ObjectType::Table, names, .. } => {
                    for n in names {
                        tables.remove(&bare(&n.to_string()));
                    }
                }
                _ => {}
            }
        }
    }
    (tables, known, views)
}

/// The words of a Prisma attribute's bracketed list: `fields: [authorId, orgId]` is authorId, orgId.
fn bracket_list(text: &str, after: &str) -> Vec<String> {
    let Some(at) = text.find(after) else { return vec![] };
    let rest = &text[at + after.len()..];
    let inner = rest.split_once('[').and_then(|(_, r)| r.split_once(']')).map_or("", |(l, _)| l);
    inner.split(',').map(|w| w.trim().split('(').next().unwrap_or("").trim().to_string()).filter(|w| !w.is_empty()).collect()
}

/// The string argument of a Prisma attribute: `@map("user_id")` is user_id.
fn attr_string(text: &str, attr: &str) -> Option<String> {
    let at = text.find(attr)?;
    let rest = &text[at + attr.len()..];
    let open = rest.find('"')?;
    let close = rest[open + 1..].find('"')?;
    Some(rest[open + 1..open + 1 + close].to_string())
}

fn lower_first(name: &str) -> String {
    let mut chars = name.chars();
    chars.next().map(|c| c.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

fn prisma_model(file: &str, src: &str) -> Vec<Table> {
    // `model User {`: a declaration opens a block on its line, so a field named `model` (`model String?`) is not one.
    let block = |line: &str, kind: &str| {
        let line = line.split("//").next().unwrap_or("").trim();
        line.strip_prefix(kind)
            .filter(|_| line.ends_with('{'))
            .map(|r| r.split_whitespace().next().unwrap_or("").trim_end_matches('{').to_string())
    };
    let models: HashSet<String> = src.lines().filter_map(|l| block(l, "model ")).collect();
    let mut out = Vec::new();
    let mut current: Option<Table> = None;
    let mut ignored = false;
    for (i, raw) in src.lines().enumerate() {
        let line = raw.split("//").next().unwrap_or("").trim();
        let n = i as u32 + 1;
        if let Some(name) = block(raw, "model ") {
            current = Some(Table {
                name: name.to_lowercase(),
                model: name,
                source: 2,
                complete: true,
                file: file.to_string(),
                line: n,
                ..Default::default()
            });
            ignored = false;
            continue;
        }
        let Some(t) = current.as_mut() else { continue };
        if line.starts_with('}') {
            let t = current.take().unwrap();
            if !ignored {
                out.push(t);
            }
            continue;
        }
        if line.starts_with("@@map") {
            if let Some(name) = attr_string(line, "@@map") {
                t.name = name.to_lowercase();
            }
            continue;
        }
        if line.starts_with("@@ignore") {
            ignored = true;
            continue;
        }
        if line.starts_with("@@unique") || line.starts_with("@@id") {
            let fields = bracket_list(line, "(");
            t.compound.push(attr_string(line, "name:").unwrap_or_else(|| fields.join("_")));
            continue;
        }
        let mut words = line.split_whitespace();
        let (Some(field), Some(ty)) = (words.next(), words.next()) else { continue };
        if field.starts_with('@') || line.contains("@ignore") {
            continue;
        }
        let base = ty.trim_end_matches('?').trim_end_matches("[]");
        if models.contains(base) {
            let fks = if line.contains("@relation") { bracket_list(line, "fields:") } else { vec![] };
            t.relations.push((field.to_string(), base.to_string(), fks));
            continue;
        }
        let name = attr_string(line, "@map(").unwrap_or_else(|| field.to_string());
        t.columns.push(Column {
            name,
            key: field.to_string(),
            nullable: ty.ends_with('?'),
            filled: line.contains("@default") || line.contains("@updatedAt") || ty.ends_with("[]"),
            file: file.to_string(),
            line: n,
        });
    }
    out
}

/// Drizzle's column modifiers that fill a value without code.
const DRIZZLE_FILLED: [&str; 10] = [
    "default",
    "defaultNow",
    "defaultRandom",
    "$defaultFn",
    "$default",
    "$onUpdate",
    "$onUpdateFn",
    "generatedAlwaysAs",
    "generatedAlwaysAsIdentity",
    "generatedByDefaultAsIdentity",
];

/// Drizzle's column types: any other base call is an enum, a custom type or a helper of the project's.
const DRIZZLE_TYPES: [&str; 30] = [
    "text",
    "varchar",
    "char",
    "integer",
    "int",
    "bigint",
    "smallint",
    "tinyint",
    "mediumint",
    "serial",
    "bigserial",
    "smallserial",
    "boolean",
    "timestamp",
    "date",
    "time",
    "datetime",
    "interval",
    "json",
    "jsonb",
    "uuid",
    "numeric",
    "decimal",
    "real",
    "doublePrecision",
    "double",
    "float",
    "blob",
    "inet",
    "citext",
];

struct DrizzleTables<'s> {
    src: &'s str,
    lines: Lines,
    file: &'s str,
    names: Named,
    out: Vec<Table>,
}

fn string_arg<'b>(args: &'b [Argument<'_>], i: usize) -> Option<&'b str> {
    js::string(args.get(i)?.as_expression()?.get_inner_expression(), false)
}

/// A column builder chain, `text("nick").notNull().default("")`: its base call and the modifier names.
fn builder<'a, 'b>(mut e: &'b Expression<'a>) -> Option<(&'b CallExpression<'a>, Vec<&'a str>)> {
    let mut methods = Vec::new();
    loop {
        let Expression::CallExpression(call) = e.get_inner_expression() else { return None };
        match call.callee.get_inner_expression().as_member_expression() {
            Some(m) if matches!(m.object().get_inner_expression(), Expression::CallExpression(_)) => {
                methods.push(m.static_property_name()?);
                e = m.object();
            }
            _ => return Some((call, methods)),
        }
    }
}

impl<'a> Visit<'a> for DrizzleTables<'_> {
    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let name = it.id.get_binding_identifier().map(|b| b.name.to_string()).unwrap_or_default();
        self.names.push((name, it.init.as_ref().map_or(u32::MAX, |i| i.span().start)));
        walk::walk_variable_declarator(self, it);
        self.names.pop();
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let callee = &self.src[it.callee.span().start as usize..it.callee.span().end as usize];
        let last = callee.rsplit('.').next().unwrap_or(callee);
        let table_call = (last.ends_with("Table") && !last.starts_with("use") && !last.starts_with("create")
            || last == "table"
            || last == "createTable")
            && !callee.contains('(');
        let owner = self.names.last().filter(|(_, at)| *at <= it.span.start).map(|(n, _)| n.clone()).unwrap_or_default();
        if let (true, Some(db_name), false) = (table_call, string_arg(&it.arguments, 0), owner.is_empty()) {
            let fields = it.arguments.get(1).and_then(|a| a.as_expression()).and_then(|e| match e.get_inner_expression() {
                Expression::ObjectExpression(o) => Some(o),
                Expression::ArrowFunctionExpression(a) => match a.get_expression()?.get_inner_expression() {
                    Expression::ObjectExpression(o) => Some(o),
                    _ => None,
                },
                _ => None,
            });
            if let Some(obj) = fields {
                let mut table = Table {
                    name: db_name.to_lowercase(),
                    model: owner,
                    source: 1,
                    complete: true,
                    file: self.file.to_string(),
                    line: self.lines.line(it.span.start as usize),
                    ..Default::default()
                };
                for p in &obj.properties {
                    let ObjectPropertyKind::ObjectProperty(p) = p else {
                        table.complete = false;
                        continue;
                    };
                    let (Some(key), Some((base, methods))) = (p.key.static_name(), builder(&p.value)) else {
                        table.complete = false;
                        continue;
                    };
                    let base_name = self.src[base.callee.span().start as usize..base.callee.span().end as usize]
                        .rsplit('.')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    // A helper of the project's own (`createdAt()`) hides what it builds: count it as filled.
                    let helper = !DRIZZLE_TYPES.contains(&base_name.as_str()) && base.arguments.is_empty();
                    let name = string_arg(&base.arguments, 0).unwrap_or(&key).to_string();
                    table.columns.push(Column {
                        name,
                        key: key.to_string(),
                        nullable: !methods.iter().any(|m| *m == "notNull" || *m == "primaryKey"),
                        filled: helper || methods.iter().any(|m| DRIZZLE_FILLED.contains(m)) || base_name.contains("serial"),
                        file: self.file.to_string(),
                        line: self.lines.line(p.span.start as usize),
                    });
                }
                self.out.push(table);
            }
        }
        walk::walk_call_expression(self, it);
    }
}

fn drizzle_model(file: &str, src: &str) -> Vec<Table> {
    js::parse(file, src, |program| {
        let mut v = DrizzleTables { src, lines: Lines::new(src), file, names: vec![], out: vec![] };
        v.visit_program(program);
        v.out
    })
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------------------------
// Uses in code.

/// Keys of an object literal written to a table, or Opaque when a spread or a non-literal hides them.
#[derive(Debug, Clone)]
enum Obj {
    Opaque,
    Fields(Vec<Field>),
}

#[derive(Debug, Clone)]
struct Field {
    key: String,
    line: u32,
    /// Prisma nested writes on a relation field: (operation, objects it writes to the related model).
    nested: Vec<(String, Vec<Obj>)>,
}

#[derive(Debug)]
struct PrismaCall {
    accessor: String,
    write: bool,
    data: Vec<Obj>,
    wheres: Named,
    /// Every key anywhere in the call's argument: relation names reached through include, select and where.
    keys: Vec<String>,
}

#[derive(Debug)]
struct NamedUse {
    table: String,
    line: u32,
    written: Option<Obj>,
    /// Columns named by select strings, filters and match objects.
    columns: Named,
    /// Tables reached through embedded resources in a select string.
    embedded: Vec<(String, Named)>,
}

#[derive(Default, Debug)]
struct Uses {
    prisma: Vec<PrismaCall>,
    /// Drizzle inserts and updates: (table variable, what they write, line).
    drizzle: Vec<(String, Obj, u32)>,
    named: Vec<NamedUse>,
    idents: HashSet<String>,
    /// Each SQL string's line, text and `${…}` sources (see `js::SqlSite`).
    sql: Vec<(u32, String, Vec<String>)>,
    /// `const keys = attributionVisitorKeys`: a local name for another variable.
    aliases: HashMap<String, String>,
    /// Identifier-like strings held in a variable, property or array (`const TABLE = "orders"`) or a REST path: a
    /// table named that way is used in a way not followed here.
    strings: HashSet<String>,
    /// Identifier-like strings passed to calls, with how many of them are `.from("t")` itself: they name a table
    /// in use only where some `.from(name)` takes a variable (`fetchAll(client, "orders")`).
    call_strings: HashMap<String, usize>,
    from_calls: HashMap<String, usize>,
    /// A `.from(x)` whose table is not a literal.
    dynamic_from: bool,
    /// Tables a generated Supabase types file lists (`orders: { Row: {…} }`): they exist, made outside migrations.
    typed: Vec<String>,
}

const PRISMA_WRITES: [&str; 7] = ["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"];
const PRISMA_READS: [&str; 11] = [
    "findMany",
    "findFirst",
    "findUnique",
    "findFirstOrThrow",
    "findUniqueOrThrow",
    "delete",
    "deleteMany",
    "count",
    "aggregate",
    "groupBy",
    "updateMany",
];
const NESTED: [&str; 11] =
    ["create", "createMany", "connect", "connectOrCreate", "update", "updateMany", "upsert", "set", "disconnect", "delete", "deleteMany"];
const FILTERS: [&str; 6] = ["order", "filter", "not", "textSearch", "likeAllOf", "likeAnyOf"];
const NOT_TABLES: [&str; 14] = [
    "Array",
    "Buffer",
    "Object",
    "Uint8Array",
    "Promise",
    "Set",
    "Map",
    "String",
    "Rx",
    "rxjs",
    "Observable",
    "Iterator",
    "Readable",
    "Stream",
];

struct UseWalker {
    lines: Lines,
    out: Uses,
}

impl UseWalker {
    fn line(&self, offset: u32) -> u32 {
        self.lines.line(offset as usize)
    }

    fn objects(&self, e: &Expression) -> Vec<Obj> {
        match e.get_inner_expression() {
            Expression::ArrayExpression(a) => {
                a.elements.iter().map(|el| el.as_expression().map_or(Obj::Opaque, |e| self.object(e))).collect()
            }
            other => vec![self.object(other)],
        }
    }

    fn object(&self, e: &Expression) -> Obj {
        let Expression::ObjectExpression(o) = e.get_inner_expression() else { return Obj::Opaque };
        let mut fields = Vec::new();
        for p in &o.properties {
            let ObjectPropertyKind::ObjectProperty(p) = p else { return Obj::Opaque };
            let Some(key) = p.key.static_name().filter(|_| !p.computed) else { return Obj::Opaque };
            let mut nested = Vec::new();
            if let Expression::ObjectExpression(inner) = p.value.get_inner_expression() {
                for q in &inner.properties {
                    let ObjectPropertyKind::ObjectProperty(q) = q else { continue };
                    let Some(op) = q.key.static_name().filter(|k| NESTED.contains(&k.as_ref())) else { continue };
                    let objs = match op.as_ref() {
                        "create" => self.objects(&q.value),
                        "createMany" | "updateMany" => prop(&q.value, "data").map(|d| self.objects(d)).unwrap_or_default(),
                        "connectOrCreate" => {
                            self.list(&q.value).iter().filter_map(|x| prop(x, "create")).flat_map(|c| self.objects(c)).collect()
                        }
                        "upsert" => self
                            .list(&q.value)
                            .iter()
                            .flat_map(|x| {
                                ["create", "update"].iter().filter_map(|k| prop(x, k)).flat_map(|c| self.objects(c)).collect::<Vec<_>>()
                            })
                            .collect(),
                        "update" => {
                            self.list(&q.value).iter().map(|x| prop(x, "data").map_or_else(|| self.object(x), |d| self.object(d))).collect()
                        }
                        _ => vec![],
                    };
                    nested.push((op.to_string(), objs));
                }
            }
            fields.push(Field { key: key.to_string(), line: self.line(p.span.start), nested });
        }
        Obj::Fields(fields)
    }

    fn list<'b, 'a>(&self, e: &'b Expression<'a>) -> Vec<&'b Expression<'a>> {
        match e.get_inner_expression() {
            Expression::ArrayExpression(a) => a.elements.iter().filter_map(|el| el.as_expression()).collect(),
            other => vec![other],
        }
    }

    fn keys(e: &Expression, out: &mut Vec<String>) {
        if let Expression::ObjectExpression(o) = e.get_inner_expression() {
            for p in &o.properties {
                if let ObjectPropertyKind::ObjectProperty(p) = p {
                    if let Some(k) = p.key.static_name() {
                        out.push(k.to_string());
                    }
                    Self::keys(&p.value, out);
                }
            }
        }
    }

    fn prisma(&mut self, accessor: &str, op: &str, it: &CallExpression) {
        let write = PRISMA_WRITES.contains(&op);
        let arg = it.arguments.first().and_then(|a| a.as_expression());
        let mut call = PrismaCall { accessor: accessor.to_string(), write, data: vec![], wheres: vec![], keys: vec![] };
        match arg {
            Some(arg) => {
                if write {
                    let picked: Vec<&Expression> = ["data", "create", "update"].iter().filter_map(|k| prop(arg, k)).collect();
                    call.data = if matches!(arg.get_inner_expression(), Expression::ObjectExpression(_)) {
                        picked.iter().flat_map(|d| self.objects(d)).collect()
                    } else {
                        vec![Obj::Opaque]
                    };
                }
                if let Some(Expression::ObjectExpression(w)) = prop(arg, "where").map(|w| w.get_inner_expression()) {
                    for p in &w.properties {
                        if let ObjectPropertyKind::ObjectProperty(p) = p {
                            if let Some(k) = p.key.static_name().filter(|_| !p.computed) {
                                call.wheres.push((k.to_string(), self.line(p.span.start)));
                            }
                        }
                    }
                }
                Self::keys(arg, &mut call.keys);
            }
            None if write => call.data = vec![Obj::Opaque],
            None => {}
        }
        self.out.prisma.push(call);
    }

    /// A Supabase or knex chain on `.from("table")`: what this one call in it writes or names.
    fn named(&mut self, method: &str, it: &CallExpression, table: &str) {
        let line = self.line(it.span.start);
        let mut use_ = NamedUse { table: table.to_string(), line, written: None, columns: vec![], embedded: vec![] };
        let first = it.arguments.first().and_then(|a| a.as_expression());
        match method {
            "insert" | "upsert" | "update" => {
                use_.written = Some(first.map_or(Obj::Opaque, |e| match self.objects(e).as_slice() {
                    [] => Obj::Opaque,
                    [one] => one.clone(),
                    many => merge(many),
                }))
            }
            "select" => {
                if let Some(cols) = string_arg(&it.arguments, 0) {
                    let (columns, embedded) = select_columns(cols, line);
                    use_.columns = columns;
                    use_.embedded = embedded;
                }
            }
            "match" => {
                if let Some(Obj::Fields(f)) = first.map(|e| self.object(e)) {
                    use_.columns = f.into_iter().map(|f| (f.key, f.line)).collect();
                }
            }
            m if js::COMPARISONS.contains(&m) || FILTERS.contains(&m) => {
                if let Some(col) = string_arg(&it.arguments, 0).filter(|c| c.chars().all(|ch| ch.is_alphanumeric() || ch == '_')) {
                    use_.columns.push((col.to_string(), line));
                }
            }
            _ => return,
        }
        self.out.named.push(use_);
    }
}

/// One object holding every key of several: a batch insert's rows. Opaque if any is.
fn merge(objs: &[Obj]) -> Obj {
    let mut all = Vec::new();
    for o in objs {
        match o {
            Obj::Opaque => return Obj::Opaque,
            Obj::Fields(f) => all.extend(f.iter().cloned()),
        }
    }
    Obj::Fields(all)
}

/// A string literal that could be a table's name.
fn name_like(e: &Expression) -> Option<String> {
    match e.get_inner_expression() {
        Expression::StringLiteral(s) if s.value.len() >= 3 && s.value.chars().all(|c| c.is_alphanumeric() || c == '_') => {
            Some(s.value.to_string())
        }
        _ => None,
    }
}

/// The value of property `key` in an object literal.
fn prop<'b, 'a>(e: &'b Expression<'a>, key: &str) -> Option<&'b Expression<'a>> {
    let Expression::ObjectExpression(o) = e.get_inner_expression() else { return None };
    o.properties.iter().find_map(|p| match p {
        ObjectPropertyKind::ObjectProperty(p) if p.key.static_name().is_some_and(|k| k == key) => Some(&p.value),
        _ => None,
    })
}

/// The columns a PostgREST select string names, and the tables it embeds with theirs:
/// `id, name, author:profiles(name), posts!inner(id)`.
fn select_columns(text: &str, line: u32) -> (Named, Vec<(String, Named)>) {
    let mut columns = Vec::new();
    let mut embedded = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    let bytes: Vec<char> = text.chars().collect();
    let mut items = Vec::new();
    for (i, c) in bytes.iter().enumerate() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                items.push(bytes[start..i].iter().collect::<String>());
                start = i + 1;
            }
            _ => {}
        }
    }
    items.push(bytes[start..].iter().collect::<String>());
    for item in items {
        let item = item.trim().trim_start_matches("...");
        if item.is_empty() || item == "*" || item.starts_with("count") {
            continue;
        }
        let after_alias = item.split_once(':').filter(|(_, r)| !r.starts_with(':')).map_or(item, |(_, r)| r).trim();
        if let Some((head, inner)) = after_alias.split_once('(') {
            let name = head.split('!').next().unwrap_or("").trim().to_string();
            let inner = inner.rsplit_once(')').map_or(inner, |(l, _)| l);
            embedded.push((name, select_columns(inner, line).0));
            continue;
        }
        let name = after_alias.split("::").next().unwrap_or("").split("->").next().unwrap_or("").trim();
        if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            columns.push((name.to_string(), line));
        }
    }
    (columns, embedded)
}

/// The table a `.from("t")` call names: Some(Some(t)) for one, Some(None) for another schema's or not a table,
/// None when the call is not `.from(...)`.
fn from_call<'b>(call: &'b CallExpression<'_>) -> Option<Option<&'b str>> {
    let m = call.callee.get_inner_expression().as_member_expression()?;
    match m.static_property_name()? {
        "schema" => Some(None),
        "from" => {
            let object = m.object().get_inner_expression();
            // `supabase.storage.from("avatars")` is a storage bucket, not a table.
            let other = object.as_member_expression().and_then(|o| o.static_property_name()) == Some("storage")
                || match object {
                    Expression::Identifier(id) => NOT_TABLES.contains(&id.name.as_str()),
                    Expression::CallExpression(inner) => {
                        inner.callee.get_inner_expression().as_member_expression().and_then(|m| m.static_property_name()) == Some("schema")
                    }
                    _ => false,
                };
            Some(if other {
                None
            } else {
                string_arg(&call.arguments, 0).filter(|t| {
                    t.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && t.chars().all(|c| c.is_alphanumeric() || c == '_')
                })
            })
        }
        _ => None,
    }
}

/// The string table of the `.from("t")` a call chain starts from, unless it is another schema's or not a table.
fn from_table<'b>(mut e: &'b Expression<'_>) -> Option<&'b str> {
    loop {
        let Expression::CallExpression(call) = e.get_inner_expression() else { return None };
        if let Some(found) = from_call(call) {
            return found;
        }
        e = call.callee.get_inner_expression().as_member_expression()?.object();
    }
}

/// The identifier given to `.insert(t)` / `.update(t)` somewhere down a Drizzle chain.
fn drizzle_table<'b>(mut e: &'b Expression<'_>, method: &str) -> Option<&'b str> {
    loop {
        let Expression::CallExpression(call) = e.get_inner_expression() else { return None };
        let m = call.callee.get_inner_expression().as_member_expression()?;
        if m.static_property_name() == Some(method) {
            return match call.arguments.first()?.as_expression()?.get_inner_expression() {
                Expression::Identifier(id) => Some(id.name.as_str()),
                _ => None,
            };
        }
        e = m.object();
    }
}

impl<'a> Visit<'a> for UseWalker {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        self.out.idents.insert(it.name.to_string());
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let Some(v) = it.init.as_ref().and_then(name_like) {
            self.out.strings.insert(v);
        }
        if let (Some(name), Some(Expression::Identifier(target))) = (it.id.get_binding_identifier(), it.init.as_ref()) {
            self.out.aliases.insert(name.name.to_string(), target.name.to_string());
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        if let Some(v) = name_like(&it.value) {
            self.out.strings.insert(v);
        }
        walk::walk_object_property(self, it);
    }

    fn visit_array_expression(&mut self, it: &ArrayExpression<'a>) {
        self.out.strings.extend(it.elements.iter().filter_map(|e| e.as_expression()).filter_map(name_like));
        walk::walk_array_expression(self, it);
    }

    fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
        // A PostgREST path, `${url}/rest/v1/orders?id=eq.1`, names the table it reads or writes.
        for q in &it.quasis {
            for m in REST.captures_iter(q.value.raw.as_str()) {
                self.out.strings.insert(m[1].to_string());
            }
        }
        walk::walk_template_literal(self, it);
    }

    // Object keys and types name tables without using them (generated row types, `Tables<"orders">`).
    fn visit_property_key(&mut self, _: &PropertyKey<'a>) {}
    fn visit_ts_literal_type(&mut self, _: &TSLiteralType<'a>) {}

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        for v in it.arguments.iter().filter_map(|a| a.as_expression()).filter_map(name_like) {
            *self.out.call_strings.entry(v).or_default() += 1;
        }
        if let Some(m) = it.callee.get_inner_expression().as_member_expression() {
            if let Some(method) = m.static_property_name() {
                let object = m.object().get_inner_expression();
                // prisma.user.create({ data }), tx.orderItem.findMany(...)
                if PRISMA_WRITES.contains(&method) || PRISMA_READS.contains(&method) {
                    if let Some(inner) = object.as_member_expression() {
                        if let (Some(accessor), false) =
                            (inner.static_property_name(), matches!(inner.object().get_inner_expression(), Expression::CallExpression(_)))
                        {
                            if accessor.starts_with(|c: char| c.is_ascii_lowercase()) {
                                self.prisma(accessor, method, it);
                            }
                        }
                    }
                }
                // db.insert(users).values({...}), db.update(users).set({...}), .onConflictDoUpdate({ set })
                let drizzle = match method {
                    "values" => drizzle_table(object, "insert")
                        .map(|t| (t, it.arguments.first().and_then(|a| a.as_expression()).map(|e| merge(&self.objects(e))))),
                    "set" => drizzle_table(object, "update")
                        .map(|t| (t, it.arguments.first().and_then(|a| a.as_expression()).map(|e| self.object(e)))),
                    "onConflictDoUpdate" | "onDuplicateKeyUpdate" => drizzle_table(object, "insert").map(|t| {
                        (t, it.arguments.first().and_then(|a| a.as_expression()).and_then(|e| prop(e, "set")).map(|s| self.object(s)))
                    }),
                    _ => None,
                };
                if let Some((table, written)) = drizzle {
                    let line = self.line(it.span.start);
                    self.out.drizzle.push((table.to_string(), written.unwrap_or(Obj::Opaque), line));
                }
                if method == "from"
                    && from_call(it) == Some(None)
                    && string_arg(&it.arguments, 0).is_none()
                    && it.arguments.len() == 1
                    && !matches!(m.object().get_inner_expression(), Expression::Identifier(id) if NOT_TABLES.contains(&id.name.as_str()))
                {
                    self.out.dynamic_from = true;
                }
                if method == "from" {
                    if let Some(Some(table)) = from_call(it) {
                        *self.out.from_calls.entry(table.to_string()).or_default() += 1;
                        let line = self.line(it.span.start);
                        self.out.named.push(NamedUse { table: table.to_string(), line, written: None, columns: vec![], embedded: vec![] });
                    }
                } else if let Some(table) = from_table(object) {
                    self.named(method, it, table);
                }
            }
        }
        walk::walk_call_expression(self, it);
    }
}

fn uses(file: &str, src: &str) -> Uses {
    let mut out = js::parse(file, src, |program| {
        let mut w = UseWalker { lines: Lines::new(src), out: Uses::default() };
        w.visit_program(program);
        w.out
    })
    .unwrap_or_default();
    if let Some(facts) = js::facts(file, src) {
        out.sql = facts.sql.into_iter().map(|s| (s.line, s.text, s.params)).collect();
    }
    if src.contains("Row:") {
        out.typed = TYPED.captures_iter(src).map(|m| m[1].to_lowercase()).collect();
    }
    out
}

static TYPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\w+):\s*\{\s*Row:\s*\{").unwrap());
static REST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/rest/v1/(\w+)").unwrap());

/// A column as Postgres reads it: a quoted name keeps its case (`"Status"`), an unquoted one folds to lowercase.
fn ident(name: &str) -> String {
    let last = name.rsplit('.').next().unwrap_or(name);
    match last.strip_prefix('"').and_then(|l| l.strip_suffix('"')) {
        Some(quoted) => quoted.to_string(),
        None => last.to_lowercase(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// SQL text: writes, references and trigger-set columns, by pattern (statements inside function bodies included).

const NAME: &str = r#"((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)"#;
static PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$(\d+)\b").unwrap());
static INSERT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)\binsert\s+into\s+{NAME}\s*(?:as\s+\w+\s*)?(\(([^()]*)\))?")).unwrap());
static UPDATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\bupdate\s+(?:only\s+)?{NAME}(?:\s+(?:as\s+)?(\w+))?\s+set\s+(.*?)(?:\bwhere\b|\breturning\b|\bfrom\b|;|$)"))
        .unwrap()
});
static COPY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(?i)\bcopy\s+{NAME}\s*\(([^()]*)\)\s*from")).unwrap());
static REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)\b(?:from|join|into|update)\s+(?:only\s+)?{NAME}")).unwrap());
static NEW_SET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?im)(?:^|;|\bthen\b|\bbegin\b|\belse\b|\bloop\b)\s*new\.("?\w+"?)\s*:?="#).unwrap());
static CTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(\w+)\s+as\s*(?:materialized\s*)?\(").unwrap());

/// What some SQL writes and names, with the place of each write.
fn sql_writes(text: &str, out: &mut Written, file: &str, first_line: u32) {
    let lines = Lines::new(text);
    let at = |offset: usize| first_line + lines.line(offset) - 1;
    for m in INSERT.captures_iter(text) {
        let table = bare(&m[1]);
        out.refs.insert(table.clone());
        match m.get(3) {
            Some(cols) => {
                out.literal.insert(table.clone());
                for c in cols.as_str().split(',').map(|c| bare(c.trim())).filter(|c| !c.is_empty()) {
                    out.write(&table, &c, file, at(m.get(0).unwrap().start()));
                }
            }
            None => {
                out.opaque.insert(table);
            }
        }
    }
    for m in UPDATE.captures_iter(text) {
        let table = bare(&m[1]);
        if ["set", "of", "on"].contains(&table.as_str()) {
            continue;
        }
        out.literal.insert(table.clone());
        let set = &m[3];
        let mut depth = 0;
        let mut start = 0;
        let mut parts = Vec::new();
        for (i, c) in set.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                ',' if depth == 0 => {
                    parts.push(&set[start..i]);
                    start = i + 1;
                }
                _ => {}
            }
        }
        parts.push(&set[start..]);
        for part in parts {
            let Some((left, _)) = part.split_once('=') else { continue };
            let left = left.trim().trim_start_matches('(').trim_end_matches(')');
            for c in
                left.split(',').map(|c| bare(c.trim())).filter(|c| !c.is_empty() && c.chars().all(|ch| ch.is_alphanumeric() || ch == '_'))
            {
                out.write(&table, &c, file, at(m.get(0).unwrap().start()));
            }
        }
    }
    for m in COPY.captures_iter(text) {
        let table = bare(&m[1]);
        out.literal.insert(table.clone());
        for c in m[2].split(',').map(|c| bare(c.trim())) {
            out.write(&table, &c, file, at(m.get(0).unwrap().start()));
        }
    }
    for m in REFERENCE.captures_iter(text) {
        out.refs.insert(bare(&m[1]));
    }
    for m in NEW_SET.captures_iter(text) {
        out.trigger.insert(bare(&m[1]));
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolving uses against the model.

#[derive(Default)]
struct Written {
    /// (table, column) written, with the first place that writes it.
    cols: HashMap<(String, String), (String, u32)>,
    /// Tables written by an object whose keys are unknown.
    opaque: HashSet<String>,
    /// Tables written with literal keys at least once.
    literal: HashSet<String>,
    /// Tables code reads or writes.
    refs: HashSet<String>,
    /// Column names a trigger function sets (`NEW.col := …`).
    trigger: HashSet<String>,
}

impl Written {
    fn write(&mut self, table: &str, column: &str, file: &str, line: u32) {
        self.cols.entry((table.to_lowercase(), column.to_lowercase())).or_insert_with(|| (file.to_string(), line));
    }
}

struct Model {
    tables: HashMap<String, Table>,
    /// Prisma accessor (`orderItem`) or Drizzle variable → table name.
    by_code: HashMap<String, String>,
    /// Prisma model name → table name.
    by_model: HashMap<String, String>,
    /// Prisma relation field name → the tables it reaches.
    relation_targets: HashMap<String, Vec<String>>,
}

impl Model {
    /// Prisma writes, following nested writes into related models and the foreign keys they set.
    fn prisma_write(&self, table: &str, objs: &[Obj], file: &str, out: &mut Written, depth: u8) {
        let Some(t) = self.tables.get(table) else { return };
        if depth > 6 {
            return;
        }
        for obj in objs {
            let Obj::Fields(fields) = obj else {
                out.opaque.insert(table.to_string());
                continue;
            };
            out.literal.insert(table.to_string());
            for f in fields {
                let Some((_, target, fks)) = t.relations.iter().find(|r| r.0 == f.key) else {
                    if let Some(c) = t.field(&f.key) {
                        out.write(table, &c.name, file, f.line);
                    }
                    continue;
                };
                for fk in fks {
                    if let Some(c) = t.field(fk) {
                        out.write(table, &c.name, file, f.line);
                    }
                }
                let Some(target_table) = self.by_model.get(target).and_then(|n| self.tables.get(n)) else { continue };
                out.refs.insert(target_table.name.clone());
                for (op, nested) in &f.nested {
                    if ["create", "createMany", "connectOrCreate", "upsert", "connect", "set"].contains(&op.as_str()) {
                        // The related rows point back here: their foreign key to this model is set.
                        for (_, _, fks) in target_table.relations.iter().filter(|r| r.1 == t.model) {
                            for fk in fks {
                                if let Some(c) = target_table.field(fk) {
                                    out.write(&target_table.name, &c.name, file, f.line);
                                }
                            }
                        }
                    }
                    self.prisma_write(&target_table.name, nested, file, out, depth + 1);
                }
            }
        }
    }

    fn keyed_write(&self, table: &str, obj: &Obj, file: &str, out: &mut Written) {
        out.refs.insert(table.to_string());
        match obj {
            Obj::Opaque => {
                out.opaque.insert(table.to_string());
            }
            Obj::Fields(fields) => {
                out.literal.insert(table.to_string());
                let t = self.tables.get(table);
                for f in fields {
                    let found = t.and_then(|t| if t.source == 0 { t.column(&f.key) } else { t.field(&f.key) });
                    let name = found.map_or_else(|| f.key.to_lowercase(), |c| c.name.clone());
                    out.write(table, &name, file, f.line);
                }
            }
        }
    }

    fn prisma_table(&self, accessor: &str) -> Option<&Table> {
        self.by_code.get(accessor).and_then(|n| self.tables.get(n)).filter(|t| t.source == 2)
    }

    fn drizzle_table(&self, var: &str) -> Option<&Table> {
        self.by_code.get(var).and_then(|n| self.tables.get(n)).filter(|t| t.source == 1)
    }

    /// SQL with each `$n` that stands for a Drizzle table (`sql\`insert into ${keys} …\``, `keys` the table or a
    /// local name for it) written as that table's name, as Drizzle renders it.
    fn with_tables(&self, text: &str, params: &[String], aliases: &HashMap<String, String>) -> String {
        let table = |p: &String| self.drizzle_table(aliases.get(p).unwrap_or(p));
        if !params.iter().any(|p| table(p).is_some()) {
            return text.to_string();
        }
        PARAM
            .replace_all(text, |m: &regex::Captures| {
                let table = m[1].parse::<usize>().ok().and_then(|n| params.get(n.wrapping_sub(1))).and_then(table);
                table.map_or_else(|| m[0].to_string(), |t| t.name.clone())
            })
            .into_owned()
    }

    /// Everything a set of files writes and references.
    fn written(&self, files: &[(&str, &Uses)]) -> Written {
        let mut out = Written::default();
        let dynamic = files.iter().any(|(_, u)| u.dynamic_from);
        let drizzle_files: HashSet<&str> = self.tables.values().filter(|t| t.source == 1).map(|t| t.file.as_str()).collect();
        for (file, u) in files {
            for call in &u.prisma {
                let Some(t) = self.prisma_table(&call.accessor) else { continue };
                out.refs.insert(t.name.clone());
                for key in &call.keys {
                    for target in self.relation_targets.get(key).into_iter().flatten() {
                        out.refs.insert(target.clone());
                    }
                }
                if call.write {
                    self.prisma_write(&t.name, &call.data, file, &mut out, 0);
                }
            }
            for (var, obj, _) in &u.drizzle {
                if let Some(t) = self.drizzle_table(var) {
                    self.keyed_write(&t.name, obj, file, &mut out);
                }
            }
            for n in &u.named {
                let table = n.table.to_lowercase();
                out.refs.insert(table.clone());
                for (e, _) in &n.embedded {
                    out.refs.insert(e.to_lowercase());
                }
                if let Some(obj) = &n.written {
                    self.keyed_write(&table, obj, file, &mut out);
                }
            }
            if !drizzle_files.contains(file) {
                for (var, table) in &self.by_code {
                    if u.idents.contains(var) && self.tables.get(table).is_some_and(|t| t.source == 1) {
                        out.refs.insert(table.clone());
                    }
                }
            }
            for (line, text, params) in &u.sql {
                sql_writes(&self.with_tables(text, params, &u.aliases), &mut out, file, *line);
            }
            let passed = u.call_strings.iter().filter(|(s, n)| dynamic && **n > u.from_calls.get(*s).copied().unwrap_or(0)).map(|(s, _)| s);
            for string in u.strings.iter().chain(passed) {
                let lower = string.to_lowercase();
                // Only for tables reached by name (SQL, Supabase): Prisma and Drizzle code reaches its tables by object.
                if self.tables.get(&lower).is_some_and(|t| t.source == 0) {
                    out.opaque.insert(lower.clone());
                    out.refs.insert(lower);
                }
            }
        }
        out
    }
}

/// The known name closest to `name`, when it is close enough to be a typo of it (or its plural).
fn near<'n>(name: &str, known: impl Iterator<Item = &'n str>) -> Option<&'n str> {
    let lower = name.to_lowercase();
    known
        .filter(|k| *k != name && k.len() >= 3)
        .map(|k| {
            let kl = k.to_lowercase();
            let alike =
                kl == lower || format!("{kl}s") == lower || format!("{lower}s") == kl || kl.replace('_', "") == lower.replace('_', "");
            (if alike { 0 } else { crate::text::distance(&lower, &kl) }, k)
        })
        .filter(|(d, k)| *d == 0 || (*d <= 2 && k.len() >= 6 && lower.len() >= 6) || (*d == 1 && k.len() >= 4))
        .min_by_key(|(d, _)| *d)
        .map(|(_, k)| k)
}

// ---------------------------------------------------------------------------------------------------------------
// The gate.

/// Sample code, not the product: its names are made up on purpose.
static SAMPLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|/)(?:fixtures?|__fixtures__|mocks?|__mocks__|stories|storybook|examples?)/|\.(?:stories|story|fixture|mock)\.[cm]?[jt]sx?$",
    )
    .unwrap()
});
static TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|/)(?:tests?|__tests__|e2e|spec)/|\.(?:test|spec)\.[cm]?[jt]sx?$").unwrap());
static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:[cm]?[jt]sx?|vue|svelte|astro)$").unwrap());
static OTHER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.(?:py|go|rb|swift|kt|kts|java|php|cs|ex|exs|dart|rs|scala|xs|lua)$").unwrap());
/// Schemas a project does not own: Supabase's auth and storage, Postgres' catalogs.
const FOREIGN_SCHEMAS: [&str; 12] = [
    "auth",
    "storage",
    "pg_catalog",
    "information_schema",
    "extensions",
    "cron",
    "net",
    "vault",
    "realtime",
    "supabase_functions",
    "graphql",
    "pgsodium",
];

const AUTH_LIBRARIES: [&str; 6] = ["better-auth", "next-auth", "@auth/", "lucia", "@lucia-auth", "auth-astro"];
const AUTH_TABLES: [&str; 12] = [
    "user",
    "account",
    "session",
    "verification",
    "verification_token",
    "verificationtoken",
    "jwk",
    "passkey",
    "two_factor",
    "twofactor",
    "authenticator",
    "apikey",
];

enum Read {
    Sql(String, String),
    Prisma(String, String),
    /// A code file: its uses, its Drizzle tables, and whether it uses an auth library that writes its own tables.
    Code(String, Box<Uses>, Vec<Table>, bool),
    Other(HashSet<String>),
}

/// Whether a file may define Drizzle tables: `pgTable(`, `createTable(`, or a named schema's `appSchema.table(`.
fn defines_tables(src: &str) -> bool {
    src.contains("Table(") || src.contains(".table(")
}

/// Whether a code file may define or use tables, so it is worth parsing. Any case: SQL is written both ways.
fn hint(src: &str) -> bool {
    let lower = src.to_lowercase();
    ["from(", "insert", "update", "upsert(", "values", ".set(", ".create", "query.", "select", "table(", "row:", "/rest/v1/"]
        .iter()
        .any(|h| lower.contains(h))
}

/// Reports a table or column the code names that the model does not have.
struct Unknowns<'m> {
    model: &'m Model,
    known: &'m HashSet<String>,
    table_coverage: f64,
    referenced_columns: HashMap<String, HashSet<String>>,
    findings: Vec<Finding>,
}

impl Unknowns<'_> {
    fn table(&mut self, file: &str, line: u32, table: &str) {
        let lower = table.to_lowercase();
        // pg_tables, pg_policies: the catalogs every Postgres has.
        if self.known.contains(&lower) || lower.starts_with("pg_") {
            return;
        }
        let guess = near(&lower, self.known.iter().map(String::as_str));
        if guess.is_none() && self.table_coverage < 0.9 {
            return;
        }
        let hint = guess.map_or(String::new(), |g| format!(" (did you mean {g}?)"));
        self.findings.push(Finding { file: file.into(), line, target: format!("{file}:unknown:{lower}"), message: format!("{file}:{line} there is no table {table} in the migrations or schema{hint}: name a table that exists, or create it in a migration") });
    }

    fn column(&mut self, file: &str, line: u32, table: &str, column: &str) {
        let lower = table.to_lowercase();
        let Some(t) = self.model.tables.get(&lower).filter(|t| t.complete) else { return };
        if t.column(column).is_some() || t.relations.iter().any(|r| r.0 == column) {
            return;
        }
        let guess =
            near(column, t.columns.iter().map(|c| c.name.as_str())).or_else(|| near(column, t.columns.iter().map(|c| c.key.as_str())));
        let coverage = self
            .referenced_columns
            .get(&lower)
            .filter(|r| r.len() >= 3)
            .map_or(0.0, |r| r.iter().filter(|c| t.column(c).is_some()).count() as f64 / r.len() as f64);
        if guess.is_none() && coverage < 0.8 {
            return;
        }
        let hint = guess.map_or(String::new(), |g| format!(" (did you mean {g}?)"));
        self.findings.push(Finding {
            file: file.into(),
            line,
            target: format!("{file}:unknown:{lower}.{column}"),
            message: format!(
                "{file}:{line} {} has no column {column}{hint}: use a column the schema has, or add it in a migration",
                t.name
            ),
        });
    }

    /// Prisma `data` and `where` keys and Drizzle insert keys, which must be fields of the model.
    fn key(&mut self, file: &str, line: u32, t: &Table, key: &str) {
        if t.field(key).is_some()
            || t.relations.iter().any(|r| r.0 == key)
            || t.compound.iter().any(|c| c == key)
            || ["AND", "OR", "NOT"].contains(&key)
        {
            return;
        }
        let guess = near(key, t.columns.iter().map(|c| c.key.as_str()).chain(t.relations.iter().map(|r| r.0.as_str())));
        let hint = guess.map_or(String::new(), |g| format!(" (did you mean {g}?)"));
        let (kind, fix) = if t.source == 2 {
            ("Prisma model", "add it to schema.prisma and migrate")
        } else {
            ("Drizzle table", "add it to the table and generate the migration")
        };
        self.findings.push(Finding {
            file: file.into(),
            line,
            target: format!("{file}:unknown:{}.{key}", t.name),
            message: format!("{file}:{line} the {kind} {} has no field {key}{hint}: use one the schema has, or {fix}", t.model),
        });
    }

    fn sql(&mut self, file: &str, s: &crate::sql::Stmt) {
        let text = s.statement.to_string();
        let lower = text.to_lowercase();
        let ctes: HashSet<String> = CTE.captures_iter(&text).map(|m| m[1].to_lowercase()).collect();
        let mut relations = Vec::new();
        let _ = visit_relations(&s.statement, |name| {
            relations.push(name.to_string());
            ControlFlow::<()>::Continue(())
        });
        for r in &relations {
            let parts: Vec<&str> = r.split('.').map(|p| p.trim_matches('"')).collect();
            if parts.len() > 1 && (parts[0] != "public" || FOREIGN_SCHEMAS.contains(&parts[0])) {
                continue;
            }
            let name = bare(r);
            if ctes.contains(&name) || lower.contains(&format!("{name}(")) {
                continue;
            }
            self.table(file, s.line, &name);
        }
        let targets: Vec<(String, Vec<String>)> = match &s.statement {
            Statement::Insert(ins) => vec![(bare(&ins.table.to_string()), ins.columns.iter().map(|c| ident(&c.to_string())).collect())],
            Statement::Update(u) if u.table.joins.is_empty() && u.from.is_none() => match &u.table.relation {
                TableFactor::Table { name, .. } => {
                    let cols = u.assignments.iter().flat_map(|a| match &a.target {
                        AssignmentTarget::ColumnName(n) => vec![ident(&n.to_string())],
                        AssignmentTarget::Tuple(ns) => ns.iter().map(|n| ident(&n.to_string())).collect(),
                    });
                    vec![(bare(&name.to_string()), cols.collect())]
                }
                _ => vec![],
            },
            _ => vec![],
        };
        for (table, cols) in targets {
            for c in cols {
                self.column(file, s.line, &table, &c);
            }
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// The edited code files as they were on the base, by path.
    before: std::collections::BTreeMap<String, String>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { before } = request.options()?;
    let reads: Vec<Read> = request
        .files
        .par_iter()
        .filter_map(|file| {
            let src = text::read(&request.root, file)?;
            if file.ends_with(".sql") {
                return Some(Read::Sql(file.clone(), src));
            }
            if file.ends_with(".prisma") {
                return Some(Read::Prisma(file.clone(), src));
            }
            if OTHER.is_match(file) {
                return Some(Read::Other(
                    src.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| w.len() > 2).map(str::to_lowercase).collect(),
                ));
            }
            if !CODE.is_match(file) || TEST.is_match(file) {
                return None;
            }
            let auth = AUTH_LIBRARIES.iter().any(|l| src.contains(l));
            if !hint(&src) {
                return auth.then(|| Read::Code(file.clone(), Box::default(), vec![], true));
            }
            let tables = if defines_tables(&src) { drizzle_model(file, &src) } else { vec![] };
            Some(Read::Code(file.clone(), Box::new(uses(file, &src)), tables, auth))
        })
        .collect();
    let mut sql_files: Vec<(String, String)> = Vec::new();
    let mut code: Vec<(&str, &Uses)> = Vec::new();
    let mut words: HashSet<&str> = HashSet::new();
    let mut ormed = Vec::new();
    let mut auth_library = false;
    for r in &reads {
        match r {
            Read::Sql(f, s) => sql_files.push((f.clone(), s.clone())),
            Read::Prisma(f, s) => ormed.extend(prisma_model(f, s)),
            Read::Code(f, u, t, auth) => {
                code.push((f.as_str(), u));
                ormed.extend(t.iter().cloned());
                auth_library |= auth;
            }
            Read::Other(w) => words.extend(w.iter().map(String::as_str)),
        }
    }
    // Migrations first, in order; other SQL (schema dumps, seeds) after, so a stale dump does not undo them.
    sql_files.sort_by(|a, b| (!a.0.contains("migrations/"), &a.0).cmp(&(!b.0.contains("migrations/"), &b.0)));
    let (mut tables, mut known, _views) = sql_model(&sql_files);
    // Prisma's implicit many-to-many tables (`_PostToTag`) are its own to write.
    if ormed.iter().any(|t| t.source == 2) {
        tables.retain(|name, _| !name.starts_with('_'));
    }
    ormed.sort_by_key(|t| t.source);
    for t in ormed {
        known.insert(t.name.clone());
        tables.insert(t.name.clone(), t);
    }
    if tables.is_empty() {
        return Ok(Answer::new(vec![], "no database schema found".into()));
    }
    let by_code: HashMap<String, String> = tables
        .values()
        .filter(|t| !t.model.is_empty())
        .map(|t| (if t.source == 2 { lower_first(&t.model) } else { t.model.clone() }, t.name.clone()))
        .collect();
    let by_model: HashMap<String, String> = tables.values().filter(|t| t.source == 2).map(|t| (t.model.clone(), t.name.clone())).collect();
    let mut relation_targets: HashMap<String, Vec<String>> = HashMap::new();
    for t in tables.values() {
        for (field, target, _) in &t.relations {
            if let Some(n) = by_model.get(target) {
                relation_targets.entry(field.clone()).or_default().push(n.clone());
            }
        }
    }
    for (_, u) in &code {
        known.extend(u.typed.iter().cloned());
    }
    let model = Model { tables, by_code, by_model, relation_targets };
    let mut written = model.written(&code);
    for (file, src) in &sql_files {
        sql_writes(src, &mut written, file, 1);
    }
    // A table another language names may be written there, where this reading cannot see; an auth library writes
    // its users, accounts and sessions through its own adapter.
    for t in model.tables.values() {
        let bare_name = t.name.trim_start_matches("auth_").trim_end_matches('s');
        if words.contains(t.name.as_str()) || auth_library && AUTH_TABLES.contains(&bare_name) {
            written.opaque.insert(t.name.clone());
            written.refs.insert(t.name.clone());
        }
    }
    let whole = request.added.is_none();
    let mut findings = Vec::new();
    let writes_anything = !written.literal.is_empty();

    // (a), (d): columns nothing writes, tables nothing uses.
    let mut sorted: Vec<&Table> = model.tables.values().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    for t in &sorted {
        let open = !written.opaque.contains(&t.name) && written.literal.contains(&t.name);
        for c in t.columns.iter().filter(|c| open && c.nullable && !c.filled && request.changed(&c.file, c.line)) {
            if written.cols.contains_key(&(t.name.clone(), c.name.to_lowercase())) || written.trigger.contains(&c.name.to_lowercase()) {
                continue;
            }
            let drop = match t.source {
                2 => format!("remove {}.{} from the schema and migrate", t.model, c.key),
                1 => format!("remove `{}` from the table and generate the migration", c.key),
                _ => format!("ALTER TABLE {} DROP COLUMN {} in a new migration", t.name, c.name),
            };
            let message = if whole {
                format!(
                    "{}:{} nothing writes {}.{}, so it is NULL in every row: set it where {} rows are created or updated, or {drop}",
                    c.file, c.line, t.name, c.name, t.name
                )
            } else {
                format!("{}:{} adds {}.{}, but no code writes it, so it stays NULL in every row: set it where {} rows are created or updated, or leave it out. Do not give it a placeholder default to quiet this", c.file, c.line, t.name, c.name, t.name)
            };
            findings.push(Finding { file: c.file.clone(), line: c.line, target: format!("columns:{}.{}", t.name, c.name), message });
        }
        if writes_anything
            && !written.refs.contains(&t.name)
            && !written.literal.contains(&t.name)
            && !written.opaque.contains(&t.name)
            && request.changed(&t.file, t.line)
        {
            let message = if whole {
                format!("{}:{} nothing in the code reads or writes table {}: use it, or drop it in a new migration", t.file, t.line, t.name)
            } else {
                format!(
                    "{}:{} adds table {}, but no code reads or writes it: use it in this change, or leave it out",
                    t.file, t.line, t.name
                )
            };
            findings.push(Finding { file: t.file.clone(), line: t.line, target: format!("columns:{}", t.name), message });
        }
    }

    // (b): tables and columns the code names that the schema does not have.
    let mut referenced_tables: HashSet<String> = HashSet::new();
    let mut referenced_columns: HashMap<String, HashSet<String>> = HashMap::new();
    for (_, u) in &code {
        for n in &u.named {
            let table = n.table.to_lowercase();
            referenced_tables.insert(table.clone());
            let cols = referenced_columns.entry(table).or_default();
            cols.extend(n.columns.iter().map(|(c, _)| c.to_lowercase()));
            if let Some(Obj::Fields(f)) = &n.written {
                cols.extend(f.iter().map(|f| f.key.to_lowercase()));
            }
        }
    }
    let table_coverage = if referenced_tables.len() >= 5 {
        referenced_tables.iter().filter(|t| known.contains(*t)).count() as f64 / referenced_tables.len() as f64
    } else {
        0.0
    };
    let mut unknown = Unknowns { model: &model, known: &known, table_coverage, referenced_columns, findings: vec![] };
    for (file, u) in code.iter().filter(|(f, _)| !SAMPLE.is_match(f)) {
        for n in &u.named {
            if request.changed(file, n.line) {
                unknown.table(file, n.line, &n.table);
            }
            let written_keys = match &n.written {
                Some(Obj::Fields(f)) => f.iter().map(|f| (f.key.clone(), f.line)).collect(),
                _ => vec![],
            };
            for (c, line) in n.columns.iter().chain(&written_keys).filter(|(_, l)| request.changed(file, *l)) {
                unknown.column(file, *line, &n.table, c);
            }
            for (table, cols) in &n.embedded {
                if model.tables.contains_key(&table.to_lowercase()) {
                    for (c, line) in cols.iter().filter(|(_, l)| request.changed(file, *l)) {
                        unknown.column(file, *line, table, c);
                    }
                }
            }
        }
        for call in &u.prisma {
            let Some(t) = model.prisma_table(&call.accessor) else { continue };
            let fields = call
                .data
                .iter()
                .filter_map(|o| if let Obj::Fields(f) = o { Some(f) } else { None })
                .flatten()
                .map(|f| (f.key.as_str(), f.line));
            for (key, line) in fields.chain(call.wheres.iter().map(|(k, l)| (k.as_str(), *l))).filter(|(_, l)| request.changed(file, *l)) {
                unknown.key(file, line, t, key);
            }
        }
        for (var, obj, _) in &u.drizzle {
            let (Some(t), Obj::Fields(fields)) = (model.drizzle_table(var).filter(|t| t.complete), obj) else { continue };
            for f in fields.iter().filter(|f| request.changed(file, f.line)) {
                if !t.columns.iter().any(|c| c.key == f.key) {
                    unknown.key(file, f.line, t, &f.key);
                }
            }
        }
        for (line, sql, params) in &u.sql {
            for s in
                statements(file, *line, &model.with_tables(sql, params, &u.aliases), true).iter().filter(|s| request.changed(file, s.line))
            {
                unknown.sql(file, s);
            }
        }
    }
    findings.append(&mut unknown.findings);

    // (c): the change removed the last write of a column.
    if !before.is_empty() {
        let olds: Vec<(String, Uses)> = before.iter().map(|(f, t)| (f.clone(), uses(f, t))).collect();
        let pairs: Vec<(&str, &Uses)> = olds.iter().map(|(f, u)| (f.as_str(), u)).collect();
        let old = model.written(&pairs);
        let mut gone: Vec<_> = old.cols.iter().filter(|(k, _)| !written.cols.contains_key(*k)).collect();
        gone.sort();
        // A table no code writes any more is one finding, not one per column.
        let mut tables_gone = HashSet::new();
        for ((table, _), (file, line)) in &gone {
            if !written.literal.contains(table)
                && !written.opaque.contains(table)
                && old.literal.contains(table)
                && model.tables.get(table).is_some_and(|t| t.file.starts_with(&request.prefix))
                && tables_gone.insert(table.clone())
            {
                findings.push(Finding {
                    file: file.clone(),
                    line: *line,
                    target: format!("columns:last-write:{table}"),
                    message: format!("{file}:{line} the change removes the last write to table {table}: nothing writes it any more. Drop it in a migration once nothing reads it, or keep writing it"),
                });
            }
        }
        for ((table, column), (file, line)) in gone.into_iter().filter(|((t, _), _)| !tables_gone.contains(t)) {
            let Some(c) = model.tables.get(table).and_then(|t| t.columns.iter().find(|c| &c.name.to_lowercase() == column)) else {
                continue;
            };
            if written.opaque.contains(table)
                || !c.nullable
                || c.filled
                || written.trigger.contains(column)
                || !c.file.starts_with(&request.prefix)
            {
                continue;
            }
            findings.push(Finding {
                file: file.clone(),
                line: *line,
                target: format!("columns:last-write:{table}.{column}"),
                message: format!("{file}:{line} the change removes the last write of {table}.{column}: nothing writes it any more, so new rows leave it NULL. Keep a write, or drop the column in a migration"),
            });
        }
    }

    findings.sort_by(|a, b| (&a.file, a.line, &a.target).cmp(&(&b.file, b.line, &b.target)));
    findings.dedup_by(|a, b| a.target == b.target);
    Ok(Answer::new(
        findings,
        format!(
            "{} tables and {} columns checked against {} files that use them",
            model.tables.len(),
            model.tables.values().map(|t| t.columns.len()).sum::<usize>(),
            code.len()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The findings. With `added`, only those (file, lines) are the change's; without, the whole repository.
    fn run_files(name: &str, files: &[(&str, &str)], added: Option<&[(&str, &[u32])]>, before: &[(&str, &str)]) -> Vec<Finding> {
        let request = Request {
            command: "columns".into(),
            root: text::temp_tree(&format!("columns-{name}"), files),
            files: files.iter().map(|(p, _)| p.to_string()).collect(),
            added: added.map(|a| a.iter().map(|(f, l)| (f.to_string(), l.iter().copied().collect())).collect()),
            prefix: String::new(),
            database_url: None,
            options: serde_json::json!({ "before": before.iter().map(|(f, t)| (f.to_string(), serde_json::Value::String(t.to_string()))).collect::<serde_json::Map<_, _>>() }),
        };
        run(&request).unwrap().findings
    }

    fn targets(findings: &[Finding]) -> Vec<String> {
        findings.iter().map(|f| f.target.clone()).collect()
    }

    const PROFILES: &str = "create table public.profiles (\n  id uuid primary key,\n  name text not null,\n  nickname text,\n  bio text default '',\n  updated_by uuid,\n  created_at timestamptz not null default now()\n);\ncreate table public.audit (id bigserial primary key, note text);\n";

    #[test]
    fn a_nullable_column_nothing_writes_is_reported_and_a_written_or_filled_one_is_not() {
        let got = run_files("unwritten", &[
            ("supabase/migrations/001.sql", PROFILES),
            ("supabase/migrations/002.sql", "create function stamp() returns trigger as $$ begin\n  new.updated_by := auth.uid();\n  return new;\nend $$ language plpgsql;\n"),
            ("src/profile.ts", "export const save = (name: string) => supabase.from('profiles').insert({ id: crypto.randomUUID(), name });\nexport const load = () => supabase.from('profiles').select('id, name, nickname');\n"),
        ], None, &[]);
        assert_eq!(targets(&got), vec!["columns:profiles.nickname", "columns:audit"]);
        assert!(got[0].message.contains("nothing writes profiles.nickname, so it is NULL in every row"), "{}", got[0].message);
        assert!(got[1].message.contains("nothing in the code reads or writes table audit"), "{}", got[1].message);
    }

    #[test]
    fn a_write_whose_keys_are_unknown_hides_the_table_and_another_language_naming_it_does_too() {
        let opaque = run_files("opaque", &[
            ("db/migrations/001.sql", PROFILES),
            ("src/profile.ts", "export const save = (row: Row) => supabase.from('profiles').insert(row);\nexport const note = () => db.query(\"INSERT INTO audit (note) VALUES ('x')\");\n"),
        ], None, &[]);
        assert_eq!(targets(&opaque), Vec::<String>::new());
        let swift = run_files(
            "swift",
            &[
                ("db/migrations/001.sql", PROFILES),
                ("src/profile.ts", "export const save = (name: string) => supabase.from('profiles').insert({ id: 1, name });\n"),
                ("ios/Audit.swift", "let rows = try await client.from(\"audit\").select().execute()\n"),
            ],
            None,
            &[],
        );
        assert_eq!(targets(&swift), vec!["columns:profiles.nickname", "columns:profiles.updated_by"]);
    }

    #[test]
    fn names_the_schema_does_not_have_are_reported_with_the_closest_real_one() {
        let got = run_files("unknown", &[
            ("supabase/migrations/001.sql", PROFILES),
            ("src/profile.ts", "export const load = () => supabase.from('profiles').select('id, nmae').eq('nickname', 'x');\nexport const all = () => pool.query('SELECT id FROM profils WHERE id = $1');\nexport const pics = () => supabase.storage.from('avatars').list();\nexport const tables = () => pool.query('SELECT tablename FROM pg_tables');\n"),
        ], Some(&[("src/profile.ts", &[1, 2, 3, 4])]), &[]);
        assert_eq!(targets(&got), vec!["src/profile.ts:unknown:profiles.nmae", "src/profile.ts:unknown:profils"]);
        assert!(got[0].message.contains("profiles has no column nmae (did you mean name?)"), "{}", got[0].message);
        assert!(got[1].message.contains("no table profils in the migrations or schema (did you mean profiles?)"), "{}", got[1].message);
    }

    const PRISMA: &str = "model User {\n  id        String  @id @default(uuid())\n  email     String  @unique\n  nickname  String?\n  posts     Post[]\n  @@map(\"users\")\n}\n\nmodel Post {\n  id       String  @id @default(uuid())\n  title    String\n  authorId String? @map(\"author_id\")\n  author   User?   @relation(fields: [authorId], references: [id])\n  editedAt DateTime? @updatedAt\n}\n";

    #[test]
    fn a_quoted_sql_column_keeps_its_case_and_an_unquoted_one_folds() {
        assert_eq!(ident("\"Status\""), "Status");
        assert_eq!(ident("job.\"Status\""), "Status");
        assert_eq!(ident("Status"), "status");
    }

    #[test]
    fn a_prisma_field_named_model_is_a_field_not_a_model() {
        let tables = prisma_model("schema.prisma", "model ai_run {\n  id    String @id\n  model String?\n  notes String?\n}\n");
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "ai_run");
        assert!(tables[0].columns.iter().any(|c| c.name == "notes"), "{:?}", tables[0].columns.iter().map(|c| &c.name).collect::<Vec<_>>());
    }

    #[test]
    fn prisma_nested_writes_set_the_related_rows_foreign_key_and_a_mistyped_field_is_reported() {
        let got = run_files("prisma", &[
            ("prisma/schema.prisma", PRISMA),
            ("src/users.ts", "export const signUp = (email: string, title: string) => prisma.user.create({ data: { email, nickName: 'x', posts: { create: { title } } } });\n"),
        ], None, &[]);
        let set: std::collections::BTreeSet<String> = targets(&got).into_iter().collect();
        assert_eq!(set, ["columns:users.nickname", "src/users.ts:unknown:users.nickName"].iter().map(|s| s.to_string()).collect());
        let unknown = got.iter().find(|f| f.target.contains("unknown")).unwrap();
        assert!(unknown.message.contains("the Prisma model User has no field nickName (did you mean nickname?)"), "{}", unknown.message);
    }

    #[test]
    fn drizzle_inserts_count_by_key_and_a_project_helper_column_is_left_alone() {
        let schema = "export const users = pgTable('users', {\n  id: uuid('id').primaryKey().defaultRandom(),\n  email: text('email').notNull(),\n  nick: text('nick'),\n  createdAt: createdAt(),\n});\n";
        let got = run_files(
            "drizzle",
            &[
                ("src/schema.ts", schema),
                (
                    "src/users.ts",
                    "import { users } from './schema';\nexport const add = (email: string) => db.insert(users).values({ email });\n",
                ),
            ],
            None,
            &[],
        );
        assert_eq!(targets(&got), vec!["columns:users.nick"]);
        assert!(got[0].message.contains("remove `nick` from the table"), "{}", got[0].message);
    }

    #[test]
    fn a_table_on_a_named_postgres_schema_is_read_and_raw_sql_naming_it_writes_it() {
        let migration = "create table app.events (id uuid primary key, credited_via text, note text);\n";
        let schema = "import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';\nexport const appSchema = pgSchema('app');\nexport const events = appSchema.table('events', {\n  id: uuid('id').primaryKey(),\n  creditedVia: text('credited_via'),\n  note: text('note'),\n});\n";
        let got = run_files(
            "named-schema",
            &[
                ("drizzle/0001_events.sql", migration),
                ("src/schema/events.ts", schema),
                ("src/events.ts", "import { events } from './schema/events';\nexport const add = (via: string) => db.insert(events).values({ id: '1', creditedVia: via });\n"),
            ],
            None,
            &[],
        );
        assert_eq!(targets(&got), vec!["columns:events.note"]);
        // Raw SQL that interpolates the table writes it too.
        let raw = "import { events } from './schema/events';\nexport const note = (n: string) => {\n  const t = events;\n  return db.execute(sql`insert into ${t} (id, note) values ('1', ${n})`);\n};\n";
        let got = run_files(
            "named-schema-raw",
            &[("drizzle/0001_events.sql", migration), ("src/schema/events.ts", schema), ("src/raw.ts", raw)],
            None,
            &[],
        );
        assert_eq!(targets(&got), vec!["columns:events.credited_via"]);
    }

    #[test]
    fn an_auth_library_writes_its_own_tables() {
        let schema = "export const user = pgTable('user', {\n  id: text('id').primaryKey(),\n  image: text('image'),\n});\nexport const notes = pgTable('notes', {\n  id: text('id').primaryKey(),\n  body: text('body'),\n});\n";
        let got = run_files(
            "auth",
            &[
                ("src/schema.ts", schema),
                ("src/auth.ts", "import { betterAuth } from 'better-auth';\nexport const auth = betterAuth({});\n"),
                ("src/notes.ts", "import { notes } from './schema';\nexport const add = () => db.insert(notes).values({ id: '1' });\n"),
            ],
            None,
            &[],
        );
        assert_eq!(targets(&got), vec!["columns:notes.body"]);
    }

    #[test]
    fn a_change_is_judged_on_the_columns_it_adds_and_the_last_write_it_removes() {
        let migration = "create table orders (id uuid primary key, total int not null, note text);\nalter table orders add column shipped_at timestamptz;\nalter table orders add column gift_note text;\n";
        let code = "export const ship = (id: string) => db.query('UPDATE orders SET note = $1 WHERE id = $2', ['x', id]);\nexport const add = () => db.query('INSERT INTO orders (id, total) VALUES ($1, 1)');\n";
        let files = [("db/migrations/001.sql", migration), ("src/orders.ts", code)];
        let added = run_files("added", &files, Some(&[("db/migrations/001.sql", &[3])]), &[]);
        assert_eq!(targets(&added), vec!["columns:orders.gift_note"]);
        assert!(added[0].message.contains("adds orders.gift_note, but no code writes it"), "{}", added[0].message);
        let before =
            "export const ship = (id: string) => db.query('UPDATE orders SET note = $1, shipped_at = now() WHERE id = $2', ['x', id]);\n";
        let removed = run_files("removed", &files, Some(&[("src/orders.ts", &[])]), &[("src/orders.ts", before)]);
        assert_eq!(targets(&removed), vec!["columns:last-write:orders.shipped_at"]);
    }

    #[test]
    fn reads_postgrest_select_strings() {
        let (cols, embedded) = select_columns("id, name:full_name, author:profiles!inner(id, handle), count, meta->tags", 3);
        assert_eq!(cols.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec!["id", "full_name", "meta"]);
        assert_eq!(embedded[0].0, "profiles");
        assert_eq!(embedded[0].1.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec!["id", "handle"]);
    }
}
