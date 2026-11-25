//! intersite-core: the analysis engine behind Intersite's SQL, regex, trace, twins and value-drift checks.
//! The Node CLI sends one JSON request on stdin and reads one JSON answer on stdout; the engine reads the files
//! itself, in parallel. Paths in and out are relative to `root`, the repository top.

mod aroma;
mod auth;
mod boundaries;
mod cdp;
mod columns;
mod complexity;
mod contract;
mod coverage;
mod datamodel;
mod decisions;
mod drift;
mod dup;
mod env;
mod flow;
mod functions;
mod globals;
mod graph;
mod hygiene;
mod imports;
mod js;
mod naming;
mod outcome;
mod regex;
mod registry;
mod renames;
mod routes;
mod schemas;
mod search;
mod secrets;
mod similar;
mod special;
mod sql;
mod stats;
mod structure;
mod style;
mod tamper;
mod text;
mod things;
mod trace;
mod twins;
mod units;
mod unused;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;

/// One request from the CLI.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub command: String,
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// Lines the change added, per file; absent when judging every file.
    #[serde(default)]
    pub added: Option<HashMap<String, HashSet<u32>>>,
    /// Only files under this prefix are the project's; others are read for context.
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub database_url: Option<String>,
    /// Command-specific options, passed through.
    #[serde(default)]
    pub options: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
pub struct Finding {
    pub file: String,
    pub line: u32,
    pub target: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct Answer {
    pub findings: Vec<Finding>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Answer {
    pub fn new(findings: Vec<Finding>, summary: String) -> Self {
        Answer { findings, summary, data: None }
    }
}

impl Request {
    /// Whether a line is this change's (or, judging everything, whether the file is the project's).
    pub fn changed(&self, file: &str, line: u32) -> bool {
        match &self.added {
            None => file.starts_with(&self.prefix),
            Some(added) => added.get(file).is_some_and(|lines| lines.contains(&line)),
        }
    }

    /// The command's options as its own type; a request without options reads as `{}`.
    pub fn options<T: serde::de::DeserializeOwned>(&self) -> Result<T, String> {
        let read = if self.options.is_null() { T::deserialize(&serde_json::json!({})) } else { T::deserialize(&self.options) };
        read.map_err(|e| format!("{} options: {e}", self.command))
    }
}

/// One finding per key, the first one found, sorted by place; `note(message, more)` rewrites the message of one whose
/// key came up `more` more times.
pub fn first_per_key(found: Vec<(String, Finding)>, note: impl Fn(&str, usize) -> String) -> Vec<Finding> {
    let mut by_key: std::collections::BTreeMap<String, (Finding, usize)> = Default::default();
    for (key, finding) in found {
        by_key.entry(key).and_modify(|e| e.1 += 1).or_insert((finding, 0));
    }
    let mut findings: Vec<Finding> = by_key
        .into_values()
        .map(|(mut f, more)| {
            if more > 0 {
                f.message = note(&f.message, more);
            }
            f
        })
        .collect();
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    findings
}

/// A repository path as the project names it: relative to the project's folder, `../../shared/x.ts` outside it.
pub fn rel(prefix: &str, file: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    if prefix.is_empty() {
        return file.to_string();
    }
    let from: Vec<&str> = prefix.split('/').collect();
    let to: Vec<&str> = file.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

fn main() {
    // Flows talk with Node line by line while they run (the adapter is the project's JavaScript), so they do not take
    // the one-request, one-answer path below.
    if std::env::args().nth(1).as_deref() == Some("flow") {
        if let Err(message) = flow::serve() {
            eprintln!("intersite-core: {message}");
            std::process::exit(2);
        }
        return;
    }
    let mut input = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("intersite-core: cannot read the request: {error}");
        std::process::exit(2);
    }
    let request: Request = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(error) => {
            eprintln!("intersite-core: the request is not valid JSON: {error}");
            std::process::exit(2);
        }
    };
    // A panic anywhere, rayon workers included, is one line on stderr and exit 2 (not 101), which the CLI relays as
    // the gate's error. The lock keeps two panicking workers from printing twice: the first exits holding it.
    let command = request.command.clone();
    std::panic::set_hook(Box::new(move |info| {
        static ONCE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _held = ONCE.lock();
        let place = info.location().map_or(String::new(), |l| format!("{}:{}", l.file(), l.line()));
        eprintln!("intersite-core: internal error in {command}: {} at {place}", info.payload_as_str().unwrap_or("panic"));
        std::process::exit(2);
    }));
    let answer = match request.command.as_str() {
        "sql" => sql::run(&request),
        "pg-stats" => sql::stats(&request),
        "regex" => regex::run(&request),
        "value-drift" => drift::run(&request),
        "duplicates" => dup::run(&request),
        "style-drift" => style::run(&request),
        "naming" => naming::run(&request),
        "unused" => unused::run(&request),
        "similar" => similar::run(&request),
        "search" => search::run(&request),
        "test-integrity" => hygiene::tests(&request),
        "new-deps" => hygiene::new_deps(&request),
        "artifacts" => hygiene::artifacts(&request),
        "mutants" => hygiene::mutants(&request),
        "complexity" => complexity::run(&request),
        "coverage" => coverage::run(&request),
        "stats" => stats::run(&request),
        "trace-report" => trace::run(&request),
        "twins" => twins::run(&request),
        "decisions" => decisions::run(&request),
        "renames" => renames::run(&request),
        "routes" => routes::run(&request),
        "env" => env::run(&request),
        "schema-drift" => schemas::run(&request),
        "imports" => imports::run(&request),
        "boundaries" => boundaries::run(&request),
        "tamper" => tamper::run(&request),
        "special-case" => special::run(&request),
        "hook" => tamper::hook(&request),
        "columns" => columns::run(&request),
        "data-model" => datamodel::run(&request),
        "secrets" => secrets::run(&request),
        "auth" => auth::run(&request),
        "structure" => structure::run(&request),
        "outcome" => outcome::run(&request),
        "contract" => contract::run(&request),
        other => Err(format!("unknown command {other}")),
    };
    match answer {
        Ok(a) => println!("{}", serde_json::to_string(&a).expect("answer serialises")),
        Err(message) => {
            eprintln!("intersite-core: {message}");
            std::process::exit(2);
        }
    }
}
