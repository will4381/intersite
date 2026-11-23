//! intersite-core: the analysis engine behind Intersite's SQL, regex, trace, twins and value-drift checks.
//! The Node CLI sends one JSON request on stdin and reads one JSON answer on stdout; the engine reads the files
//! itself, in parallel. Paths in and out are relative to `root`, the repository top.

// Index loops over parallel arrays and negated conditions read closer to the JS they were ported from.
#![allow(clippy::needless_range_loop, clippy::nonminimal_bool)]

mod aroma;
mod boundaries;
mod decisions;
mod drift;
mod globals;
mod graph;
mod imports;
mod hygiene;
mod dup;
mod complexity;
mod coverage;
mod functions;
mod js;
mod naming;
mod search;
mod similar;
mod special;
mod regex;
mod renames;
mod schemas;
mod sql;
mod stats;
mod tamper;
mod style;
mod text;
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
    pub added: Option<HashMap<String, Vec<u32>>>,
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

impl Request {
    /// Whether a line is this change's (or, judging everything, whether the file is the project's).
    pub fn changed(&self, file: &str, line: u32) -> bool {
        match &self.added {
            None => file.starts_with(&self.prefix),
            Some(added) => added.get(file).is_some_and(|lines| lines.contains(&line)),
        }
    }

    /// The set of added lines per file, for fast lookups.
    pub fn added_sets(&self) -> Option<HashMap<&str, HashSet<u32>>> {
        self.added.as_ref().map(|a| a.iter().map(|(f, l)| (f.as_str(), l.iter().copied().collect())).collect())
    }
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
        "schema-drift" => schemas::run(&request),
        "imports" => imports::run(&request),
        "boundaries" => boundaries::run(&request),
        "tamper" => tamper::run(&request),
        "special-case" => special::run(&request),
        "hook" => tamper::hook(&request),
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
