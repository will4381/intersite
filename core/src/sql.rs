//! The SQL check: migrations that lock or break a live table, queries that scan where they should seek, queries run
//! once per loop item, and, with a database URL, the planner's own verdict on each new query.
//! SQL comes from `.sql` files and from SQL strings in JavaScript and TypeScript (tagged `sql`, `$queryRaw`,
//! `pool.query("…")`); each statement is parsed on its own, so one the parser cannot read does not hide the rest.

use rayon::prelude::*;
use regex::Regex;
use sqlparser::ast::{visit_expressions, AlterColumnOperation, AlterTableOperation, BinaryOperator, Expr, InTarget, Statement};
use sqlparser::dialect::{MySqlDialect, PostgreSqlDialect};
use sqlparser::parser::Parser;
use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;
use std::sync::LazyLock;

use crate::text::{self, Lines};
use crate::{js, Answer, Finding, Request};

/// One statement and where it sits.
pub(crate) struct Stmt {
    pub file: String,
    pub line: u32,
    /// From a `.sql` file, or a SQL string in code.
    pub from_code: bool,
    /// MySQL (or a MySQL-compatible database such as PlanetScale's Vitess): Postgres' lock advice does not apply.
    pub mysql: bool,
    pub statement: Statement,
}

/// SQL only MySQL writes: backquoted names, a storage engine, AUTO_INCREMENT, an unsigned integer.
static MYSQL_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)`\w+`|\bENGINE\s*=|\bAUTO_INCREMENT\b|\bUNSIGNED\b").unwrap());
/// A project that declares a MySQL database: Prisma's provider (in a schema or a migration lock) or Drizzle's dialect.
static MYSQL_PROJECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"provider\s*=\s*"mysql"|dialect\s*:\s*["'](?:mysql|singlestore)["']|\bmysqlTable\("#).unwrap());

/// Whether the repository's database is MySQL, by its Prisma schema, migration lock or Drizzle config.
pub(crate) fn mysql_project(root: &str, files: &[String]) -> bool {
    files
        .iter()
        .filter(|f| f.ends_with(".prisma") || f.ends_with("migration_lock.toml") || f.contains("drizzle.config.") || f.ends_with("schema.ts"))
        .any(|f| text::read(root, f).is_some_and(|t| MYSQL_PROJECT.is_match(&t)))
}

/// A statement's text and its byte offset, split at top-level semicolons (quotes, dollar quotes and comments kept).
pub(crate) fn split(sql: &str) -> Vec<(usize, &str)> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' => {
                let quote = bytes[i];
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
            b'$' => {
                // A dollar quote: $$…$$ or $tag$…$tag$. A parameter ($1) has a digit after the dollar.
                let tag_end = sql[i + 1..].find('$').map(|j| i + 1 + j);
                if let Some(end) = tag_end.filter(|&e| sql[i + 1..e].chars().all(|c| c.is_alphanumeric() || c == '_') && !sql[i + 1..e].starts_with(|c: char| c.is_ascii_digit())) {
                    let tag = &sql[i..=end];
                    if let Some(close) = sql[end + 1..].find(tag) {
                        i = end + 1 + close + tag.len() - 1;
                    }
                }
            }
            b';' => {
                out.push((start, &sql[start..i]));
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < sql.len() {
        out.push((start, &sql[start..]));
    }
    out.into_iter().filter(|(_, s)| s.lines().any(|l| !l.trim().is_empty() && !l.trim().starts_with("--"))).collect()
}

/// The statements of one piece of SQL, with the line each starts on. Each is read as Postgres, or as MySQL when it is
/// written in MySQL's own syntax or only MySQL's parser reads it.
pub(crate) fn statements(file: &str, first_line: u32, sql: &str, from_code: bool) -> Vec<Stmt> {
    let lines = Lines::new(sql);
    let mut out = Vec::new();
    for (offset, piece) in split(sql) {
        let lead = piece.len() - piece.trim_start().len();
        let line = first_line + lines.line(offset + lead) - 1;
        let marked = MYSQL_TEXT.is_match(piece);
        let parsed = if marked { Parser::parse_sql(&MySqlDialect {}, piece).map(|p| (p, true)) } else { Err(sqlparser::parser::ParserError::ParserError(String::new())) }
            .or_else(|_| Parser::parse_sql(&PostgreSqlDialect {}, piece).map(|p| (p, false)))
            .or_else(|_| Parser::parse_sql(&MySqlDialect {}, piece).map(|p| (p, true)));
        if let Ok((parsed, mysql)) = parsed {
            out.extend(parsed.into_iter().map(|statement| Stmt { file: file.to_string(), line, from_code, mysql, statement }));
        }
    }
    out
}

/// The last part of a dotted name, unquoted and lowercased: `public."Users"` and MySQL's `` `Users` `` are `users`.
pub(crate) fn bare(name: &str) -> String {
    name.rsplit('.').next().unwrap_or(name).trim_matches(|c| c == '"' || c == '`').to_lowercase()
}

/// The column names in a parenthesised list: `(a, "b" DESC)` is a, b.
fn column_list(text: &str) -> Vec<String> {
    let inner = text.split_once('(').and_then(|(_, r)| r.split_once(')')).map_or("", |(l, _)| l);
    inner.split(',').filter_map(|c| c.split_whitespace().next()).map(bare).filter(|c| !c.is_empty()).collect()
}

#[derive(Default)]
struct Inventory {
    /// Index leading columns per table, from indexes, primary keys and unique constraints.
    indexes: HashMap<String, Vec<Vec<String>>>,
    /// Expression indexes per table, as text: `lower(email)`.
    expressions: HashMap<String, HashSet<String>>,
    /// Each column's type, as `kind` names it, latest declaration winning.
    types: HashMap<(String, String), String>,
    /// Each table's single-column primary key, which a bare `REFERENCES parent` points at.
    primary: HashMap<String, String>,
}

/// A column type reduced to what a comparison sees: `varchar(36)` and `text` are both text, `serial` is integer.
fn kind(data_type: &str) -> String {
    let t = data_type.to_lowercase();
    let base = t.split('(').next().unwrap_or("").trim();
    match base {
        "int" | "integer" | "int4" | "serial" | "serial4" => "integer",
        "bigint" | "int8" | "bigserial" | "serial8" => "bigint",
        "smallint" | "int2" | "smallserial" | "serial2" => "smallint",
        "text" | "varchar" | "character varying" | "char" | "character" | "citext" | "string" => "text",
        other => other,
    }
    .to_string()
}

/// A default that makes a UUID: `gen_random_uuid()`, `uuid_generate_v4()`, `uuidv7()`.
fn makes_uuid(options: &str) -> bool {
    let o = options.to_lowercase();
    o.contains("default") && (o.contains("gen_random_uuid") || o.contains("uuid_generate_v") || o.contains("uuidv"))
}

impl Inventory {
    fn add(&mut self, table: &str, columns: Vec<String>) {
        if !columns.is_empty() {
            self.indexes.entry(table.to_string()).or_default().push(columns);
        }
    }

    /// Whether an index on `table` starts with `columns`.
    fn covers(&self, table: &str, columns: &[String]) -> bool {
        self.indexes.get(table).is_some_and(|all| all.iter().any(|ix| ix.len() >= columns.len() && ix[..columns.len()] == *columns))
    }

    fn indexed(&self, column: &str) -> Option<&str> {
        self.indexes.iter().find(|(_, all)| all.iter().any(|ix| ix.first().is_some_and(|c| c == column))).map(|(t, _)| t.as_str())
    }
}

/// A foreign key: the child table and columns, where it was declared.
struct ForeignKey {
    file: String,
    line: u32,
    table: String,
    columns: Vec<String>,
    parent: String,
    /// The parent columns named after `REFERENCES parent`; empty means its primary key.
    parent_columns: Vec<String>,
}

/// What the migrations declare: indexes, and foreign keys.
fn inventory(all: &[Stmt]) -> (Inventory, Vec<ForeignKey>) {
    let mut inv = Inventory::default();
    let mut fks = Vec::new();
    let mut fk = |s: &Stmt, table: &str, columns: Vec<String>, text: &str| {
        let after = text.split("REFERENCES").nth(1).unwrap_or("").trim();
        let parent = bare(after.split(|c: char| c == '(' || c.is_whitespace()).next().unwrap_or(""));
        let named = after.split_once('(').filter(|(l, _)| !l.trim().contains(' ')).map(|_| column_list(after)).unwrap_or_default();
        fks.push(ForeignKey { file: s.file.clone(), line: s.line, table: table.to_string(), columns, parent, parent_columns: named });
    };
    for s in all {
        match &s.statement {
            Statement::CreateIndex(ci) => {
                let table = bare(&ci.table_name.to_string());
                let cols: Vec<String> = ci.columns.iter().map(|c| c.to_string()).collect();
                if cols.iter().any(|c| c.contains('(')) {
                    inv.expressions.entry(table.clone()).or_default().extend(cols.iter().map(|c| c.to_lowercase().replace(' ', "")));
                }
                inv.add(&table, cols.iter().map(|c| bare(c.split_whitespace().next().unwrap_or(""))).collect());
            }
            Statement::CreateTable(ct) => {
                let table = bare(&ct.name.to_string());
                for col in &ct.columns {
                    let name = bare(&col.name.to_string());
                    inv.types.insert((table.clone(), name.clone()), kind(&col.data_type.to_string()));
                    for opt in &col.options {
                        let text = opt.option.to_string().to_uppercase();
                        if text.contains("PRIMARY KEY") {
                            inv.primary.insert(table.clone(), name.clone());
                        }
                        if text.contains("PRIMARY KEY") || text.starts_with("UNIQUE") {
                            inv.add(&table, vec![name.clone()]);
                        }
                        if text.contains("REFERENCES") {
                            fk(s, &table, vec![name.clone()], &opt.option.to_string());
                        }
                    }
                }
                for c in &ct.constraints {
                    let text = c.to_string();
                    let upper = text.to_uppercase();
                    if upper.contains("FOREIGN KEY") {
                        fk(s, &table, column_list(&text[upper.find("FOREIGN KEY").unwrap_or(0)..]), &text);
                    } else if upper.contains("PRIMARY KEY") || upper.contains("UNIQUE") {
                        let cols = column_list(&text);
                        if upper.contains("PRIMARY KEY") && cols.len() == 1 {
                            inv.primary.insert(table.clone(), cols[0].clone());
                        }
                        inv.add(&table, cols);
                    }
                }
            }
            Statement::AlterTable(at) => {
                let table = bare(&at.name.to_string());
                for op in &at.operations {
                    let text = op.to_string();
                    let upper = text.to_uppercase();
                    match op {
                        AlterTableOperation::AddColumn { column_def, .. } => {
                            inv.types.insert((table.clone(), bare(&column_def.name.to_string())), kind(&column_def.data_type.to_string()));
                        }
                        AlterTableOperation::AlterColumn { column_name, op: AlterColumnOperation::SetDataType { data_type, .. } } => {
                            inv.types.insert((table.clone(), bare(&column_name.to_string())), kind(&data_type.to_string()));
                        }
                        _ => {}
                    }
                    if upper.contains("FOREIGN KEY") {
                        fk(s, &table, column_list(&text[upper.find("FOREIGN KEY").unwrap_or(0)..]), &text);
                    } else if upper.starts_with("ADD") && upper.contains("REFERENCES") {
                        if let AlterTableOperation::AddColumn { column_def, .. } = op {
                            fk(s, &table, vec![bare(&column_def.name.to_string())], &text);
                        }
                    } else if upper.starts_with("ADD") && (upper.contains("PRIMARY KEY") || upper.contains("UNIQUE")) {
                        inv.add(&table, column_list(&text));
                    }
                }
            }
            _ => {}
        }
    }
    (inv, fks)
}

fn finding(s: &Stmt, rule: &str, key: &str, message: String) -> Finding {
    Finding { file: s.file.clone(), line: s.line, target: format!("{}:{rule}:{key}", s.file), message: format!("{}:{} {message}", s.file, s.line) }
}

/// Migration hazards: statements that lock a live table, fail on one with rows, or break the code still running.
/// `crowded` holds the migration files with more than one statement.
fn migration(s: &Stmt, created_here: &HashSet<(String, String)>, crowded: &HashSet<&str>, out: &mut Vec<Finding>) {
    let fresh = |table: &str| created_here.contains(&(s.file.clone(), table.to_string()));
    // MySQL builds an index and adds a column or a foreign key online (InnoDB's online DDL), fills a NOT NULL column it
    // adds with the type's implicit default, and has no CONCURRENTLY, NOT VALID or SET NOT NULL to advise: those
    // Postgres hazards are not MySQL's. Dropping or renaming what running code reads breaks either.
    let postgres_only = |rule: &str| s.mysql && matches!(rule, "concurrently-in-transaction" | "index-locks" | "not-null-column" | "foreign-key-locks" | "set-not-null");
    let before = out.len();
    // Prisma sends a migration file as one script, which Postgres runs as one transaction, and CONCURRENTLY refuses to
    // run inside a transaction: it works only as the file's one statement.
    let prisma = s.file.contains("prisma/migrations/");
    match &s.statement {
        Statement::CreateIndex(ci) if ci.concurrently && prisma && crowded.contains(s.file.as_str()) => {
            let table = bare(&ci.table_name.to_string());
            out.push(finding(s, "concurrently-in-transaction", &table, format!("CREATE INDEX CONCURRENTLY on {table} shares its migration file with other statements, and Prisma applies a file as one transaction, which CONCURRENTLY refuses: the deploy fails. Move it to a migration file of its own")));
        }
        Statement::CreateIndex(ci) if !ci.concurrently && !fresh(&bare(&ci.table_name.to_string())) => {
            let table = bare(&ci.table_name.to_string());
            let how = if prisma {
                "use CREATE INDEX CONCURRENTLY as the only statement of a migration file of its own (Prisma applies a file as one transaction, which CONCURRENTLY refuses)"
            } else if s.file.contains("drizzle") {
                "drizzle-kit applies migrations inside a transaction, which CONCURRENTLY refuses, so run CREATE INDEX CONCURRENTLY outside it"
            } else {
                "use CREATE INDEX CONCURRENTLY (outside a transaction)"
            };
            out.push(finding(s, "index-locks", &table, format!("CREATE INDEX on {table} blocks every write to it until the index is built: {how}. Before launch, with no writes to block, acknowledge it instead")));
        }
        Statement::AlterTable(at) => {
            let table = bare(&at.name.to_string());
            if fresh(&table) {
                return;
            }
            for op in &at.operations {
                match op {
                    AlterTableOperation::AddColumn { column_def, .. } => {
                        let opts = column_def.options.iter().map(|o| o.option.to_string().to_uppercase()).collect::<Vec<_>>().join(" ");
                        let col = bare(&column_def.name.to_string());
                        if opts.contains("NOT NULL") && !opts.contains("DEFAULT") && !opts.contains("GENERATED") {
                            out.push(finding(s, "not-null-column", &format!("{table}.{col}"), format!("adds {table}.{col} NOT NULL with no DEFAULT, which fails on a table that has rows: add a DEFAULT, or add it nullable, backfill, then SET NOT NULL")));
                        }
                    }
                    AlterTableOperation::AddConstraint { constraint, not_valid } if !not_valid && constraint.to_string().to_uppercase().contains("FOREIGN KEY") => {
                        out.push(finding(s, "foreign-key-locks", &table, format!("adds a foreign key to {table}, which checks every row while holding a lock on both tables: add it NOT VALID, then VALIDATE CONSTRAINT in a later step")));
                    }
                    AlterTableOperation::DropColumn { .. } => {
                        out.push(finding(s, "drop-column", &table, format!("drops a column of {table} while the deployed code may still read it: ship the code that stops using it first, then drop it in a later migration")));
                    }
                    AlterTableOperation::RenameColumn { .. } | AlterTableOperation::RenameTable { .. } => {
                        out.push(finding(s, "rename", &table, format!("renames in {table}, which breaks the code still running during the deploy: add the new name, move readers and writers to it, then drop the old")));
                    }
                    AlterTableOperation::AlterColumn { column_name, op } => {
                        let col = bare(&column_name.to_string());
                        match op {
                            AlterColumnOperation::SetNotNull => out.push(finding(s, "set-not-null", &format!("{table}.{col}"), format!("SET NOT NULL on {table}.{col} scans the whole table under an exclusive lock: add CHECK ({col} IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL"))),
                            AlterColumnOperation::SetDataType { .. } => out.push(finding(s, "column-type", &format!("{table}.{col}"), format!("changing the type of {table}.{col} rewrites the table under an exclusive lock: add a new column, backfill it, switch reads, then drop the old one"))),
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
        }
        Statement::Delete(d) if !s.from_code && d.selection.is_none() => {
            out.push(finding(s, "data-deletion", "delete", "DELETE with no WHERE in a migration removes every row of the table, in every environment it runs in: delete only the rows meant (add the WHERE), and if emptying the table is the point, say so in an acknowledgment".into()));
        }
        Statement::Truncate(_) if !s.from_code => {
            out.push(finding(s, "data-deletion", "truncate", "TRUNCATE in a migration empties the table in every environment it runs in, production included: delete only the rows meant, and if emptying the table is the point, say so in an acknowledgment".into()));
        }
        Statement::Drop { .. } if s.statement.to_string().to_uppercase().starts_with("DROP TABLE") => {
            out.push(finding(s, "drop-table", "table", "drops a table while the deployed code may still read it: ship the code that stops using it first, then drop it in a later migration".into()));
        }
        _ => {}
    }
    let mut i = before;
    while i < out.len() {
        if postgres_only(out[i].target.rsplit(':').nth(1).unwrap_or("")) {
            out.remove(i);
        } else {
            i += 1;
        }
    }
}

/// A column that holds UUIDs as text: 36 characters where the uuid type stores 16 bytes, compared and indexed as
/// strings, and never checked to be a UUID. Applies to new tables too: the type is cheapest to fix before rows exist.
fn uuid_as_text(s: &Stmt, inv: &Inventory, out: &mut Vec<Finding>) {
    // MySQL has no uuid type: CHAR(36) or BINARY(16) is how it stores one.
    if s.mysql {
        return;
    }
    let mut check = |table: &str, col: &sqlparser::ast::ColumnDef| {
        let options = col.options.iter().map(|o| o.option.to_string()).collect::<Vec<_>>().join(" ");
        let name = bare(&col.name.to_string());
        // A later migration that changed the column to uuid has fixed it.
        let still_text = inv.types.get(&(table.to_string(), name.clone())).is_none_or(|t| t == "text");
        if kind(&col.data_type.to_string()) == "text" && makes_uuid(&options) && still_text {
            out.push(finding(s, "uuid-as-text", &format!("{table}.{name}"), format!("{table}.{name} is {} filled with generated UUIDs: store them as uuid (16 bytes, compared as numbers, rejected when malformed) instead of text", col.data_type)));
        }
    };
    match &s.statement {
        Statement::CreateTable(ct) => {
            let table = bare(&ct.name.to_string());
            for col in &ct.columns {
                check(&table, col);
            }
        }
        Statement::AlterTable(at) => {
            let table = bare(&at.name.to_string());
            for op in &at.operations {
                if let AlterTableOperation::AddColumn { column_def, .. } = op {
                    check(&table, column_def);
                }
            }
        }
        _ => {}
    }
}

/// Prisma models: an `@id` or relation field generated by `uuid()` but stored as text, because `String` maps to text
/// on Postgres unless the field says `@db.Uuid`.
fn prisma(file: &str, src: &str, request: &Request) -> Vec<Finding> {
    if !src.contains("postgresql") && !src.contains("postgres") {
        return vec![];
    }
    let mut out = Vec::new();
    let mut model = String::new();
    for (i, line) in src.lines().enumerate() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("model ").filter(|_| trimmed.split("//").next().unwrap_or("").trim_end().ends_with('{')) {
            model = rest.split_whitespace().next().unwrap_or("").to_string();
            continue;
        }
        let mut words = trimmed.split_whitespace();
        let (Some(field), Some(ty)) = (words.next(), words.next()) else { continue };
        let n = i as u32 + 1;
        if ty == "String" && trimmed.contains("@default(uuid(") && !trimmed.contains("@db.Uuid") && request.changed(file, n) {
            out.push(Finding {
                file: file.to_string(),
                line: n,
                target: format!("{file}:uuid-as-text:{model}.{field}"),
                message: format!("{file}:{n} {model}.{field} is generated by uuid() but String is text on Postgres: add @db.Uuid (and to the fields that reference it) so it is stored in 16 bytes and checked to be a UUID"),
            });
        }
    }
    out
}

/// The identifier a function in a comparison wraps: `lower(email)` wraps email.
fn wrapped_column(f: &str) -> Option<(String, String)> {
    let (name, rest) = f.split_once('(')?;
    let arg = rest.trim_end_matches(')').split(',').next()?.trim();
    let ident = arg.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '"') && !arg.is_empty() && !arg.starts_with('$') && !arg.chars().next()?.is_ascii_digit();
    ident.then(|| (name.trim().to_lowercase(), bare(arg)))
}

/// Query patterns that scan where they should seek, or return wrong answers. Only the application's queries: a
/// migration's backfill updates every row on purpose, and a one-off scan in a migration costs nothing at runtime.
fn query(s: &Stmt, inv: &Inventory, out: &mut Vec<Finding>) {
    if !s.from_code {
        return;
    }
    let text = s.statement.to_string();
    let upper = text.to_uppercase();
    match &s.statement {
        Statement::Update(u) if u.selection.is_none() => out.push(finding(s, "update-all", "update", "UPDATE with no WHERE changes every row of the table: add the WHERE that picks the rows meant".into())),
        Statement::Delete(d) if d.selection.is_none() => out.push(finding(s, "delete-all", "delete", "DELETE with no WHERE removes every row of the table: add the WHERE that picks the rows meant".into())),
        Statement::Truncate(_) => out.push(finding(s, "truncate", "truncate", "TRUNCATE in application code empties the table for every user, and cannot be rolled back once committed: delete only the rows meant, with a WHERE".into())),
        _ => {}
    }
    if !matches!(s.statement, Statement::Query(_) | Statement::Update(_) | Statement::Delete(_) | Statement::Insert(_)) {
        return;
    }
    if upper.starts_with("SELECT * ") {
        out.push(finding(s, "select-star", "select", "SELECT * reads every column, ones added later included: list the columns this code uses".into()));
    }
    if upper.contains("ORDER BY RANDOM()") {
        out.push(finding(s, "order-random", "random", "ORDER BY random() reads and sorts the whole table to pick a few rows: use TABLESAMPLE, or pick a random key and seek to it".into()));
    }
    if let Some(after) = upper.split(" OFFSET ").nth(1) {
        let value = after.split_whitespace().next().unwrap_or("");
        if value.starts_with('$') || value.parse::<u64>().is_ok_and(|n| n >= 50) {
            out.push(finding(s, "offset", "offset", "OFFSET pagination reads and throws away every skipped row, so each page is slower than the last: page by the last key seen (WHERE id > $1 ORDER BY id LIMIT n)".into()));
        }
    }
    let mut seen = HashSet::new();
    let _ = visit_expressions(&s.statement, |e: &Expr| {
        match e {
            Expr::Like { pattern, negated: false, .. } | Expr::ILike { pattern, negated: false, .. } if pattern.to_string().starts_with("'%") => {
                if seen.insert("like") {
                    out.push(finding(s, "leading-wildcard", "like", format!("LIKE {pattern} starts with a wildcard, so no b-tree index can serve it and every row is read: anchor the pattern at the start, or add a pg_trgm GIN index")));
                }
            }
            Expr::In { negated: true, target: InTarget::Subquery(_), .. } if seen.insert("not-in") => {
                out.push(finding(s, "not-in-subquery", "not-in", "NOT IN (subquery) returns no rows at all when the subquery yields a NULL, and plans poorly: use NOT EXISTS".into()));
            }
            Expr::BinaryOp { left, op: BinaryOperator::Eq | BinaryOperator::Lt | BinaryOperator::LtEq | BinaryOperator::Gt | BinaryOperator::GtEq, .. } => {
                if let Expr::Function(_) = left.as_ref() {
                    let f = left.to_string();
                    if let Some((func, col)) = wrapped_column(&f) {
                        let table = inv.indexed(&col).map(str::to_string);
                        let expression_indexed = table.as_ref().is_some_and(|t| inv.expressions.get(t).is_some_and(|ex| ex.contains(&f.to_lowercase().replace(' ', ""))));
                        if let (Some(table), false) = (table, expression_indexed) {
                            if seen.insert("function") {
                                out.push(finding(s, "function-on-column", &format!("{table}.{col}"), format!("{func}({col}) in a comparison cannot use the index on {table}({col}), so every row is read: index the expression (CREATE INDEX CONCURRENTLY ON {table} ({f})) or compare the column itself")));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        ControlFlow::<()>::Continue(())
    });
}

/// The SQL of every file: `.sql` files whole, code files' SQL strings, and code files' queries inside loops.
/// One file's statements, and the database calls it makes inside loops with the function they call.
type FileScan = (Vec<Stmt>, Vec<(String, js::DbInLoop)>, Vec<(String, js::Wipe)>);

fn read_all(request: &Request) -> (Vec<Stmt>, Vec<(String, js::DbInLoop)>, Vec<(String, js::Wipe)>) {
    // Prisma schemas are read in run(); here only SQL and code.
    let per_file: Vec<FileScan> = request
        .files
        .par_iter()
        .filter_map(|file| {
            let src = text::read(&request.root, file)?;
            if file.ends_with(".prisma") || DEPLOY.is_match(file) {
                return None;
            }
            if file.ends_with(".sql") {
                return Some((statements(file, 1, &src, false), vec![], vec![]));
            }
            let facts = js::facts(file, &src)?;
            let stmts = facts.sql.iter().flat_map(|site| statements(file, site.line, &site.text, true)).collect();
            let loops = facts.db_in_loops.into_iter().map(|d| (file.clone(), d)).collect();
            let wipes = facts.wipes.into_iter().map(|w| (file.clone(), w)).collect();
            Some((stmts, loops, wipes))
        })
        .collect();
    let mut stmts = Vec::new();
    let mut loops = Vec::new();
    let mut wipes = Vec::new();
    for (s, l, w) in per_file {
        stmts.extend(s);
        loops.extend(l);
        wipes.extend(w);
    }
    (stmts, loops, wipes)
}

/// Scripts, CI and deploy files, where a command that empties a database would run on its own.
static DEPLOY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:package\.json|Dockerfile[^/]*|[^/]*\.Dockerfile|Makefile|Justfile|justfile|Procfile|vercel\.json|netlify\.toml|fly\.toml|render\.ya?ml|railway\.(?:json|toml)|nixpacks\.toml|\.gitlab-ci\.ya?ml|bitbucket-pipelines\.ya?ml|[^/]*\.sh)$|(?:^|/)\.github/workflows/[^/]+\.ya?ml$").unwrap());
static DESTRUCTIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)prisma\s+migrate\s+reset|prisma\s+db\s+push\b[^\n]*--(?:accept-data-loss|force-reset)|drizzle-kit\s+push\b[^\n]*(?:--force|\s-f\b)|supabase\s+db\s+reset\b[^\n]*--(?:linked|db-url)|\bdrop\s+database\b|\bdropdb\b").unwrap());
/// A script or Makefile target meant for a local database.
static LOCAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)dev|local|test|e2e|qa|reset|seed|fresh|clean|wipe|nuke").unwrap());
/// package.json scripts that run on their own: builds, starts, installs, deploys.
static AUTOMATIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:pre|post)?(?:build|start|install|prepare|deploy|release|serve|vercel-build|heroku-postbuild)$|deploy|prod|release|(?:^|:)ci(?:$|:)|^build:|^start:").unwrap());
static RUNS_SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)").unwrap());

/// Commands that empty a database added where they run unattended: a deploy, a build, CI, a start script.
fn destructive_commands(request: &Request) -> Vec<Finding> {
    let mut out = Vec::new();
    for file in request.files.iter().filter(|f| DEPLOY.is_match(f)) {
        let Some(src) = text::read(&request.root, file) else { continue };
        if !DESTRUCTIVE.is_match(&src) {
            continue;
        }
        let name = file.rsplit('/').next().unwrap_or(file);
        let lines: Vec<&str> = src.lines().collect();
        // package.json: the scripts that run on their own, and the scripts they run.
        let mut automatic: HashMap<String, String> = HashMap::new();
        if name == "package.json" {
            let scripts = serde_json::from_str::<serde_json::Value>(&src).ok().and_then(|v| v.get("scripts").cloned()).unwrap_or_default();
            if let Some(scripts) = scripts.as_object() {
                for (key, cmd) in scripts.iter().filter(|(k, _)| AUTOMATIC.is_match(k) && !LOCAL.is_match(k)) {
                    automatic.insert(key.clone(), key.clone());
                    for called in RUNS_SCRIPT.captures_iter(cmd.as_str().unwrap_or("")) {
                        automatic.entry(called[1].to_string()).or_insert_with(|| key.clone());
                    }
                }
            }
        }
        let ci = file.contains(".github/workflows/") || name.contains("gitlab-ci") || name.contains("bitbucket");
        // CI that starts its own database (a service container on localhost) resets a throwaway one.
        if ci && (src.contains("services:") || src.contains("localhost") || src.contains("127.0.0.1")) {
            continue;
        }
        // A script that works on a database in a local container, or is named for local work.
        let local_file = (name.ends_with(".sh") || name.eq_ignore_ascii_case("makefile") || name.eq_ignore_ascii_case("justfile")) && (LOCAL.is_match(file) || src.contains("docker") || src.contains("localhost") || src.contains("127.0.0.1"));
        for (i, line) in lines.iter().enumerate() {
            let n = i as u32 + 1;
            let Some(m) = DESTRUCTIVE.find(line) else { continue };
            if !request.changed(file, n) || local_file {
                continue;
            }
            let runs = if name == "package.json" {
                let key = line.trim().trim_start_matches('"').split('"').next().unwrap_or("");
                match automatic.get(key) {
                    Some(by) if by == key => format!("the `{key}` script, which runs on its own,"),
                    Some(by) => format!("the `{key}` script, which `{by}` runs,"),
                    None => continue,
                }
            } else if name.ends_with(".sh") || name.eq_ignore_ascii_case("makefile") || name.eq_ignore_ascii_case("justfile") {
                // The Makefile target this line belongs to.
                let target = lines[..i].iter().rev().find(|l| !l.starts_with(char::is_whitespace) && l.contains(':')).map(|l| l.split(':').next().unwrap_or("").trim()).unwrap_or("");
                if LOCAL.is_match(target) {
                    continue;
                }
                file.to_string()
            } else if ci {
                "CI".to_string()
            } else {
                "the deploy".to_string()
            };
            out.push(Finding {
                file: file.clone(),
                line: n,
                target: format!("{file}:destructive-command:{}", m.as_str().split_whitespace().take(3).collect::<Vec<_>>().join(" ").to_lowercase()),
                message: format!("{file}:{n} `{}` deletes the database's data, and {runs} runs it against whatever database it points at, production included: deploy with `prisma migrate deploy`, `drizzle-kit migrate` or `supabase db push`, and run resets by hand against a local database only", m.as_str()),
            });
        }
    }
    out
}

static RLS_TABLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)"#).unwrap());
static RLS_ON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+(enable|disable|force)\s+row\s+level\s+security"#).unwrap());
static RLS_RENAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+rename\s+to\s+("?\w+"?)"#).unwrap());
static RLS_DROP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^\s*drop\s+table\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)"#).unwrap());
static POLICY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^\s*create\s+policy\s+("[^"]+"|\S+)\s+on\s+((?:"?\w+"?\.)?"?\w+"?)(.*)$"#).unwrap());
static DROP_POLICY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^\s*drop\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|\S+)\s+on\s+((?:"?\w+"?\.)?"?\w+"?)"#).unwrap());

/// Whether a dotted table name is in the schema the API serves: `public`, or unqualified.
fn in_public(name: &str) -> bool {
    !name.contains('.') || name.trim_start_matches('"').to_lowercase().starts_with("public")
}

/// Supabase serves the public schema over its API with the anon key the app ships: a table there without row level
/// security, or with a policy that lets anyone change any row, is open to everyone.
fn supabase_security(request: &Request) -> Vec<Finding> {
    let mut files: Vec<&String> = request.files.iter().filter(|f| (f.contains("supabase/migrations/") || f.contains("supabase/schemas/")) && f.ends_with(".sql")).collect();
    if files.is_empty() {
        return vec![];
    }
    files.sort();
    let mut created: HashMap<String, (String, u32)> = HashMap::new();
    let mut secured: HashSet<String> = HashSet::new();
    // Turned off on purpose later: reported where it is turned off, not again where it was made.
    let mut disabled: HashSet<String> = HashSet::new();
    let mut every_table = false;
    let mut policies: HashMap<(String, String), (String, u32, String)> = HashMap::new();
    let mut out = Vec::new();
    for file in files {
        let Some(src) = text::read(&request.root, file) else { continue };
        let lines = Lines::new(&src);
        for (offset, piece) in split(&src) {
            // The statement without the comments before it.
            let mut body = piece;
            loop {
                let t = body.trim_start();
                if let Some(rest) = t.strip_prefix("--") {
                    body = rest.split_once('\n').map_or("", |(_, r)| r);
                } else if let Some(rest) = t.strip_prefix("/*") {
                    body = rest.split_once("*/").map_or("", |(_, r)| r);
                } else {
                    body = t;
                    break;
                }
            }
            let line = lines.line(offset + (piece.len() - body.len()));
            let piece = body;
            if let Some(m) = RLS_TABLE.captures(piece) {
                if in_public(&m[1]) && !piece.to_lowercase().contains(" as select") && !piece.to_lowercase().contains(" partition of ") {
                    created.entry(bare(&m[1])).or_insert((file.clone(), line));
                }
            } else if let Some(m) = RLS_ON.captures(piece) {
                let table = bare(&m[1]);
                if m[2].eq_ignore_ascii_case("disable") {
                    secured.remove(&table);
                    disabled.insert(table.clone());
                    if request.changed(file, line) {
                        out.push(Finding { file: file.clone(), line, target: format!("{file}:rls-disabled:{table}"), message: format!("{file}:{line} turns off row level security on {table}: anyone with the anon key the app ships can then read and change every row through the API. Keep it on and write a policy for who may do what") });
                    }
                } else {
                    disabled.remove(&table);
                    secured.insert(table);
                }
            } else if let Some(m) = RLS_RENAME.captures(piece) {
                let (from, to) = (bare(&m[1]), bare(&m[2]));
                if let Some(at) = created.remove(&from) {
                    created.insert(to.clone(), at);
                }
                if secured.remove(&from) {
                    secured.insert(to);
                }
            } else if let Some(m) = RLS_DROP.captures(piece) {
                created.remove(&bare(&m[1]));
            } else if let Some(m) = POLICY.captures(piece) {
                policies.insert((m[1].trim_matches('"').to_string(), bare(&m[2])), (file.clone(), line, m[3].to_lowercase()));
            } else if let Some(m) = DROP_POLICY.captures(piece) {
                policies.remove(&(m[1].trim_matches('"').to_string(), bare(&m[2])));
            }
            let lower = piece.to_lowercase();
            // A loop that enables it on every table (`execute format('alter table %I enable row level security', …)`).
            if lower.contains("enable row level security") && (lower.contains("format(") || lower.contains("%i") || lower.contains("execute ")) {
                every_table = true;
            }
        }
    }
    if !every_table {
        let mut open: Vec<(&String, &(String, u32))> = created.iter().filter(|(t, (f, l))| !secured.contains(*t) && !disabled.contains(*t) && request.changed(f, *l)).collect();
        open.sort_by(|a, b| a.1.cmp(b.1));
        for (table, (file, line)) in open {
            out.push(Finding { file: file.clone(), line: *line, target: format!("{file}:rls:{table}"), message: format!("{file}:{line} creates {table} in the public schema without row level security, so anyone with the anon key the app ships can read and change every row through the API: ALTER TABLE {table} ENABLE ROW LEVEL SECURITY, with policies for who may read and write") });
        }
    }
    let roles = Regex::new(r"(?s)\bto\s+(.+?)(?:\busing\b|\bwith\s+check\b|$)").unwrap();
    let mut sorted: Vec<(&(String, String), &(String, u32, String))> = policies.iter().filter(|(_, (f, l, _))| request.changed(f, *l)).collect();
    sorted.sort_by(|a, b| (&a.1 .0, a.1 .1).cmp(&(&b.1 .0, b.1 .1)));
    for ((name, table), (file, line, rest)) in sorted {
        if rest.contains("as restrictive") {
            continue;
        }
        let compact: String = rest.chars().filter(|c| !c.is_whitespace()).collect();
        let command = ["select", "insert", "update", "delete"].into_iter().find(|c| rest.contains(&format!("for {c}"))).unwrap_or("all");
        let who: Vec<String> = roles.captures(rest).map_or(vec!["public".into()], |m| m[1].split(',').map(|r| r.trim().trim_matches('"').to_string()).collect());
        let using_true = compact.contains("using(true)");
        let check_true = compact.contains("withcheck(true)");
        let everyone = who.iter().any(|r| r == "public" || r == "anon");
        let signed_in = who.iter().any(|r| r == "authenticated");
        let opens = match command {
            "update" | "delete" | "all" => (using_true || check_true) && (everyone || signed_in),
            "insert" => check_true && everyone,
            _ => false,
        };
        if opens {
            let whom = if everyone { "anyone, signed in or not," } else { "any signed-in user" };
            out.push(Finding { file: file.clone(), line: *line, target: format!("{file}:open-policy:{table}:{name}"), message: format!("{file}:{line} policy \"{name}\" lets {whom} {} every row of {table} (its condition is `true`): compare the row to auth.uid() or the caller's organization instead", if command == "all" { "read and change".to_string() } else { command.to_string() }) });
        }
    }
    out
}

/// pg_stat_statements before and after a traced run.
pub fn stats(request: &Request) -> Result<Answer, String> {
    let url = request.database_url.as_deref().filter(|u| !u.is_empty()).ok_or("pg-stats needs a database URL")?;
    let min_rows = request.options.get("minRows").and_then(|v| v.as_f64()).unwrap_or(10_000.0);
    let data = explain::stats(url, request.options.get("before"), min_rows)?;
    Ok(Answer { findings: vec![], summary: "pg_stat_statements read".into(), data: Some(data) })
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let (mut stmts, loops, wipes) = read_all(request);
    if mysql_project(&request.root, &request.files) {
        for s in &mut stmts {
            s.mysql = true;
        }
    }
    let (inv, fks) = inventory(&stmts);
    let mysql_files: HashSet<&str> = stmts.iter().filter(|s| s.mysql).map(|s| s.file.as_str()).collect();
    let created_here: HashSet<(String, String)> = stmts.iter().filter_map(|s| match &s.statement {
        Statement::CreateTable(ct) => Some((s.file.clone(), bare(&ct.name.to_string()))),
        _ => None,
    }).collect();
    let mut per_file: HashMap<&str, usize> = HashMap::new();
    for st in stmts.iter().filter(|st| !st.from_code) {
        *per_file.entry(st.file.as_str()).or_default() += 1;
    }
    let crowded: HashSet<&str> = per_file.into_iter().filter(|(_, n)| *n > 1).map(|(f, _)| f).collect();
    // A statement counts when any line of it was added: a query edited in its WHERE clause is a new query.
    let changed = |s: &Stmt| {
        let span = s.statement.to_string().matches(' ').count().min(400) as u32 / 6 + 1;
        (s.line..s.line + span.max(1)).any(|l| request.changed(&s.file, l)) || request.changed(&s.file, s.line)
    };
    let mut findings = Vec::new();
    // Judging the whole repository, a migration already in it has run or will run as written: its locks and breaks are
    // history. Only the schema it leaves behind is judged (keys, indexes, column types), as the latest migration says.
    let whole = request.added.is_none();
    let mut history = 0;
    for s in stmts.iter().filter(|s| changed(s)) {
        if whole && !s.from_code {
            let mut skipped = Vec::new();
            migration(s, &created_here, &crowded, &mut skipped);
            history += skipped.len();
        } else {
            migration(s, &created_here, &crowded, &mut findings);
        }
        uuid_as_text(s, &inv, &mut findings);
        query(s, &inv, &mut findings);
    }
    for file in request.files.iter().filter(|f| f.ends_with(".prisma")) {
        if let Some(src) = text::read(&request.root, file) {
            findings.extend(prisma(file, &src, request));
        }
    }
    for fk in fks.iter().filter(|f| request.changed(&f.file, f.line)) {
        // A key compared with a column of another type casts on every join, so neither side's index is used; an
        // integer key pointing at a bigint one also overflows once the parent passes 2^31 rows.
        let parents: Vec<String> = if fk.parent_columns.is_empty() { inv.primary.get(&fk.parent).cloned().into_iter().collect() } else { fk.parent_columns.clone() };
        if parents.len() == fk.columns.len() {
            for (child, parent) in fk.columns.iter().zip(&parents) {
                let (Some(a), Some(b)) = (inv.types.get(&(fk.table.clone(), child.clone())), inv.types.get(&(fk.parent.clone(), parent.clone()))) else { continue };
                if a != b {
                    findings.push(Finding {
                        file: fk.file.clone(),
                        line: fk.line,
                        target: format!("{}:fk-type:{}.{child}", fk.file, fk.table),
                        message: format!("{}:{} {}.{child} is {a} but references {}.{parent}, which is {b}: every join casts one side, so its index goes unused{}; make {child} {b}", fk.file, fk.line, fk.table, fk.parent, if b == "uuid" { ", and the column accepts strings that are not UUIDs" } else { "" }),
                    });
                }
            }
        }
        // InnoDB makes the index a foreign key needs when it is added.
        if !inv.covers(&fk.table, &fk.columns) && !mysql_files.contains(fk.file.as_str()) {
            let cols = fk.columns.join(", ");
            findings.push(Finding {
                file: fk.file.clone(),
                line: fk.line,
                target: format!("{}:fk-index:{}.{}", fk.file, fk.table, cols),
                message: format!("{}:{} {}({cols}) references {} but no index starts with ({cols}), so deleting a {} row or joining scans {}: CREATE INDEX CONCURRENTLY ON {} ({cols})", fk.file, fk.line, fk.table, fk.parent, fk.parent, fk.table, fk.table),
            });
        }
    }
    // One finding per loop, naming every query in it: the fix (fetch before the loop) is one change.
    let mut per_loop: Vec<((String, u32), Vec<&js::DbInLoop>)> = Vec::new();
    for (file, d) in loops.iter().filter(|(f, d)| request.changed(f, d.line)) {
        match per_loop.iter_mut().find(|(k, _)| k.0 == *file && k.1 == d.loop_line) {
            Some((_, calls)) => calls.push(d),
            None => per_loop.push(((file.clone(), d.loop_line), vec![d])),
        }
    }
    for ((file, loop_line), calls) in per_loop {
        let mut names: Vec<&str> = calls.iter().map(|d| d.call.as_str()).collect();
        names.dedup();
        let what = if calls.len() == 1 { format!("{} runs", names[0]) } else { format!("{} queries ({}) run", calls.len(), names.join(", ")) };
        findings.push(Finding {
            file: file.clone(),
            line: calls[0].line,
            target: format!("{file}:n-plus-one:{}", names[0]),
            message: format!("{file}:{} {what} once per item of the loop at line {loop_line}, a round trip each: fetch them all in one query before the loop (an IN list, findMany, or a join), or batch the writes into one statement", calls[0].line),
        });
    }
    for (file, w) in wipes.iter().filter(|(f, w)| request.changed(f, w.line)) {
        findings.push(Finding {
            file: file.clone(),
            line: w.line,
            target: format!("{file}:unfiltered-{}:{}", w.method, w.table),
            message: format!("{file}:{} .{}() on {} has no filter, so it targets every row (Supabase refuses it with \"requires a WHERE clause\"; other clients run it): add .eq(...) or .in(...) for the rows meant", w.line, w.method, w.table),
        });
    }
    findings.extend(destructive_commands(request));
    findings.extend(supabase_security(request));
    let mut explained = 0;
    if let Some(url) = request.database_url.as_deref().filter(|u| !u.is_empty()) {
        let fresh: Vec<&Stmt> = stmts.iter().filter(|s| s.from_code && changed(s) && matches!(s.statement, Statement::Query(_) | Statement::Update(_) | Statement::Delete(_))).collect();
        let (more, count) = crate::sql::explain::plans(url, &fresh, request.options.get("minRows").and_then(|v| v.as_f64()).unwrap_or(10_000.0))?;
        findings.extend(more);
        explained = count;
    }
    let past = if history > 0 { format!("; {history} hazards in migrations already written are history, not judged") } else { String::new() };
    let summary = format!("{} SQL statements and {} queries in loops read{}{past}", stmts.len(), loops.len(), if explained > 0 { format!(", {explained} planned against the database") } else { String::new() });
    Ok(Answer { findings, summary, data: None })
}

mod explain {
    //! The planner's verdict on a query, without running it: PREPARE, then EXPLAIN the generic plan, all in a
    //! read-only transaction that is rolled back. A sequential scan with a filter on a large table is an index to add.

    use super::{bare, Finding, Stmt};
    use postgres::{Client, NoTls};

    fn connect(url: &str) -> Result<Client, String> {
        if url.contains("sslmode=disable") || url.contains("localhost") || url.contains("127.0.0.1") {
            return Client::connect(url, NoTls).map_err(|e| format!("cannot connect to the database: {e}"));
        }
        let tls = native_tls::TlsConnector::builder().build().map_err(|e| e.to_string())?;
        Client::connect(url, postgres_native_tls::MakeTlsConnector::new(tls)).map_err(|e| format!("cannot connect to the database: {e}"))
    }

    /// Scans in a plan: (table, filter) for each sequential scan with a filter.
    fn scans(plan: &serde_json::Value, out: &mut Vec<(String, String)>) {
        if plan.get("Node Type").and_then(|v| v.as_str()) == Some("Seq Scan") {
            if let (Some(table), Some(filter)) = (plan.get("Relation Name").and_then(|v| v.as_str()), plan.get("Filter").and_then(|v| v.as_str())) {
                out.push((table.to_string(), filter.to_string()));
            }
        }
        for child in plan.get("Plans").and_then(|v| v.as_array()).into_iter().flatten() {
            scans(child, out);
        }
    }

    /// The planner's sequential scans of large tables for one query, each with the index that would serve it.
    fn advice(client: &mut Client, sql: &str, min_rows: f64) -> Option<Vec<(String, String, f64, String)>> {
        let params = (1..=99).take_while(|n| sql.contains(&format!("${n}"))).count();
        let mut tx = client.transaction().ok()?;
        let prepared = tx.batch_execute("SET TRANSACTION READ ONLY; SET LOCAL plan_cache_mode = force_generic_plan").and_then(|_| tx.batch_execute(&format!("PREPARE intersite_q AS {sql}")));
        if prepared.is_err() {
            let _ = tx.rollback();
            return None;
        }
        let args = vec!["NULL"; params].join(", ");
        let execute = if params > 0 { format!("EXECUTE intersite_q({args})") } else { "EXECUTE intersite_q".into() };
        let rows = tx.query(&format!("EXPLAIN (FORMAT JSON) {execute}"), &[]);
        let _ = tx.rollback();
        let json: serde_json::Value = rows.ok()?.first()?.get(0);
        let mut found = Vec::new();
        scans(&json[0]["Plan"], &mut found);
        let mut out = Vec::new();
        for (table, filter) in found {
            let size: f64 = client.query_one("SELECT reltuples::float8 FROM pg_class WHERE relname = $1 AND relkind = 'r' ORDER BY reltuples DESC LIMIT 1", &[&table]).map(|r| r.get(0)).unwrap_or(0.0);
            if size < min_rows {
                continue;
            }
            let columns: Vec<String> = client
                .query("SELECT column_name::text FROM information_schema.columns WHERE table_name = $1", &[&table])
                .map(|rows| rows.iter().map(|r| r.get::<_, String>(0)).collect())
                .unwrap_or_default();
            let used: Vec<String> = columns.into_iter().filter(|c| filter.contains(&format!("({c} ")) || filter.contains(&format!(" {c} ")) || filter.contains(&format!("({c})"))).collect();
            let fix = if used.is_empty() { "add an index on the columns it filters by".to_string() } else { format!("CREATE INDEX CONCURRENTLY ON {table} ({})", used.join(", ")) };
            out.push((table, filter, size, fix));
        }
        Some(out)
    }

    pub fn plans(url: &str, stmts: &[&Stmt], min_rows: f64) -> Result<(Vec<Finding>, usize), String> {
        let mut client = connect(url)?;
        let mut out = Vec::new();
        let mut planned = 0;
        for s in stmts {
            let Some(found) = advice(&mut client, &s.statement.to_string(), min_rows) else { continue };
            planned += 1;
            for (table, filter, size, fix) in found {
                out.push(Finding {
                    file: s.file.clone(),
                    line: s.line,
                    target: format!("{}:seq-scan:{}", s.file, bare(&table)),
                    message: format!("{}:{} the planner reads all ~{} rows of {table} for this query (Seq Scan, Filter: {filter}): {fix}", s.file, s.line, size as u64),
                });
            }
        }
        Ok((out, planned))
    }

    /// pg_stat_statements for this database: a snapshot, or with `before` the queries sent since, slowest first,
    /// each with the planner's advice.
    pub fn stats(url: &str, before: Option<&serde_json::Value>, min_rows: f64) -> Result<serde_json::Value, String> {
        let mut client = connect(url)?;
        let column = if client.query_one("SELECT 1 FROM information_schema.columns WHERE table_name = 'pg_stat_statements' AND column_name = 'total_exec_time'", &[]).is_ok() { "total_exec_time" } else { "total_time" };
        let rows = client
            .query(&format!("SELECT queryid::text, query, calls::float8, {column}::float8 FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())"), &[])
            .map_err(|e| format!("pg_stat_statements is not readable ({e}): CREATE EXTENSION pg_stat_statements, with shared_preload_libraries = 'pg_stat_statements'"))?;
        let now: serde_json::Map<String, serde_json::Value> = rows.iter().map(|r| (r.get::<_, String>(0), serde_json::json!({ "query": r.get::<_, String>(1), "calls": r.get::<_, f64>(2), "ms": r.get::<_, f64>(3) }))).collect();
        let Some(before) = before else { return Ok(serde_json::json!({ "snapshot": now })) };
        let mut since: Vec<(f64, f64, String)> = now
            .iter()
            .filter_map(|(id, v)| {
                let calls = v["calls"].as_f64()? - before["snapshot"][id]["calls"].as_f64().unwrap_or(0.0);
                let ms = v["ms"].as_f64()? - before["snapshot"][id]["ms"].as_f64().unwrap_or(0.0);
                let query = v["query"].as_str()?.to_string();
                (calls > 0.0 && !query.contains("pg_stat_statements")).then_some((ms, calls, query))
            })
            .collect();
        since.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        since.truncate(10);
        let lines: Vec<serde_json::Value> = since
            .into_iter()
            .map(|(ms, calls, query)| {
                let read = query.trim_start().to_uppercase();
                let advice = if read.starts_with("SELECT") || read.starts_with("UPDATE") || read.starts_with("DELETE") || read.starts_with("WITH") {
                    advice(&mut client, &query, min_rows).and_then(|found| found.into_iter().next()).map(|(table, _, size, fix)| format!("Seq Scan on {table} (~{} rows): {fix}", size as u64))
                } else {
                    None
                };
                serde_json::json!({ "query": query, "calls": calls, "totalMs": (ms * 10.0).round() / 10.0, "advice": advice })
            })
            .collect();
        Ok(serde_json::json!({ "since": lines }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(files: &[(&str, &str)]) -> Vec<String> {
        check_change(files, false)
    }

    /// With `as_change`, every line of every file counts as added by the change; without, the whole repository is judged.
    fn check_change(files: &[(&str, &str)], as_change: bool) -> Vec<String> {
        run_files(files, as_change).into_iter().map(|f| f.target).collect()
    }

    /// The findings, sorted by target.
    fn run_files(files: &[(&str, &str)], as_change: bool) -> Vec<Finding> {
        let root = text::temp_tree(&format!("sql-{}-{}", files.len(), files[0].1.len()), files);
        let request = Request {
            command: "sql".into(),
            root,
            files: files.iter().map(|(p, _)| p.to_string()).collect(),
            added: as_change.then(|| files.iter().map(|(p, text)| (p.to_string(), (1..=text.lines().count() as u32).collect())).collect()),
            prefix: String::new(),
            database_url: None,
            options: serde_json::Value::Null,
        };
        let mut out = run(&request).unwrap().findings;
        out.sort_by(|a, b| a.target.cmp(&b.target));
        out
    }

    #[test]
    fn mysql_migrations_get_no_postgres_lock_advice_but_still_break_running_code() {
        let files = [
            ("db/migrations/001.sql", "CREATE TABLE `users` (`id` int unsigned NOT NULL AUTO_INCREMENT, `email` varchar(255), PRIMARY KEY (`id`)) ENGINE=InnoDB;\nCREATE TABLE `orders` (`id` int NOT NULL, `user_id` int unsigned, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)) ENGINE=InnoDB;"),
            ("db/migrations/002.sql", "ALTER TABLE `users` ADD COLUMN `plan` varchar(20) NOT NULL;\nCREATE INDEX `users_email` ON `users` (`email`);\nALTER TABLE `users` DROP COLUMN `legacy`;"),
        ];
        assert_eq!(check_change(&files, true), vec!["db/migrations/002.sql:drop-column:users"]);
        // The same migration in a Prisma project that declares MySQL, written without MySQL's own syntax.
        let prisma = [
            ("prisma/schema.prisma", "datasource db {\n  provider = \"mysql\"\n  url = env(\"DATABASE_URL\")\n}\n"),
            ("prisma/migrations/2_plan/migration.sql", "ALTER TABLE users ADD COLUMN plan text NOT NULL;\nCREATE INDEX users_plan ON users (plan);"),
        ];
        assert_eq!(check_change(&prisma, true), Vec::<String>::new());
    }

    #[test]
    fn splits_around_quotes_and_dollar_quotes() {
        let parts = split("select ';'; do $$ begin perform 1; end $$; -- x;\nselect $1");
        assert_eq!(parts.len(), 3);
    }

    #[test]
    fn flags_data_deletion_in_migrations_and_code_and_unfiltered_supabase_writes() {
        let got = check_change(&[
            ("db/migrations/007_cleanup.sql", "DELETE FROM sessions;\nDELETE FROM events WHERE at < now() - interval '1 year';\nTRUNCATE audit_log;"),
            ("src/admin.ts", "export const reset = () => pool.query('TRUNCATE TABLE carts');\nexport const purge = () => supabase.from('carts').delete();\nexport const one = (id) => supabase.from('carts').delete().eq('id', id);\nexport const later = () => { const q = supabase.from('carts').delete(); return q; };\nexport const touch = () => supabase.from('carts').update({ seen: true });\nexport const truncate = (s) => s.slice(0, 10);\n"),
        ], true);
        assert_eq!(got, vec![
            "db/migrations/007_cleanup.sql:data-deletion:delete",
            "db/migrations/007_cleanup.sql:data-deletion:truncate",
            "src/admin.ts:truncate:truncate",
            "src/admin.ts:unfiltered-delete:carts",
            "src/admin.ts:unfiltered-update:carts",
        ]);
    }

    #[test]
    fn flags_database_resets_only_where_they_run_unattended() {
        let package = "{\n  \"scripts\": {\n    \"build\": \"prisma migrate reset --force && next build\",\n    \"db:reset\": \"prisma migrate reset\",\n    \"vercel-build\": \"npm run db:push\",\n    \"db:push\": \"prisma db push --accept-data-loss\",\n    \"dev:push\": \"drizzle-kit push --force\"\n  }\n}\n";
        let got = check_change(&[
            ("package.json", package),
            ("Dockerfile", "FROM node:22\nRUN npx prisma db push --accept-data-loss\n"),
            (".github/workflows/test.yml", "jobs:\n  test:\n    services:\n      postgres:\n        image: postgres\n    steps:\n      - run: npx prisma migrate reset --force\n"),
            ("scripts/reset-local.sh", "dropdb app\n"),
        ], true);
        assert_eq!(got, vec![
            "Dockerfile:destructive-command:prisma db push",
            "package.json:destructive-command:prisma db push",
            "package.json:destructive-command:prisma migrate reset",
        ]);
    }

    #[test]
    fn supabase_tables_need_row_level_security_and_policies_must_not_open_every_row() {
        let files = [
            ("supabase/migrations/001_init.sql", "create table public.notes (id uuid primary key, body text);\ncreate table public.teams (id uuid primary key);\n-- secured\nalter table public.teams enable row level security;\ncreate table private.jobs (id int);\ncreate policy \"anyone edits\" on public.teams for update to authenticated using (true);\ncreate policy \"read all\" on public.teams for select using (true);\ncreate policy \"own rows\" on public.teams for all to authenticated using (auth.uid() = id);\ncreate policy \"insert anything\" on public.teams for insert to anon with check (true);\n"),
            ("supabase/migrations/002_off.sql", "alter table public.teams disable row level security;\n"),
        ];
        assert_eq!(check_change(&files, true), vec![
            "supabase/migrations/001_init.sql:open-policy:teams:anyone edits",
            "supabase/migrations/001_init.sql:open-policy:teams:insert anything",
            "supabase/migrations/001_init.sql:rls:notes",
            "supabase/migrations/002_off.sql:rls-disabled:teams",
        ]);
    }

    #[test]
    fn flags_migration_hazards_and_missing_foreign_key_indexes() {
        let files = [
            ("db/001.sql", "CREATE TABLE users (id uuid PRIMARY KEY, email text);\nCREATE TABLE orders (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id));\nCREATE INDEX orders_id ON orders (id);"),
            ("db/002.sql", "ALTER TABLE users ADD COLUMN plan text NOT NULL;\nCREATE INDEX users_email ON users (email);\nALTER TABLE users DROP COLUMN legacy;\nALTER TABLE users ALTER COLUMN email SET NOT NULL;"),
        ];
        // Judging the whole repository, migrations already written are history: only the schema they leave is judged.
        assert_eq!(check(&files), vec!["db/001.sql:fk-index:orders.user_id"]);
        let got = check_change(&files, true);
        assert_eq!(got, vec![
            "db/001.sql:fk-index:orders.user_id",
            "db/002.sql:drop-column:users",
            "db/002.sql:index-locks:users",
            "db/002.sql:not-null-column:users.plan",
            "db/002.sql:set-not-null:users.email",
        ]);
    }

    #[test]
    fn concurrently_in_prisma_needs_a_migration_file_of_its_own() {
        let files = [
            ("prisma/migrations/0001_init/migration.sql", "CREATE TABLE users (id uuid PRIMARY KEY, email text, name text);"),
            ("prisma/migrations/0002_email/migration.sql", "CREATE INDEX users_email ON users (email);"),
            ("prisma/migrations/0003_name/migration.sql", "ALTER TABLE users ADD COLUMN plan text;\nCREATE INDEX CONCURRENTLY users_name ON users (name);"),
            ("prisma/migrations/0004_plan/migration.sql", "CREATE INDEX CONCURRENTLY users_plan ON users (plan);"),
        ];
        let answer = run_files(&files, true);
        let got: Vec<&str> = answer.iter().map(|f| f.target.as_str()).collect();
        assert_eq!(got, vec!["prisma/migrations/0002_email/migration.sql:index-locks:users", "prisma/migrations/0003_name/migration.sql:concurrently-in-transaction:users"]);
        assert!(answer[0].message.contains("only statement of a migration file of its own"), "{}", answer[0].message);
    }

    #[test]
    fn flags_slow_and_wrong_queries_in_code() {
        let got = check(&[
            ("db/001.sql", "CREATE TABLE users (id uuid PRIMARY KEY, email text);\nCREATE INDEX users_email ON users (email);"),
            ("src/q.ts", "export const a = (q) => pool.query(`SELECT * FROM users WHERE lower(email) = ${q} OFFSET ${q}`);\nexport const b = sql`DELETE FROM users`;\nexport const c = (q) => db.query(`SELECT id FROM users WHERE email LIKE '%' || ${q} OR id NOT IN (SELECT user_id FROM bans)`);\nexport async function d(ids) { for (const id of ids) await prisma.user.findUnique({ where: { id } }); }\n"),
        ]);
        assert_eq!(got, vec![
            "src/q.ts:delete-all:delete",
            "src/q.ts:function-on-column:users.email",
            "src/q.ts:leading-wildcard:like",
            "src/q.ts:n-plus-one:prisma.user.findUnique",
            "src/q.ts:not-in-subquery:not-in",
            "src/q.ts:offset:offset",
            "src/q.ts:select-star:select",
        ]);
    }

    #[test]
    fn flags_uuids_stored_as_text_and_keys_of_another_type() {
        let got = check(&[
            ("db/001.sql", "CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());\nCREATE TABLE teams (id text PRIMARY KEY DEFAULT gen_random_uuid()::text);\nCREATE TABLE posts (id bigserial PRIMARY KEY, author_id text REFERENCES users(id), team_id text REFERENCES teams);\nCREATE INDEX posts_author ON posts (author_id);\nCREATE INDEX posts_team ON posts (team_id);\nCREATE TABLE likes (post_id integer REFERENCES posts, user_id uuid REFERENCES users);\nCREATE INDEX likes_post ON likes (post_id, user_id);\nCREATE INDEX likes_user ON likes (user_id);"),
            ("prisma/schema.prisma", "datasource db {\n  provider = \"postgresql\"\n}\nmodel User {\n  id    String @id @default(uuid())\n  orgId String @db.Uuid\n}\nmodel Org {\n  id String @id @default(uuid()) @db.Uuid\n}\n"),
        ]);
        assert_eq!(got, vec![
            "db/001.sql:fk-type:likes.post_id",
            "db/001.sql:fk-type:posts.author_id",
            "db/001.sql:uuid-as-text:teams.id",
            "prisma/schema.prisma:uuid-as-text:User.id",
        ]);
    }
}
