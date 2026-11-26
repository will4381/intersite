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
use crate::constraints::{self, Allowed, Checks};
use crate::statistics::{self, Stats};
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
/// Words that name a copy of a table set aside: a backup before a migration, last year's rows.
const ASIDE: &str = "backup backups bak old tmp temp copy";
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
    /// (table, column) -> the closed set of values an enum or a CHECK gives it.
    allowed: HashMap<(String, String), Allowed>,
    checks: Checks,
    /// Each Prisma file's lines, for the comment above a field.
    prisma: HashMap<String, Vec<String>>,
    /// The planner's statistics, when a database was given.
    stats: Option<Stats>,
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

/// Rules that suggest and do not fail: a matter of design, a tidying, or a reading of the data, where the owner knows
/// what the schema cannot say. The rest are slips with one fix, cheapest in the change that makes them.
const SUGGESTED: &str = "twice-told id-list same-columns idle-enum loose-json never-filled one-value few-values";

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

/// The share of a table's rows a column's statistics give `value`, when the table is big enough to say.
fn share(model: &Model, table: &Table, column: &Column, value: &str) -> Option<f64> {
    let seen = model.stats.as_ref()?.get(&(table.name.clone(), column.name.clone())).filter(|s| s.rows >= BIG)?;
    Some(seen.common.iter().find(|(v, _)| v == value).map_or(0.0, |(_, share)| *share))
}

/// What the data says of two columns that should agree: nothing while they do, or while no statistics are at hand.
fn disagreement(flag: Option<f64>, other: Option<f64>, what: &str) -> String {
    match (flag, other) {
        (Some(flag), Some(other)) if (flag - other).abs() >= 0.02 => {
            format!(
                ". In the data they already disagree: the flag is true in about {:.0}% of the rows and {what} in about {:.0}%",
                flag * 100.0,
                other * 100.0
            )
        }
        _ => String::new(),
    }
}

fn twice_told(model: &Model, out: &mut Vec<Flaw>) {
    for table in model.tables.values().filter(|t| judged(t)) {
        for flag in table.columns.iter().filter(|c| model.kind(table, c).0 == Family::Boolean) {
            let mut stem = name_words(&flag.name);
            if stem.len() > 1 && matches!(stem[0].as_str(), "is" | "has" | "was" | "did") {
                stem.remove(0);
            }
            let is_true = share(model, table, flag, "t");
            let time = table.columns.iter().filter(|_| happened(&stem)).find(|c| {
                let mut words = name_words(&c.name);
                let moment = matches!(model.kind(table, c).0, Family::Timestamp | Family::Timestamptz | Family::Date);
                moment && matches!(words.pop().as_deref(), Some("at" | "on" | "date" | "time")) && words == stem
            });
            // `active` beside a status that can be 'active': the status already says it.
            let state = table.columns.iter().find_map(|c| {
                let values = &model.allowed.get(&(table.name.clone(), c.name.clone()))?.stored;
                Some((c, values.iter().find(|v| name_words(v).concat() == stem.concat())?))
            });
            let key = format!("{}.{}", table.name, flag.name);
            if let Some(time) = time {
                let set = model
                    .stats
                    .as_ref()
                    .and_then(|s| s.get(&(table.name.clone(), time.name.clone())))
                    .filter(|s| s.rows >= BIG)
                    .map(|s| 1.0 - s.nulls);
                let message = format!(
                    "{}.{} and {}.{} record one fact twice, a flag and the time it happened: nothing stops them disagreeing. Keep the time and read the flag from it (`{} IS NOT NULL`){}",
                    table.name,
                    flag.name,
                    table.name,
                    time.name,
                    time.name,
                    disagreement(is_true, set, "the time is set")
                );
                out.push(flaw(&flag.file, flag.line, "twice-told", key, message));
            } else if let Some((state, value)) = state {
                let message = format!(
                    "{}.{} and {}.{} = '{value}' record one fact twice, a flag and a value of the status: nothing stops them disagreeing. Keep the status and read the flag from it{}",
                    table.name,
                    flag.name,
                    table.name,
                    state.name,
                    disagreement(is_true, share(model, table, state, value), &format!("the status is '{value}'"))
                );
                out.push(flaw(&flag.file, flag.line, "twice-told", key, message));
            }
        }
    }
}

/// A table no statement gives a primary key.
fn no_key(model: &Model, out: &mut Vec<Flaw>) {
    for table in model.tables.values().filter(|t| judged(t)) {
        // ponytail: a Drizzle table's `.primaryKey()` is not read, so a Drizzle table is taken to have one.
        let keyed = table.source == 1 || table.indexes.iter().any(|i| i.primary) || model.checks.keyed.contains(&table.name);
        // A copy set aside by a migration (`orders_backup_20260728`) is not a table of the model.
        let aside = name_words(&table.name).iter().any(|w| among(ASIDE, w));
        if !keyed && !aside {
            let message = format!(
                "{} has no primary key: two rows can be alike in every column, and nothing can point at one of them. Give it a key",
                table.name
            );
            out.push(flaw(&table.file, table.line, "no-key", table.name.clone(), message));
        }
    }
}

/// The share of a schema's JSON columns that say their shape, from which saying it is the schema's own practice and
/// one that does not is worth a suggestion. Below it the schema does not do this, and every column would be named.
const SHAPED_SHARE: f64 = 0.25;

/// A JSON column nothing says the shape of, in a schema that says it of others.
fn loose_json(model: &Model, out: &mut Vec<Flaw>) {
    // prisma-json-types-generator and zod-prisma-types both type a Json field in the comment above it.
    let typed = |column: &Column| {
        let above = model.prisma.get(&column.file).and_then(|lines| lines.get((column.line as usize).checked_sub(2)?));
        above.is_some_and(|l| l.trim_start().starts_with("///") && (l.contains('[') || l.contains("@zod")))
    };
    let all: Vec<(&Table, &Column, bool)> = model
        .tables
        .values()
        .filter(|t| judged(t))
        .flat_map(|t| t.columns.iter().map(move |c| (t, c)))
        .filter(|(t, c)| model.kind(t, c).0 == Family::Json)
        .map(|(t, c)| (t, c, typed(c) || model.checks.shaped.contains(&(t.name.clone(), c.name.clone()))))
        .collect();
    let said = all.iter().filter(|(_, _, said)| *said).count();
    if (said as f64) < all.len() as f64 * SHAPED_SHARE {
        return;
    }
    for (table, column, _) in all.iter().filter(|(_, _, said)| !said) {
        let message = format!(
            "{}.{} is JSON with nothing said of its shape, where {said} of the schema's {} JSON columns say theirs: a string or an array can land where an object is read. Say it as the others do (`CHECK (jsonb_typeof({}) = 'object')`)",
            table.name,
            column.name,
            all.len(),
            column.name
        );
        out.push(flaw(&column.file, column.line, "loose-json", format!("{}.{}", table.name, column.name), message));
    }
}

/// Rows from which the planner's word on a column is worth reading.
const BIG: f64 = 1000.0;

/// A value from the data, short enough for a message.
fn shown(value: &str) -> String {
    if value.chars().count() > 30 {
        format!("{}…", value.chars().take(30).collect::<String>())
    } else {
        value.to_string()
    }
}

// ponytail: what a column holds is read from the words of its name, as a table of records is. A label column named
// for an identifier (`shipping_name` holding three carriers) is not suggested.
/// Words in a column's name that say it holds an identifier or free text, never one of a few labels.
const NOT_LABELS: &str = "id ids uuid hash sha256 checksum digest token secret ip domain url uri email phone name title notes note body message description text content path file address model campaign";

/// Whether a value reads as a label: a word or three, with none of what a sentence, an address or a digest has.
fn label(value: &str) -> bool {
    let digest = value.len() >= 16 && value.chars().all(|c| c.is_ascii_hexdigit());
    value.chars().count() <= 40
        && (1..=3).contains(&value.split_whitespace().count())
        && value.chars().any(char::is_alphabetic)
        && value.chars().all(|c| c.is_alphanumeric() || " _-.".contains(c))
        && !digest
}

/// What the planner's statistics say of the columns: one nothing has ever filled, one that holds a single value, a
/// text column with a handful of labels and no enum or CHECK to hold it to them. A column almost nothing fills is
/// not named: in the statistics tried, most such columns were new, and their old rows had not been filled yet.
/// The planner reads a sample of a large table, so each message says what the sample holds, not every row.
fn in_the_data(model: &Model, stats: &Stats, out: &mut Vec<Flaw>) {
    for (table, column) in model.tables.values().filter(|t| judged(t)).flat_map(|t| t.columns.iter().map(move |c| (t, c))) {
        let at = (table.name.clone(), column.name.clone());
        let Some(seen) = stats.get(&at).filter(|s| s.rows >= BIG) else { continue };
        let (family, array) = model.kind(table, column);
        let name = format!("{}.{}", table.name, column.name);
        let rows = seen.rows.round();
        // The time something happened is NULL until it does, and a status has one value until the second is reached.
        let moment = matches!(family, Family::Timestamp | Family::Timestamptz | Family::Date);
        let closed = model.allowed.contains_key(&at) || seen.held;
        let known: f64 = seen.common.iter().map(|c| c.1).sum();
        let labels = !name_words(&column.name).iter().any(|w| among(NOT_LABELS, w)) && seen.common.iter().all(|c| label(&c.0));
        if seen.nulls >= 1.0 && !moment {
            let message =
                format!("{name} is NULL in every row the planner sampled, of about {rows}: nothing seems to fill it. If nothing is about to, drop it");
            out.push(flaw(&column.file, column.line, "never-filled", name, message));
        } else if seen.distinct == 1.0 && seen.nulls < 0.01 && family != Family::Boolean && !moment && !closed {
            // A value is shown only where it reads as a label: a name or an address never leaves the database.
            let value = seen.common.first().filter(|_| labels).map_or(String::new(), |c| format!(" ('{}')", shown(&c.0)));
            let message = format!("{name} holds one value{value} in every row the planner sampled, of about {rows}: a column that tells no two rows apart. Drop it, or make the value a constant in the code");
            out.push(flaw(&column.file, column.line, "one-value", name, message));
        } else if family == Family::Text
            && !array
            && (2.0..=12.0).contains(&seen.distinct)
            && !closed
            && labels
            && known >= (1.0 - seen.nulls) * 0.99
        {
            let values = seen.common.iter().map(|c| shown(&c.0)).collect::<Vec<_>>().join(", ");
            let message = format!(
                "{name} holds only {} values in the rows the planner sampled, of about {rows} ({values}), and nothing holds it to them: a typo is a new value. Make it an enum, or a CHECK that lists them",
                seen.distinct
            );
            out.push(flaw(&column.file, column.line, "few-values", name, message));
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

/// What a request's files declare: the SQL in the order `columns` applies it, the Prisma schemas, and every table.
pub(crate) struct Schemas {
    pub(crate) sql_files: Vec<(String, String)>,
    pub(crate) prisma_files: Vec<(String, String)>,
    pub(crate) tables: HashMap<String, Table>,
}

pub(crate) fn schemas(request: &Request) -> Schemas {
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
    Schemas { sql_files, prisma_files, tables }
}

#[derive(serde::Deserialize, Default)]
struct Options {
    /// The planner's statistics, handed over instead of read from a database.
    #[serde(default)]
    statistics: Option<Vec<statistics::Column>>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let options: Options = request.options()?;
    // The data is read only to judge the schema as it stands: a change is judged on what it declares.
    let url = request.database_url.as_deref().filter(|u| !u.is_empty() && request.added.is_none());
    let stats = match (options.statistics, url) {
        (Some(given), _) => Some(statistics::given(given)),
        (None, Some(url)) => Some(statistics::read(url)?),
        _ => None,
    };
    let read = schemas(request);
    let checks = constraints::checks(&read.sql_files);
    let allowed = constraints::allowed(&read, &checks);
    let Schemas { mut sql_files, prisma_files, tables } = read;
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
    let prisma = prisma_files.iter().map(|(file, src)| (file.clone(), src.lines().map(str::to_string).collect())).collect();
    let model =
        Model { tables: tables.into_iter().collect(), linked, primary, retyped: inventory.types, by_stem, allowed, checks, prisma, stats };

    let mut flaws = vec![];
    open_links(&model, &mut flaws);
    twice_told(&model, &mut flaws);
    id_lists(&model, &mut flaws);
    two_types(&model, &mut flaws);
    covered_indexes(&model, &mut flaws);
    wrong_types(&model, !sql::mysql_project(&request.root, &request.files), &mut flaws);
    same_columns(&model, &mut flaws);
    no_key(&model, &mut flaws);
    loose_json(&model, &mut flaws);
    if let Some(stats) = &model.stats {
        in_the_data(&model, stats, &mut flaws);
    }
    sql_files.extend(prisma_files);
    idle_enums(&model, &sql_files, &mut flaws);

    flaws.retain(|f| request.changed(&f.file, f.line));
    flaws.sort_by(|a, b| (&a.file, a.line, a.rule, &a.key).cmp(&(&b.file, b.line, b.rule, &b.key)));
    flaws.dedup_by(|a, b| (a.rule, &a.key) == (b.rule, &b.key));
    let (suggested, failing): (Vec<Flaw>, Vec<Flaw>) = flaws.into_iter().partition(|f| among(SUGGESTED, f.rule));
    let finding = |f: Flaw| Finding {
        target: format!("data-model:{}:{}", f.rule, f.key),
        message: format!("{}:{} {}", f.file, f.line, f.message),
        file: f.file,
        line: f.line,
    };
    let read = model.stats.as_ref().map_or(String::new(), |s| format!(", the statistics of {} columns read", s.len()));
    let summary =
        format!("{} tables read, {} flaws in the data model and {} suggestions{read}", model.tables.len(), failing.len(), suggested.len());
    Ok(Answer::new(failing.into_iter().map(finding).collect(), summary).suggesting(suggested.into_iter().map(finding).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What was found, as (line, target, message): what fails, then what is suggested. With `added`, only those
    /// (file, lines) are the change's; without, the whole repository.
    fn judged_as(
        name: &str,
        files: &[(&str, &str)],
        added: Option<&[(&str, &[u32])]>,
        options: serde_json::Value,
    ) -> [Vec<(u64, String, String)>; 2] {
        let request = Request {
            command: "data-model".into(),
            root: text::temp_tree(&format!("data-model-{name}"), files),
            files: files.iter().map(|(p, _)| p.to_string()).collect(),
            added: added.map(|a| a.iter().map(|(f, l)| (f.to_string(), l.iter().copied().collect())).collect()),
            prefix: String::new(),
            database_url: None,
            options,
        };
        let answer = run(&request).unwrap();
        let text = |v: &serde_json::Value, key: &str| v[key].as_str().unwrap_or("").to_string();
        let suggested = answer.data.iter().flat_map(|d| d["suggestions"].as_array().cloned().unwrap_or_default());
        let failing = answer.findings.into_iter().map(|f| (f.line as u64, f.target, f.message)).collect();
        [failing, suggested.map(|s| (s["line"].as_u64().unwrap_or(0), text(&s, "target"), text(&s, "message"))).collect()]
    }

    /// Every target found, failing or suggested, in the order of the schema.
    fn targets(name: &str, files: &[(&str, &str)], added: Option<&[(&str, &[u32])]>) -> Vec<String> {
        let mut all = judged_as(name, files, added, serde_json::json!({})).concat();
        all.sort_by_key(|found| found.0);
        all.into_iter().map(|found| found.1).collect()
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
    fn a_table_with_no_key_fails_and_a_flag_beside_its_status_and_json_with_no_shape_among_the_shaped_are_suggested() {
        let sql = "create table notes (body text);\ncreate table accounts (\n  id uuid primary key,\n  status text not null check (status in ('active', 'closed')),\n  active boolean not null,\n  a jsonb check (jsonb_typeof(a) = 'object'),\n  b jsonb check (jsonb_typeof(b) = 'object'),\n  c jsonb check (jsonb_typeof(c) = 'array'),\n  d jsonb check (jsonb_typeof(d) = 'object'),\n  loose jsonb\n);\n";
        let [failing, suggested] = judged_as("keys", &[("migrations/001.sql", sql)], None, serde_json::json!({}));
        assert_eq!(failing.iter().map(|f| f.1.as_str()).collect::<Vec<_>>(), vec!["data-model:no-key:notes"]);
        assert_eq!(
            suggested.iter().map(|f| f.1.as_str()).collect::<Vec<_>>(),
            vec!["data-model:twice-told:accounts.active", "data-model:loose-json:accounts.loose"]
        );
        assert!(suggested[0].2.contains("accounts.active and accounts.status = 'active' record one fact twice"), "{}", suggested[0].2);
        assert!(suggested[1].2.contains("where 4 of the schema's 5 JSON columns say theirs"), "{}", suggested[1].2);
        // A schema that says the shape of one JSON column in five does not make a practice of it, and a copy a
        // migration set aside is not a table of the model.
        let few = "create table events (id uuid primary key, a jsonb check (jsonb_typeof(a) = 'object'), b jsonb, c jsonb, d jsonb, loose jsonb);\ncreate table events_backup_20260728 (body text);\n";
        assert_eq!(targets("few", &[("migrations/001.sql", few)], None), Vec::<String>::new());
    }

    #[test]
    fn the_planners_statistics_suggest_a_column_nothing_fills_one_with_one_value_and_a_text_with_a_handful() {
        let sql = "create table orders (\n  id uuid primary key,\n  kind text not null,\n  note text,\n  region text not null,\n  paid boolean not null,\n  paid_at timestamptz,\n  cancelled_at timestamptz,\n  state text not null check (state in ('new', 'done')),\n  carrier_ref_id text,\n  summary text,\n  seen text,\n  scope text,\n  tier text\n);\ncreate table tiny (id uuid primary key, note text);\n";
        let column = |table: &str, column: &str, rows: f64, nulls: f64, distinct: f64, common: serde_json::Value| serde_json::json!({ "table": table, "column": column, "rows": rows, "nulls": nulls, "distinct": distinct, "common": common });
        let none = serde_json::json!([]);
        let statistics = serde_json::json!([
            column("orders", "kind", 5000.0, 0.0, 3.0, serde_json::json!([["retail", 0.6], ["trade", 0.3], ["gift", 0.1]])),
            column("orders", "note", 5000.0, 1.0, 0.0, none.clone()),
            column("orders", "region", 5000.0, 0.0, 1.0, serde_json::json!([["eu", 1.0]])),
            column("orders", "paid", 5000.0, 0.0, 2.0, serde_json::json!([["f", 0.7], ["t", 0.3]])),
            column("orders", "paid_at", 5000.0, 0.75, -0.2, none.clone()),
            // A time is NULL until the thing happens, a CHECK already holds `state` to its values (one of them, so
            // far), a small table says little.
            column("orders", "cancelled_at", 5000.0, 1.0, 0.0, none.clone()),
            column("orders", "state", 5000.0, 0.0, 1.0, serde_json::json!([["new", 1.0]])),
            // A few identifiers and a few sentences are not labels, and a column filled now and then is not judged.
            column("orders", "carrier_ref_id", 5000.0, 0.0, 2.0, serde_json::json!([["ups", 0.5], ["dhl", 0.5]])),
            column("orders", "summary", 5000.0, 0.0, 2.0, serde_json::json!([["Left at the door, as asked.", 0.5], ["Signed for", 0.5]])),
            column("orders", "scope", 5000.0, 0.0, 2.0, serde_json::json!([["booking", 0.5], ["profile:pro-3575", 0.5]])),
            // The database says a CHECK already holds this one, though no migration here shows it.
            serde_json::json!({ "table": "orders", "column": "tier", "rows": 5000.0, "distinct": 2.0, "common": [["gold", 0.5], ["plain", 0.5]], "held": true }),
            column("orders", "seen", 5000.0, 0.997, -0.5, none.clone()),
            column("tiny", "note", 50.0, 1.0, 0.0, none),
        ]);
        let [failing, suggested] = judged_as("data", &[("migrations/001.sql", sql)], None, serde_json::json!({ "statistics": statistics }));
        assert_eq!(failing.len(), 0);
        assert_eq!(
            suggested.iter().map(|f| (f.0, f.1.as_str())).collect::<Vec<_>>(),
            vec![
                (3, "data-model:few-values:orders.kind"),
                (4, "data-model:never-filled:orders.note"),
                (5, "data-model:one-value:orders.region"),
                (6, "data-model:twice-told:orders.paid"),
            ]
        );
        assert!(suggested[0].2.ends_with("orders.kind holds only 3 values in the rows the planner sampled, of about 5000 (retail, trade, gift), and nothing holds it to them: a typo is a new value. Make it an enum, or a CHECK that lists them"), "{}", suggested[0].2);
        assert!(
            suggested[1].2.contains("orders.note is NULL in every row the planner sampled, of about 5000: nothing seems to fill it"),
            "{}",
            suggested[1].2
        );
        assert!(
            suggested[2].2.contains("orders.region holds one value ('eu') in every row the planner sampled, of about 5000"),
            "{}",
            suggested[2].2
        );
        assert!(
            suggested[3]
                .2
                .ends_with("In the data they already disagree: the flag is true in about 30% of the rows and the time is set in about 25%"),
            "{}",
            suggested[3].2
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
