//! What a database's planner knows of its columns: how many rows a table has, how often a column is NULL, how many
//! values it holds and, for a column with a dozen or fewer, which. It is read from the catalog (`pg_stats`,
//! `pg_class`) in a read-only transaction: no row of any table is read and no query runs against one. The numbers are
//! the planner's estimates from its last ANALYZE, so the `data-model` check uses them for suggestions only. The
//! catalog is also asked which columns an enum type or a CHECK already holds to their values: the database knows
//! that of itself better than the migrations in a repository do.

use std::collections::HashMap;

use crate::sql;

/// One column, as the planner sees it.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct Column {
    table: String,
    column: String,
    /// The table's rows, as last counted.
    pub(crate) rows: f64,
    /// The share of the rows where the column is NULL.
    pub(crate) nulls: f64,
    /// How many values it holds: a count, or below zero the share of the rows that are distinct.
    pub(crate) distinct: f64,
    /// Its commonest values with the share of the rows each has; read only for a column with a dozen or fewer.
    pub(crate) common: Vec<(String, f64)>,
    /// An enum type, or a CHECK that names values, already holds the column in the database.
    pub(crate) held: bool,
}

/// (table, column) -> what the planner knows of it.
pub(crate) type Stats = HashMap<(String, String), Column>;

/// Statistics handed over as a list, each naming its table and column.
pub(crate) fn given(columns: Vec<Column>) -> Stats {
    columns.into_iter().map(|c| ((c.table.to_lowercase(), c.column.clone()), c)).collect()
}

const QUERY: &str = "SELECT s.tablename::text, s.attname::text, c.reltuples::float8, s.null_frac::float8, s.n_distinct::float8, \
     CASE WHEN s.n_distinct BETWEEN 1 AND 12 THEN array_to_json(s.most_common_vals::text::text[])::text END, \
     CASE WHEN s.n_distinct BETWEEN 1 AND 12 THEN array_to_json(s.most_common_freqs)::text END \
     FROM pg_stats s \
     JOIN pg_namespace n ON n.nspname = s.schemaname \
     JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.tablename \
     WHERE s.schemaname = ANY (current_schemas(false)) AND c.relkind IN ('r', 'p') AND c.reltuples > 0";

/// Columns of an enum type, and columns a CHECK tests against a list (`col = ANY (ARRAY[…])`, as Postgres writes an
/// IN) or branches on (`CASE col WHEN`). A CHECK that only names the column beside another's values does not hold it.
const HELD: &str = "SELECT c.relname::text, a.attname::text FROM pg_constraint k \
     JOIN pg_class c ON c.oid = k.conrelid \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (k.conkey) \
     CROSS JOIN LATERAL (SELECT regexp_replace(a.attname, '([^[:alnum:]_])', '\\\\\\1', 'g') AS name) q \
     WHERE k.contype = 'c' AND n.nspname = ANY (current_schemas(false)) \
     AND pg_get_constraintdef(k.oid) ~ ('(\\m' || q.name || '\\M\"?\\)*(::[a-z ]+)?\\s*=\\s*ANY|CASE\\s+\\(*\"?' || q.name || '\"?\\)*(::[a-z ]+)?\\s+WHEN)') \
     UNION \
     SELECT c.relname::text, a.attname::text FROM pg_attribute a \
     JOIN pg_class c ON c.oid = a.attrelid \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     JOIN pg_type t ON t.oid = a.atttypid \
     WHERE t.typtype = 'e' AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname = ANY (current_schemas(false))";

/// The statistics of every column in the schemas on the search path.
pub(crate) fn read(url: &str) -> Result<Stats, String> {
    let mut client = sql::connect(url)?;
    let mut tx = client.transaction().map_err(|e| e.to_string())?;
    let unreadable = |e: postgres::Error| format!("the planner's statistics are not readable: {e}");
    let rows = tx.batch_execute("SET TRANSACTION READ ONLY").and_then(|_| tx.query(QUERY, &[])).map_err(unreadable)?;
    let held: std::collections::HashSet<(String, String)> =
        tx.query(HELD, &[]).map_err(unreadable)?.iter().map(|row| (row.get(0), row.get(1))).collect();
    let list = |text: Option<String>| text.and_then(|t| serde_json::from_str::<Vec<serde_json::Value>>(&t).ok()).unwrap_or_default();
    let columns = rows.iter().map(|row| {
        let values = list(row.get(5));
        let shares = list(row.get(6));
        let common = values.iter().zip(&shares).filter_map(|(v, s)| Some((v.as_str()?.to_string(), s.as_f64()?))).collect();
        let (table, column): (String, String) = (row.get(0), row.get(1));
        let held = held.contains(&(table.clone(), column.clone()));
        Column { table, column, rows: row.get(2), nulls: row.get(3), distinct: row.get(4), common, held }
    });
    let stats = given(columns.collect());
    let _ = tx.rollback();
    Ok(stats)
}
