//! The closed sets of values a schema gives its columns, and what its CHECK constraints say. A column's values are a
//! closed set where a Prisma enum types it, a Postgres enum does, or one CHECK holds it to a list. Constraints are read
//! as the migrations leave them, and by their words: a guarded migration drops and adds one inside `DO $$ … $$`, which
//! no parser opens. Only a CHECK's own expression is parsed. The `data-model` and `states` checks share this reading.

use regex::Regex;
use sqlparser::ast as sq;
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Location, Token};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use crate::columns::{self, Schemas};
use crate::sql;

/// The values a column may hold.
#[derive(Clone, Debug)]
pub(crate) struct Allowed {
    /// As the database stores them.
    pub(crate) stored: BTreeSet<String>,
    /// Prisma's name for each, for an enum (`@map` gives a member another stored value). Empty where Prisma code
    /// writes the stored value itself: a text column under a CHECK.
    pub(crate) names: HashMap<String, String>,
    /// What declares the set: "the enum OrderStatus", "the check on orders.status".
    pub(crate) by: String,
}

static PRISMA_MAP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"@map\("([^"]*)"\)"#).unwrap());

/// One Prisma enum: its name, the database's name for the type, and each member with the value stored for it.
struct PrismaEnum {
    name: String,
    stored_as: String,
    members: Vec<(String, String)>,
}

/// A Prisma file's enums, by lowercase name (as a column's kind names them).
fn prisma_enums(src: &str) -> HashMap<String, PrismaEnum> {
    let mut out = HashMap::new();
    let mut open: Option<PrismaEnum> = None;
    for line in src.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        let Some(current) = &mut open else {
            if let Some(name) = line.strip_prefix("enum ").filter(|_| line.ends_with('{')) {
                let name = name.trim_end_matches('{').trim().to_string();
                open = Some(PrismaEnum { stored_as: name.to_lowercase(), name, members: vec![] });
            }
            continue;
        };
        if line == "}" {
            out.extend(open.take().map(|e| (e.name.to_lowercase(), e)));
        } else if line.starts_with("@@map") {
            current.stored_as = PRISMA_MAP.captures(line).map_or(String::new(), |m| m[1].to_lowercase());
        } else if let Some(member) = line.split_whitespace().next().filter(|w| !w.starts_with('@')) {
            let stored = PRISMA_MAP.captures(line).map_or(member.to_string(), |m| m[1].to_string());
            current.members.push((member.to_string(), stored));
        }
    }
    out
}

static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"'((?:[^']|'')*)'").unwrap());
static ENUM_EVENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)\bcreate\s+type\s+(?P<made>(?:"?\w+"?\.)?"?\w+"?)\s+as\s+enum\s*\((?P<values>[^)]*)\)|\balter\s+type\s+(?P<altered>(?:"?\w+"?\.)?"?\w+"?)\s+(?:add\s+value\s+(?:if\s+not\s+exists\s+)?'(?P<added>(?:[^']|'')*)'|rename\s+value\s+'(?P<from>(?:[^']|'')*)'\s+to\s+'(?P<to>(?:[^']|'')*)'|rename\s+to\s+(?P<renamed>"?\w+"?))|\bdrop\s+type\s+(?:if\s+exists\s+)?(?P<dropped>(?:"?\w+"?\.)?"?\w+"?)"#,
    )
    .unwrap()
});

/// The enum types SQL declares, each with its values, as the migrations leave them.
fn sql_enums(sql_files: &[(String, String)]) -> HashMap<String, BTreeSet<String>> {
    let mut out: HashMap<String, BTreeSet<String>> = HashMap::new();
    let plain = |m: regex::Match| m.as_str().replace("''", "'");
    for event in sql_files.iter().flat_map(|(_, src)| ENUM_EVENT.captures_iter(src)) {
        if let (Some(made), Some(values)) = (event.name("made"), event.name("values")) {
            out.insert(sql::bare(made.as_str()), QUOTED.captures_iter(values.as_str()).map(|v| v[1].replace("''", "'")).collect());
        } else if let Some(dropped) = event.name("dropped") {
            out.remove(&sql::bare(dropped.as_str()));
        } else if let Some(altered) = event.name("altered") {
            let name = sql::bare(altered.as_str());
            if let Some(added) = event.name("added") {
                out.entry(name).or_default().insert(plain(added));
            } else if let (Some(from), Some(to), Some(values)) = (event.name("from"), event.name("to"), out.get_mut(&name)) {
                values.remove(&plain(from));
                values.insert(plain(to));
            } else if let (Some(renamed), Some(values)) = (event.name("renamed"), out.remove(&name)) {
                out.insert(sql::bare(renamed.as_str()), values);
            }
        }
    }
    out
}

// ponytail: a constraint is found by its words, wherever the statement sits, and not by parsing the migration: a
// guarded migration drops and adds one inside `DO $$ … $$`, which the parser does not open. Only the CHECK's own
// expression is parsed.
static TABLE_EVENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\b(?P<verb>create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table(?:\s+only)?(?:\s+if\s+exists)?|drop\s+table(?:\s+if\s+exists)?)\s+(?P<table>(?:"?\w+"?\.)?"?\w+"?)(?P<body>[^;]*)"#).unwrap()
});
static CHECK_EVENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\bdrop\s+constraint\s+(?:if\s+exists\s+)?"?(?P<dropped>\w+)"?|\bdrop\s+column\s+(?:if\s+exists\s+)?"?(?P<column>\w+)"?|\brename\s+constraint\s+"?(?P<old>\w+)"?\s+to\s+"?(?P<new>\w+)"?|(?:\bconstraint\s+"?(?P<name>\w+)"?\s+)?\bcheck\s*\("#).unwrap()
});

/// The text up to the parenthesis that closes one already open, quoted strings skipped.
fn balanced(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let (mut depth, mut i) = (1usize, 0usize);
    while i < bytes.len() {
        match bytes[i] {
            b'\'' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'\'' {
                    i += 1;
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// An expression without the parentheses and casts around it: `('a'::text)` is 'a'.
pub(crate) fn unwrapped(mut e: &sq::Expr) -> &sq::Expr {
    while let sq::Expr::Nested(inner) | sq::Expr::Cast { expr: inner, .. } = e {
        e = inner;
    }
    e
}

/// A string literal's value and where in the SQL it starts.
pub(crate) fn text_of(e: &sq::Expr) -> Option<(String, Location)> {
    match unwrapped(e) {
        sq::Expr::Value(v) => match &v.value {
            sq::Value::SingleQuotedString(s) => Some((s.clone(), v.span.start)),
            _ => None,
        },
        _ => None,
    }
}

/// Every element's text, when each is a string literal.
fn texts(list: &[sq::Expr]) -> Option<Vec<(String, Location)>> {
    list.iter().map(text_of).collect()
}

/// The column an expression names, whatever qualifies it.
fn column_name(e: &sq::Expr) -> Option<String> {
    match unwrapped(e) {
        sq::Expr::Identifier(i) => Some(columns::ident(&i.to_string())),
        sq::Expr::CompoundIdentifier(parts) => parts.last().map(|i| columns::ident(&i.to_string())),
        _ => None,
    }
}

/// The lists a CHECK holds a column to: `status IN ('a', 'b')`, `status = ANY (ARRAY['a', 'b'])`, either with
/// `status IS NULL OR` before it, and each side of an AND. A list beside another OR binds nothing.
fn lists_of(expr: &sq::Expr) -> Vec<(String, BTreeSet<String>)> {
    let one = |column: &sq::Expr, list: &[sq::Expr]| match (column_name(column), texts(list)) {
        (Some(column), Some(values)) => vec![(column, values.into_iter().map(|v| v.0).collect())],
        _ => vec![],
    };
    match expr {
        sq::Expr::Nested(inner) => lists_of(inner),
        sq::Expr::BinaryOp { left, op: sq::BinaryOperator::And, right } => [lists_of(left), lists_of(right)].concat(),
        sq::Expr::BinaryOp { left, op: sq::BinaryOperator::Or, right } => {
            let (null, other) = match (unwrapped(left), unwrapped(right)) {
                (sq::Expr::IsNull(null), _) => (null, right),
                (_, sq::Expr::IsNull(null)) => (null, left),
                _ => return vec![],
            };
            lists_of(other).into_iter().filter(|(column, _)| column_name(null).as_ref() == Some(column)).collect()
        }
        sq::Expr::In { expr, target: sq::InTarget::List(list), negated: false, .. } => one(expr, list),
        sq::Expr::AnyOp { left, compare_op: sq::BinaryOperator::Eq, right, .. } => match unwrapped(right) {
            sq::Expr::Array(array) => one(left, &array.elem),
            _ => vec![],
        },
        _ => vec![],
    }
}

/// The expression in the text of one CHECK, when all of it reads as one.
fn check_expr(body: &str) -> Option<sq::Expr> {
    let read = Parser::new(&PostgreSqlDialect {}).try_with_sql(body).and_then(|mut parser| {
        let expr = parser.parse_expr()?;
        Ok((expr, parser.peek_token().token == Token::EOF))
    });
    read.ok().filter(|(_, whole)| *whole).map(|(expr, _)| expr)
}

/// What the CHECK constraints say, as the migrations leave them.
#[derive(Default)]
pub(crate) struct Checks {
    /// (table, column) -> the values the one CHECK on it lists.
    pub(crate) lists: HashMap<(String, String), BTreeSet<String>>,
    /// (table, column) a CHECK says the JSON type of: `jsonb_typeof(payload) = 'object'`.
    pub(crate) shaped: HashSet<(String, String)>,
    /// Tables some statement gives a primary key.
    pub(crate) keyed: HashSet<String>,
}

static PRIMARY_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bprimary\s+key\b").unwrap());
static JSON_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bjsonb?_typeof\s*\(\s*\(*\s*("?\w+"?)"#).unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""?\b(\w+)\b"?"#).unwrap());

/// The first name in a CHECK's text that is not a function's: the column Postgres would name the constraint after.
fn first_column(body: &str) -> String {
    let named = WORD.captures_iter(body).find(|m| !body[m.get(0).map_or(0, |w| w.end())..].trim_start().starts_with('('));
    named.map_or(String::new(), |m| m[1].to_lowercase())
}

pub(crate) fn checks(sql_files: &[(String, String)]) -> Checks {
    let mut out = Checks::default();
    // (table, constraint) -> the CHECK's text
    let mut live: HashMap<(String, String), String> = HashMap::new();
    for statement in sql_files.iter().flat_map(|(_, src)| TABLE_EVENT.captures_iter(src)) {
        let table = sql::bare(&statement["table"]);
        if statement["verb"].to_ascii_lowercase().starts_with("drop") {
            live.retain(|(t, _), _| t != &table);
            out.keyed.remove(&table);
            continue;
        }
        let body = &statement["body"];
        if PRIMARY_KEY.is_match(body) {
            out.keyed.insert(table.clone());
        }
        for event in CHECK_EVENT.captures_iter(body) {
            let named = |group: &str| event.name(group).map(|m| m.as_str().to_lowercase());
            if let Some(dropped) = named("dropped") {
                live.remove(&(table.clone(), dropped));
            } else if let Some(column) = named("column") {
                live.retain(|(t, _), check| t != &table || !WORD.captures_iter(check).any(|w| w[1].to_lowercase() == column));
            } else if let (Some(old), Some(new)) = (named("old"), named("new")) {
                let kept = live.remove(&(table.clone(), old));
                live.extend(kept.map(|kept| ((table.clone(), new), kept)));
            } else if let Some(check) = balanced(&body[event.get(0).map_or(0, |m| m.end())..]) {
                // Postgres names a CHECK nobody named after its table and column; a second one on the column is kept too.
                let name = named("name").unwrap_or_else(|| {
                    let auto = format!("{table}_{}_check", first_column(check));
                    let taken = live.keys().filter(|(t, n)| t == &table && n.starts_with(&auto)).count();
                    if taken == 0 {
                        auto
                    } else {
                        format!("{auto}{taken}")
                    }
                });
                live.insert((table.clone(), name), check.to_string());
            }
        }
    }
    let mut twice = HashSet::new();
    for ((table, _), check) in &live {
        out.shaped.extend(JSON_TYPE.captures_iter(check).map(|m| (table.clone(), columns::ident(&m[1]))));
        for (column, values) in check_expr(check).map(|e| lists_of(&e)).unwrap_or_default() {
            if out.lists.insert((table.clone(), column.clone()), values).is_some() {
                twice.insert((table.clone(), column));
            }
        }
    }
    // Two lists on one column: which of them binds is not this reading's to say.
    out.lists.retain(|at, _| !twice.contains(at));
    out
}

/// (table, column) -> the values it may hold, for each column a Prisma enum, a Postgres enum or a CHECK list closes.
pub(crate) fn allowed(schemas: &Schemas, checks: &Checks) -> HashMap<(String, String), Allowed> {
    let enums: HashMap<String, PrismaEnum> = schemas.prisma_files.iter().flat_map(|(_, src)| prisma_enums(src)).collect();
    let typed = sql_enums(&schemas.sql_files);
    let mut out = HashMap::new();
    for table in schemas.tables.values() {
        for column in &table.columns {
            let at = (table.name.clone(), column.name.clone());
            let allowed = match column.kind.strip_prefix("enum ") {
                Some(name) => enums.get(name).map(|e| {
                    let mut stored: BTreeSet<String> = e.members.iter().map(|m| m.1.clone()).collect();
                    // A value a migration added that the Prisma schema has not caught up with is one SQL may hold.
                    stored.extend(typed.get(&e.stored_as).into_iter().flatten().cloned());
                    Allowed { stored, names: e.members.iter().cloned().collect(), by: format!("the enum {}", e.name) }
                }),
                None => {
                    let by_type = typed.get(&sql::bare(&column.kind)).filter(|_| table.source == 0);
                    let by = if by_type.is_some() {
                        format!("the enum {}", sql::bare(&column.kind))
                    } else {
                        format!("the check on {}.{}", table.name, column.name)
                    };
                    by_type.or_else(|| checks.lists.get(&at)).map(|values| Allowed { stored: values.clone(), names: HashMap::new(), by })
                }
            };
            out.extend(allowed.map(|allowed| (at, allowed)));
        }
    }
    out
}
