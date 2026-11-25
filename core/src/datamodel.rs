//! Flaws in the data model the schemas declare, of the kind that get dearer with every row: a column that names
//! another table with no foreign key to hold it there, one fact kept in two columns, a list of ids in one column, one
//! name with two types, an index another index already covers. After Sharma, Fragkoulis, Rizou, Bruntink and
//! Spinellis ("Smelly relations: measuring and understanding database schema quality", ICSE-SEIP 2018), Dintyala,
//! Narechania and Arulraj ("SQLCheck: automated detection and diagnosis of SQL anti-patterns", SIGMOD 2020) and
//! PostgreSQL's own "Don't Do This" list. Each check reads only what the schema states, so each finding is a fact
//! about the schema; whether to act on it is the reader's call, and the message says what acting would be.
//!
//! The model is the one the `columns` gate reads: SQL migrations applied in order, Prisma models, Drizzle tables.
//! Foreign keys are the union of what SQL and Prisma declare, since a schema pulled from a database and migrations
//! written by hand each miss some of the other's.

use rayon::prelude::*;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use crate::columns::{self, Column, Table};
use crate::{sql, text, Answer, Finding, Request};

/// What a column holds, as far as two columns can be compared.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Family {
    Integer,
    Bigint,
    Uuid,
    Text,
    Boolean,
    /// A timestamp without a time zone.
    Timestamp,
    Timestamptz,
    Date,
    Json,
    Float,
    Numeric,
    Other,
}

impl Family {
    fn name(self) -> &'static str {
        match self {
            Family::Integer => "integer",
            Family::Bigint => "bigint",
            Family::Uuid => "uuid",
            Family::Text => "text",
            Family::Boolean => "boolean",
            Family::Timestamp => "timestamp",
            Family::Timestamptz => "timestamptz",
            Family::Date => "date",
            Family::Json => "json",
            Family::Float => "float",
            Family::Numeric => "numeric",
            Family::Other => "another type",
        }
    }

    /// Whether a column of this family can hold another's key: integer and bigint both hold a number.
    fn holds(self, key: Family) -> bool {
        self == key || matches!((self, key), (Family::Integer, Family::Bigint) | (Family::Bigint, Family::Integer))
    }
}

/// A declared type's family, and whether it is an array of it.
fn family(kind: &str) -> (Family, bool) {
    let array = kind.ends_with("[]") || kind.starts_with('_');
    let base = kind.trim_end_matches("[]").trim_start_matches('_');
    let base = base.split('(').next().unwrap_or("").trim();
    let family = match base {
        "int" | "integer" | "int4" | "serial" | "serial4" | "smallint" | "int2" | "smallserial" | "tinyint" | "mediumint" => {
            Family::Integer
        }
        "bigint" | "int8" | "bigserial" | "serial8" => Family::Bigint,
        "uuid" => Family::Uuid,
        "text" | "varchar" | "character varying" | "char" | "character" | "citext" | "string" | "bpchar" => Family::Text,
        "boolean" | "bool" => Family::Boolean,
        "timestamp" | "timestamp without time zone" | "datetime" => Family::Timestamp,
        "timestamptz" | "timestamp with time zone" => Family::Timestamptz,
        "date" => Family::Date,
        "json" | "jsonb" => Family::Json,
        "real" | "float" | "float4" | "float8" | "double precision" | "double" | "doubleprecision" => Family::Float,
        "numeric" | "decimal" | "money" => Family::Numeric,
        _ => Family::Other,
    };
    (family, array)
}

/// A name's words, lowercase: `visitAssignmentId` and `visit_assignment_id` are both visit, assignment, id.
fn name_words(name: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut word = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        let breaks = c == '_' || c == '-' || c == ' ' || (c.is_uppercase() && prev_lower);
        if breaks && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        if c.is_alphanumeric() {
            word.extend(c.to_lowercase());
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

// ponytail: a table that only records what happened is known by a word of its name. Such tables leave their links
// open on purpose (the record must outlive what it names); one named otherwise is asked to say so.
/// Words that name a table of records: an event log, an audit trail, a queue, a snapshot.
const RECORD_TABLES: &str = "log logs event events audit audits history snapshot snapshots outbox inbox queue archive backup import imports webhook metric metrics analytics impression impressions tracking";
/// Words that name an amount of money.
const MONEY: &str =
    "amount price total subtotal fee fees cost balance payout charge refund tax tip discount revenue earnings salary wage budget cents";
/// Schemas a platform owns: Supabase's auth and storage, Postgres' own.
const PLATFORM_SCHEMAS: &str = "auth storage realtime extensions graphql graphql_public vault pgsodium pgbouncer net cron supabase_functions supabase_migrations information_schema pg_catalog";

/// Participles that do not end in -ed.
const HAPPENED: &str = "read sent paid seen done sold won lost given taken shown hidden frozen built bought found spent gone";

fn among(list: &str, word: &str) -> bool {
    list.split(' ').any(|w| w == word)
}

/// The schemas' tables with what the checks ask of them.
struct Model {
    tables: BTreeMap<String, Table>,
    /// (table, column) held by a foreign key, in SQL or as a Prisma relation.
    linked: HashSet<(String, String)>,
    /// Each table's primary key, when it is one column: its name.
    primary: HashMap<String, String>,
    /// SQL's latest word on a column's type, which `ALTER COLUMN … TYPE` may have changed since the table was made.
    retyped: HashMap<(String, String), String>,
    /// A table's name without case or underscores -> the table: `visit_assignment` and a `VisitAssignment` model.
    by_stem: HashMap<String, String>,
}

impl Model {
    fn kind(&self, table: &Table, column: &Column) -> (Family, bool) {
        let declared = if table.source == 0 {
            self.retyped.get(&(table.name.clone(), column.name.clone())).unwrap_or(&column.kind)
        } else {
            &column.kind
        };
        family(declared)
    }

    /// The table a link-shaped name points at: `store_id`, `storeId` and `stores_id` are the `store` table's.
    fn target(&self, column: &str) -> Option<&Table> {
        let mut words = name_words(column);
        if words.len() < 2 || words.pop().as_deref() != Some("id") {
            return None;
        }
        let stem = words.concat();
        let table = self
            .by_stem
            .get(&stem)
            .or_else(|| self.by_stem.get(&format!("{stem}s")))
            .or_else(|| stem.strip_suffix('s').and_then(|s| self.by_stem.get(s)))?;
        self.tables.get(table)
    }

    /// The family of a table's key, when it is one column.
    fn key_family(&self, table: &Table) -> Option<Family> {
        let key = self.primary.get(&table.name)?;
        let column = table.columns.iter().find(|c| &c.name == key || &c.key == key)?;
        Some(self.kind(table, column).0)
    }
}

/// Tables the project's own schema declares: not a platform's schema, not a tool's bookkeeping.
fn judged(table: &Table) -> bool {
    !among(PLATFORM_SCHEMAS, &table.schema) && !table.name.starts_with('_') && !table.name.contains("migrations")
}

/// A schema kept as a record: under docs, an archive or a backup, or in a dated path.
static COPY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|/)(?:docs?|[\w-]*docs|archive[sd]?|backups?|snapshots?|baselines?|validation)/|(?:19|20)\d\d[-_]?[01]\d[-_]?[0-3]\d",
    )
    .unwrap()
});
/// A statement that makes or alters a table, up to its end: a guarded migration runs one inside `DO $$ … $$`, which
/// the parser does not read, so foreign keys are also looked for in the text.
static TABLE_STATEMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\b(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table(?:\s+only)?(?:\s+if\s+exists)?)\s+((?:"?\w+"?\.)?"?\w+"?)([^;]*)"#).unwrap()
});
static FOREIGN_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)\bforeign\s+key\s*\(([^)]*)\)\s*references\b").unwrap());
static INLINE_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?im)^\s*(?:add\s+column\s+(?:if\s+not\s+exists\s+)?)?"?(\w+)"?\s+[^,\n]*?\breferences\b"#).unwrap());

static CREATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bcreate\s+(?:(?:global|local)\s+)?(temp(?:orary)?\s+)?(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)"#).unwrap()
});

/// Tables every `CREATE` of which is `TEMP`: a migration's scratch space, gone when its session ends.
fn scratch_tables(sql_files: &[(String, String)]) -> HashSet<String> {
    let mut scratch = HashSet::new();
    let mut kept = HashSet::new();
    for created in sql_files.iter().flat_map(|(_, src)| CREATED.captures_iter(src)) {
        let set = if created.get(1).is_some() { &mut scratch } else { &mut kept };
        set.insert(sql::bare(&created[2]));
    }
    scratch.retain(|name| !kept.contains(name));
    scratch
}

/// The (table, column) pairs a SQL file's text gives a foreign key, wherever the statement sits.
fn text_links(src: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    for statement in TABLE_STATEMENT.captures_iter(src) {
        let table = sql::bare(&statement[1]);
        let body = &statement[2];
        for key in FOREIGN_KEY.captures_iter(body) {
            out.extend(key[1].split(',').map(|c| (table.clone(), sql::bare(c.trim()))));
        }
        out.extend(INLINE_REFERENCE.captures_iter(body).map(|c| (table.clone(), sql::bare(&c[1]))));
    }
    out
}

static ENUM_PRISMA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^enum\s+(\w+)\s*\{").unwrap());
static ENUM_SQL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bcreate\s+type\s+((?:"?\w+"?\.)?"?\w+"?)\s+as\s+enum\b"#).unwrap());
static ENUM_RENAMED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\balter\s+type\s+((?:"?\w+"?\.)?"?\w+"?)\s+rename\s+to\s+("?\w+"?)"#).unwrap());
static ENUM_DROPPED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\bdrop\s+type\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)"#).unwrap());

/// One flaw, where the schema declares it.
struct Flaw {
    file: String,
    line: u32,
    rule: &'static str,
    key: String,
    message: String,
}

fn flaw(file: &str, line: u32, rule: &'static str, key: String, message: String) -> Flaw {
    Flaw { file: file.to_string(), line, rule, key, message }
}

/// A column named for another table, of its key's type, that no foreign key holds there.
fn open_links(model: &Model, out: &mut Vec<Flaw>) {
    for table in model.tables.values().filter(|t| judged(t)) {
        if name_words(&table.name).iter().any(|w| among(RECORD_TABLES, w)) {
            continue;
        }
        for column in &table.columns {
            let Some(parent) = model.target(&column.name) else { continue };
            let held = model.linked.contains(&(table.name.clone(), column.name.clone()));
            let own_key = model.primary.get(&table.name).is_some_and(|k| k == &column.name || k == &column.key);
            // `owner_type` beside `owner_id`: the link is to one of several tables, which no foreign key can say.
            let mut kind_name = name_words(&column.name);
            kind_name.pop();
            kind_name.push("type".into());
            let polymorphic = table.columns.iter().any(|c| name_words(&c.name) == kind_name);
            let (family, array) = model.kind(table, column);
            if held || own_key || polymorphic || array || !judged(parent) || !model.key_family(parent).is_some_and(|key| family.holds(key))
            {
                continue;
            }
            out.push(flaw(
                &column.file,
                column.line,
                "open-link",
                format!("{}.{}", table.name, column.name),
                format!(
                    "{}.{} names the {} table and has its key's type, but no foreign key holds it there: it can name a row that is gone. Add the foreign key, or acknowledge why the link is left open",
                    table.name, column.name, parent.name
                ),
            ));
        }
    }
}

/// A flag and the time it was set: one fact in two columns, which can disagree.
// ponytail: an event is known by the shape of its word (-ed, or one of a few participles that end otherwise).
/// Whether a flag's words name something that happened (`reviewed`, `opted_out`, `read`) and not a state (`active`).
/// Only then is a time of the same name the time it happened, and not when it is due or was last so.
fn happened(words: &[String]) -> bool {
    words.iter().any(|w| (w.len() > 3 && w.ends_with("ed")) || among(HAPPENED, w))
}

fn twice_told(model: &Model, out: &mut Vec<Flaw>) {
    for table in model.tables.values().filter(|t| judged(t)) {
        for flag in table.columns.iter().filter(|c| model.kind(table, c).0 == Family::Boolean) {
            let mut stem = name_words(&flag.name);
            if stem.len() > 1 && matches!(stem[0].as_str(), "is" | "has" | "was" | "did") {
                stem.remove(0);
            }
            if !happened(&stem) {
                continue;
            }
            let time = table.columns.iter().find(|c| {
                let mut words = name_words(&c.name);
                let moment = matches!(model.kind(table, c).0, Family::Timestamp | Family::Timestamptz | Family::Date);
                moment && matches!(words.pop().as_deref(), Some("at" | "on" | "date" | "time")) && words == stem
            });
            if let Some(time) = time {
                out.push(flaw(
                    &flag.file,
                    flag.line,
                    "twice-told",
                    format!("{}.{}", table.name, flag.name),
                    format!(
                        "{}.{} and {}.{} record one fact twice, a flag and the time it happened: nothing stops them disagreeing. Keep the time and read the flag from it (`{} IS NOT NULL`)",
                        table.name, flag.name, table.name, time.name, time.name
                    ),
                ));
            }
        }
    }
}

/// A list of ids in one column, as an array or as JSON.
fn id_lists(model: &Model, out: &mut Vec<Flaw>) {
    for table in model.tables.values().filter(|t| judged(t)) {
        for column in &table.columns {
            let (family, array) = model.kind(table, column);
            if name_words(&column.name).last().map(String::as_str) == Some("ids") && (array || family == Family::Json) {
                out.push(flaw(
                    &column.file,
                    column.line,
                    "id-list",
                    format!("{}.{}", table.name, column.name),
                    format!(
                        "{}.{} keeps a list of ids in one column: no foreign key can check them, and a join on them uses no index. A table of its own, one row per id, holds the same link",
                        table.name, column.name
                    ),
                ));
            }
        }
    }
}

/// One name with two types across tables, for names that link tables or hold money.
fn two_types(model: &Model, out: &mut Vec<Flaw>) {
    let mut by_name: BTreeMap<String, Vec<(&Table, &Column, Family)>> = BTreeMap::new();
    for table in model.tables.values().filter(|t| judged(t)) {
        for column in &table.columns {
            let (family, array) = model.kind(table, column);
            let words = name_words(&column.name);
            let money = words.iter().any(|w| among(MONEY, w));
            if !array && family != Family::Other && (model.target(&column.name).is_some() || money) {
                by_name.entry(words.join("_")).or_default().push((table, column, family));
            }
        }
    }
    for uses in by_name.values() {
        let mut count: BTreeMap<Family, usize> = BTreeMap::new();
        for (_, _, family) in uses {
            *count.entry(*family).or_default() += 1;
        }
        let Some((&most, &n)) = count.iter().max_by_key(|(_, n)| **n) else { continue };
        // The type most tables give it is the name's; one as common as another has no odd one out.
        if count.len() < 2 || n < 2 || count.values().filter(|c| **c == n).count() > 1 {
            continue;
        }
        let others: Vec<&str> = uses.iter().filter(|(_, _, f)| *f == most).take(2).map(|(t, _, _)| t.name.as_str()).collect();
        for (table, column, family) in uses.iter().filter(|(_, _, f)| *f != most) {
            out.push(flaw(
                &column.file,
                column.line,
                "two-types",
                format!("{}.{}", table.name, column.name),
                format!(
                    "{}.{} is {}, and {} is {} in {} other tables ({}): the two cannot be joined or compared without a cast, and the smaller runs out first. Give it the type the others have",
                    table.name,
                    column.name,
                    family.name(),
                    column.name,
                    most.name(),
                    n,
                    others.join(", ")
                ),
            ));
        }
    }
}

/// An index whose columns start another index on the same table, which answers the same lookups.
// ponytail: the indexes are a Prisma model's. SQL's `CREATE INDEX` and Drizzle's `index()` are not read: a
// migration history would need every `DROP INDEX` applied in order before an index could be called covered.
fn covered_indexes(model: &Model, out: &mut Vec<Flaw>) {
    for table in model.tables.values().filter(|t| judged(t)) {
        for (i, index) in table.indexes.iter().enumerate() {
            if index.unique || !index.plain || index.fields.is_empty() {
                continue;
            }
            let covering = table.indexes.iter().enumerate().find(|(j, other)| {
                let same = other.fields == index.fields;
                *j != i && other.plain && other.fields.starts_with(&index.fields) && (!same || other.unique || *j < i)
            });
            let Some((_, by)) = covering else { continue };
            let what = match (by.fields == index.fields, by.primary, by.unique) {
                (true, true, _) => "repeats the primary key".to_string(),
                (true, _, true) => "repeats a unique index on the same columns".to_string(),
                (true, _, _) => "is declared twice".to_string(),
                (false, _, _) => format!("is the start of the index on ({}), which answers the same lookups", by.fields.join(", ")),
            };
            out.push(flaw(
                &table.file,
                index.line,
                "covered-index",
                format!("{}({})", table.name, index.fields.join(",")),
                format!("the index on {}({}) {what}: every write pays for both. Drop it", table.name, index.fields.join(", ")),
            ));
        }
    }
}

/// A timestamp without a time zone in a schema whose timestamps have one, and money in a floating-point number.
fn wrong_types(model: &Model, postgres: bool, out: &mut Vec<Flaw>) {
    let columns: Vec<(&Table, &Column, Family)> = model
        .tables
        .values()
        .filter(|t| judged(t))
        .flat_map(|t| t.columns.iter().map(move |c| (t, c)))
        .map(|(t, c)| (t, c, model.kind(t, c).0))
        .collect();
    let zoned = columns.iter().filter(|(_, _, f)| *f == Family::Timestamptz).count();
    let bare = columns.iter().filter(|(_, _, f)| *f == Family::Timestamp).count();
    for (table, column, family) in &columns {
        let key = format!("{}.{}", table.name, column.name);
        // The schema's own habit decides: where most timestamps carry a zone, one without is the slip.
        if postgres && *family == Family::Timestamp && zoned >= 4 * bare {
            out.push(flaw(
                &column.file,
                column.line,
                "bare-timestamp",
                key,
                format!(
                    "{}.{} is a timestamp without a time zone, and {zoned} of the schema's {} timestamps have one: it is read as a different moment in each session's zone. Use timestamptz",
                    table.name,
                    column.name,
                    zoned + bare
                ),
            ));
        } else if *family == Family::Float && name_words(&column.name).iter().any(|w| among(MONEY, w)) {
            out.push(flaw(
                &column.file,
                column.line,
                "float-money",
                key,
                format!("{}.{} keeps money in a floating-point number: sums drift by fractions of a cent. Use numeric, or whole cents in an integer", table.name, column.name),
            ));
        }
    }
}

/// Two tables with the same columns: one table with a column that tells the rows apart, unless they are to differ.
fn same_columns(model: &Model, out: &mut Vec<Flaw>) {
    let mut by_columns: BTreeMap<BTreeSet<&str>, Vec<&Table>> = BTreeMap::new();
    for table in model.tables.values().filter(|t| judged(t) && t.columns.len() >= 6) {
        by_columns.entry(table.columns.iter().map(|c| c.name.as_str()).collect()).or_default().push(table);
    }
    for tables in by_columns.values().filter(|t| t.len() > 1) {
        let first = tables[0];
        for table in &tables[1..] {
            out.push(flaw(
                &table.file,
                table.line,
                "same-columns",
                table.name.clone(),
                format!(
                    "{} has the same {} columns as {}: one table with a column that tells the rows apart holds both, unless the two are meant to grow apart",
                    table.name,
                    table.columns.len(),
                    first.name
                ),
            ));
        }
    }
}

/// An enum type no column has.
fn idle_enums(model: &Model, sources: &[(String, String)], out: &mut Vec<Flaw>) {
    let used: HashSet<String> = model
        .tables
        .values()
        .flat_map(|t| {
            t.columns.iter().map(move |c| {
                if t.source == 0 {
                    model.retyped.get(&(t.name.clone(), c.name.clone())).unwrap_or(&c.kind)
                } else {
                    &c.kind
                }
            })
        })
        .map(|k| name_words(&sql::bare(k.trim_end_matches("[]").trim_start_matches("enum "))).concat())
        .collect();
    // Where Prisma declares the schema, its enums are the ones that exist: SQL's history also names those since
    // renamed or mapped to another name. Without Prisma, SQL's own, less the dropped and with the renamed.
    let prisma = sources.iter().any(|(file, _)| file.ends_with(".prisma"));
    let mut declared: BTreeMap<String, (String, u32)> = BTreeMap::new();
    for (file, src) in sources.iter().filter(|(file, _)| file.ends_with(".prisma") == prisma) {
        let lines = text::Lines::new(src);
        let declares: &Regex = if prisma { &ENUM_PRISMA } else { &ENUM_SQL };
        for cap in declares.captures_iter(src) {
            let at = (file.clone(), lines.line(cap.get(0).unwrap().start()));
            // The schema read last is the one in use, as for tables; in SQL, the statement that first made the type.
            if prisma {
                declared.insert(sql::bare(&cap[1]), at);
            } else {
                declared.entry(sql::bare(&cap[1])).or_insert(at);
            }
        }
        for cap in ENUM_DROPPED.captures_iter(src).filter(|_| !prisma) {
            declared.remove(&sql::bare(&cap[1]));
        }
        for cap in ENUM_RENAMED.captures_iter(src).filter(|_| !prisma) {
            if let Some(at) = declared.remove(&sql::bare(&cap[1])) {
                declared.insert(sql::bare(&cap[2]), at);
            }
        }
    }
    // Prisma names a mapped enum in its own case (`PetGender` for `pet_gender`): compared without case or underscores.
    for (name, (file, line)) in declared.iter().filter(|(name, _)| !used.contains(&name_words(name).concat())) {
        out.push(flaw(file, *line, "idle-enum", name.clone(), format!("the enum {name} is the type of no column: use it, or drop it")));
    }
}

/// What a file brings to the model.
enum Read {
    Sql(String, String),
    Prisma(String, String, Vec<Table>),
    Drizzle(Vec<Table>),
}

/// What one file declares: SQL, a Prisma schema, or code that makes Drizzle tables. None for any other file.
fn read_schema(root: &str, file: &str) -> Option<Read> {
    let src = text::read(root, file)?;
    match file.rsplit('.').next() {
        Some("sql") => Some(Read::Sql(file.to_string(), src)),
        Some("prisma") => {
            let tables = columns::prisma_model(file, &src);
            Some(Read::Prisma(file.to_string(), src, tables))
        }
        _ => (src.contains("drizzle-orm") && columns::defines_tables(&src)).then(|| Read::Drizzle(columns::drizzle_model(file, &src))),
    }
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let mut reads: Vec<Read> = request.files.par_iter().filter_map(|file| read_schema(&request.root, file)).collect();
    let mut sql_files: Vec<(String, String)> = vec![];
    let mut prisma_files: Vec<(String, String)> = vec![];
    let mut ormed: Vec<Table> = vec![];
    // Where two schemas declare one table, the last read wins: the project's own after another package's, and a
    // schema in use after a copy kept beside docs or dated (`docs/release-2026-09-18/schema-baseline.prisma`).
    reads.sort_by_key(|read| match read {
        Read::Prisma(file, _, _) => (file.starts_with(&request.prefix), !COPY.is_match(file), file.clone()),
        _ => (false, false, String::new()),
    });
    for read in reads {
        match read {
            Read::Sql(file, src) => sql_files.push((file, src)),
            Read::Prisma(file, src, tables) => {
                prisma_files.push((file, src));
                ormed.extend(tables);
            }
            Read::Drizzle(tables) => ormed.extend(tables),
        }
    }
    let (mut tables, _) = columns::declared(&mut sql_files, ormed);
    let scratch = scratch_tables(&sql_files);
    tables.retain(|name, table| table.source != 0 || !scratch.contains(name));
    if tables.is_empty() {
        return Ok(Answer::new(vec![], "no database schema found".into()));
    }
    let statements: Vec<sql::Stmt> = sql_files.par_iter().flat_map_iter(|(file, src)| sql::statements(file, 1, src, false)).collect();
    let (inventory, foreign_keys) = sql::inventory(&statements);
    let mut linked: HashSet<(String, String)> =
        foreign_keys.iter().flat_map(|fk| fk.columns.iter().map(|c| (fk.table.clone(), c.clone()))).collect();
    linked.extend(sql_files.iter().flat_map(|(_, src)| text_links(src)));
    // ponytail: a Drizzle table's `.primaryKey()` and `.references()` are not read. Its keys and foreign keys are
    // the SQL migrations'; with none in the repository no key is known, and its links are not judged.
    let mut primary = inventory.primary.clone();
    for table in tables.values() {
        for (_, _, fields) in &table.relations {
            // A relation names fields as code does; the database's name for each is what a foreign key holds.
            linked.extend(
                fields.iter().filter_map(|f| table.columns.iter().find(|c| &c.key == f)).map(|c| (table.name.clone(), c.name.clone())),
            );
        }
        if let Some(key) = table.indexes.iter().find(|i| i.primary && i.fields.len() == 1) {
            primary.insert(table.name.clone(), key.fields[0].clone());
        }
    }
    let by_stem = tables
        .values()
        .flat_map(|t| [(name_words(&t.name).concat(), t.name.clone()), (t.model.to_lowercase(), t.name.clone())])
        .filter(|(stem, _)| !stem.is_empty())
        .collect();
    let model = Model { tables: tables.into_iter().collect(), linked, primary, retyped: inventory.types, by_stem };

    let mut flaws = vec![];
    open_links(&model, &mut flaws);
    twice_told(&model, &mut flaws);
    id_lists(&model, &mut flaws);
    two_types(&model, &mut flaws);
    covered_indexes(&model, &mut flaws);
    wrong_types(&model, !sql::mysql_project(&request.root, &request.files), &mut flaws);
    same_columns(&model, &mut flaws);
    sql_files.extend(prisma_files);
    idle_enums(&model, &sql_files, &mut flaws);

    let mut findings: Vec<Finding> = flaws
        .into_iter()
        .filter(|f| request.changed(&f.file, f.line))
        .map(|f| Finding {
            target: format!("data-model:{}:{}", f.rule, f.key),
            message: format!("{}:{} {}", f.file, f.line, f.message),
            file: f.file,
            line: f.line,
        })
        .collect();
    findings.sort_by(|a, b| (&a.file, a.line, &a.target).cmp(&(&b.file, b.line, &b.target)));
    findings.dedup_by(|a, b| a.target == b.target);
    let summary = format!("{} tables read, {} flaws in the data model", model.tables.len(), findings.len());
    Ok(Answer::new(findings, summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The targets found. With `added`, only those (file, lines) are the change's; without, the whole repository.
    fn targets(name: &str, files: &[(&str, &str)], added: Option<&[(&str, &[u32])]>) -> Vec<String> {
        let request = Request {
            command: "data-model".into(),
            root: text::temp_tree(&format!("data-model-{name}"), files),
            files: files.iter().map(|(p, _)| p.to_string()).collect(),
            added: added.map(|a| a.iter().map(|(f, l)| (f.to_string(), l.iter().copied().collect())).collect()),
            prefix: String::new(),
            database_url: None,
            options: serde_json::json!({}),
        };
        run(&request).unwrap().findings.into_iter().map(|f| f.target).collect()
    }

    const SHOP: &str = "create table customers (id uuid primary key, name text not null);\ncreate table stores (id uuid primary key, name text not null);\n";

    #[test]
    fn a_column_named_for_a_table_with_its_keys_type_and_no_foreign_key_is_an_open_link() {
        let orders = "create table orders (\n  id uuid primary key,\n  customer_id uuid not null,\n  store_id uuid not null references stores (id),\n  account_id text,\n  owner_id uuid,\n  owner_type text\n);\ncreate table accounts (id uuid primary key);\ncreate table owners (id uuid primary key);\n";
        let got = targets("open-link", &[("migrations/001.sql", SHOP), ("migrations/002.sql", orders)], None);
        // `store_id` is held; `account_id` is not the key's type (an outside id); `owner_id` is one of several tables'.
        assert_eq!(got, vec!["data-model:open-link:orders.customer_id"]);
    }

    #[test]
    fn a_foreign_key_added_in_a_guarded_block_or_a_prisma_relation_holds_the_link_and_records_are_left_open() {
        let guarded = "create table orders (id uuid primary key, customer_id uuid not null);\nDO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_customer') THEN\n    ALTER TABLE orders\n      ADD CONSTRAINT fk_orders_customer\n      FOREIGN KEY (customer_id) REFERENCES customers (id);\n  END IF;\nEND $$;\ncreate table order_events (id uuid primary key, customer_id uuid not null);\n";
        assert_eq!(targets("guarded", &[("migrations/001.sql", SHOP), ("migrations/002.sql", guarded)], None), Vec::<String>::new());
        let prisma = "model Customer {\n  id     String  @id @db.Uuid\n  orders Order[]\n  @@map(\"customers\")\n}\nmodel Order {\n  id         String   @id @db.Uuid\n  customerId String   @map(\"customer_id\") @db.Uuid\n  storeId    String   @map(\"store_id\") @db.Uuid\n  customer   Customer @relation(fields: [customerId], references: [id])\n  @@map(\"orders\")\n}\nmodel Store {\n  id String @id @db.Uuid\n  @@map(\"stores\")\n}\n";
        assert_eq!(targets("relation", &[("prisma/schema.prisma", prisma)], None), vec!["data-model:open-link:orders.store_id"]);
    }

    #[test]
    fn one_fact_in_two_columns_a_list_of_ids_and_an_index_another_covers_are_reported() {
        let prisma = "model Post {\n  id          String    @id @db.Uuid\n  authorId    String    @db.Uuid\n  slug        String\n  isPublished Boolean   @default(false)\n  publishedAt DateTime? @db.Timestamptz(6)\n  archived    Boolean   @default(false)\n  tagIds      String[]  @db.Uuid\n  viewerIds   Json?\n\n  @@unique([authorId, slug])\n  @@index([authorId])\n  @@index([id])\n  @@index([slug])\n  @@index([slug, authorId(sort: Desc)])\n}\n";
        assert_eq!(
            targets("post", &[("prisma/schema.prisma", prisma)], None),
            vec![
                "data-model:twice-told:post.isPublished",
                "data-model:id-list:post.tagIds",
                "data-model:id-list:post.viewerIds",
                "data-model:covered-index:post(authorId)",
                "data-model:covered-index:post(id)",
            ]
        );
    }

    #[test]
    fn a_migrations_temporary_table_is_not_the_schema_and_a_state_beside_a_date_is_not_one_fact_twice() {
        let scratch = "create temp table customer_restore (id uuid primary key, customer_id uuid not null);\ncreate table challenges (id uuid primary key, is_active boolean not null, active_date date, is_sent boolean, sent_at timestamptz);\n";
        assert_eq!(
            targets("scratch", &[("migrations/001.sql", SHOP), ("migrations/002.sql", scratch)], None),
            vec!["data-model:twice-told:challenges.is_sent"]
        );
    }

    #[test]
    fn a_name_keeps_one_type_across_tables() {
        let sql = "create table users (id uuid primary key);\ncreate table posts (id uuid primary key, user_id uuid references users (id), amount_cents bigint);\ncreate table likes (id uuid primary key, user_id uuid references users (id), amount_cents bigint);\ncreate table notes (id uuid primary key, user_id text, amount_cents integer, title text);\n";
        assert_eq!(
            targets("two-types", &[("migrations/001.sql", sql)], None),
            vec!["data-model:two-types:notes.amount_cents", "data-model:two-types:notes.user_id"]
        );
    }

    #[test]
    fn a_timestamp_without_a_zone_is_the_slip_only_where_the_schema_keeps_zones_and_money_is_not_a_float() {
        let zoned = "create table jobs (\n  id uuid primary key,\n  created_at timestamptz,\n  updated_at timestamptz,\n  started_at timestamptz,\n  ended_at timestamp with time zone,\n  seen_at timestamp,\n  price double precision,\n  weight double precision\n);\n";
        assert_eq!(
            targets("zoned", &[("migrations/001.sql", zoned)], None),
            vec!["data-model:bare-timestamp:jobs.seen_at", "data-model:float-money:jobs.price"]
        );
        let bare = "create table jobs (id uuid primary key, created_at timestamp, updated_at timestamp);\n";
        assert_eq!(targets("bare", &[("migrations/001.sql", bare)], None), Vec::<String>::new());
    }

    #[test]
    fn two_tables_with_the_same_columns_and_an_enum_no_column_has_are_reported() {
        let prisma = "enum Mood {\n  happy\n  sad\n}\nenum Unused {\n  a\n}\nmodel Tool {\n  id String @id\n  name String\n  make String\n  model String\n  year Int\n  mood Mood\n}\nmodel Vehicle {\n  id String @id\n  name String\n  make String\n  model String\n  year Int\n  mood Mood\n}\n";
        assert_eq!(
            targets("same", &[("prisma/schema.prisma", prisma)], None),
            vec!["data-model:idle-enum:unused", "data-model:same-columns:vehicle"]
        );
        let sql = "create type mood as enum ('happy', 'sad');\ncreate type old_mood as enum ('a');\ncreate type spare as enum ('b');\nalter type old_mood rename to renamed_mood;\ndrop type spare;\ncreate table pets (id uuid primary key, mood mood);\n";
        assert_eq!(targets("enum-sql", &[("migrations/001.sql", sql)], None), vec!["data-model:idle-enum:renamed_mood"]);
    }

    #[test]
    fn a_change_is_judged_on_what_it_adds_and_a_platforms_schema_is_not_judged() {
        let later = "alter table orders add column store_id uuid;\n";
        let first = "create table orders (id uuid primary key, customer_id uuid not null);\n";
        let files = [("migrations/001.sql", SHOP), ("migrations/002.sql", first), ("migrations/003.sql", later)];
        assert_eq!(targets("change", &files, Some(&[("migrations/003.sql", &[1])])), vec!["data-model:open-link:orders.store_id"]);
        let auth = "model users {\n  id String @id @db.Uuid\n  @@schema(\"auth\")\n}\nmodel sessions {\n  id String @id @db.Uuid\n  user_id String @db.Uuid\n  revoked Boolean\n  revoked_at DateTime?\n  @@schema(\"auth\")\n}\n";
        assert_eq!(targets("platform", &[("prisma/schema.prisma", auth)], None), Vec::<String>::new());
    }
}
