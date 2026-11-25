//! `intersite stats`: how each gate and lint rule fares, from the ledger `check` writes and every acknowledgment.
//! A finding is fixed when an earlier run of a branch raised it and the branch's latest run neither raises nor
//! acknowledges it; acknowledged when a run let it through on an acknowledgment, `gates.acknowledged` lists it, or a
//! commit's `Intersite-Ack:` trailer names its gate. Google turns off a check whose findings developers mostly mark not
//! useful; this is the number that decision needs. It only measures: nothing is demoted.

use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::{Answer, Request};

#[derive(Deserialize, Clone, PartialEq, Eq, Hash)]
struct Key {
    stage: String,
    target: String,
}

#[derive(Deserialize)]
struct Run {
    at: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    findings: Vec<Key>,
    #[serde(default)]
    acknowledged: Vec<Key>,
}

#[derive(Deserialize)]
struct Entry {
    gate: String,
    target: String,
}

#[derive(Deserialize)]
struct Trailer {
    sha: String,
    gate: String,
}

#[derive(Default)]
struct Tally {
    raised: HashSet<String>,
    fixed: HashSet<String>,
    acknowledged: HashSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// .intersite/ledger.jsonl, "" when there is none.
    ledger: String,
    /// The config's `gates.acknowledged`.
    acknowledged: Vec<Entry>,
    /// `Intersite-Ack:` commit trailers.
    trailers: Vec<Trailer>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { ledger, acknowledged: entries, trailers } = request.options()?;
    // A line cut short by an interrupted write is skipped, not fatal: the ledger only ever grows by appends.
    let runs: Vec<Run> = ledger.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();

    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    let mut branches: HashMap<&str, Vec<&Run>> = HashMap::new();
    for run in &runs {
        branches.entry(run.branch.as_str()).or_default().push(run);
        for k in &run.findings {
            tallies.entry(k.stage.clone()).or_default().raised.insert(k.target.clone());
        }
        for k in &run.acknowledged {
            let t = tallies.entry(k.stage.clone()).or_default();
            t.raised.insert(k.target.clone());
            t.acknowledged.insert(k.target.clone());
        }
    }
    for e in &entries {
        let t = tallies.entry(e.gate.clone()).or_default();
        t.raised.insert(e.target.clone());
        t.acknowledged.insert(e.target.clone());
    }
    for tr in &trailers {
        let t = tallies.entry(tr.gate.clone()).or_default();
        t.raised.insert(format!("commit {}", tr.sha));
        t.acknowledged.insert(format!("commit {}", tr.sha));
    }
    for list in branches.values_mut() {
        list.sort_by(|a, b| a.at.cmp(&b.at));
        let Some((last, earlier)) = list.split_last() else { continue };
        let still: HashSet<&Key> = last.findings.iter().chain(&last.acknowledged).collect();
        for k in earlier.iter().flat_map(|r| &r.findings) {
            if !still.contains(k) {
                tallies.entry(k.stage.clone()).or_default().fixed.insert(k.target.clone());
            }
        }
    }

    let mut rows: Vec<serde_json::Value> = tallies
        .into_iter()
        .map(|(stage, t)| {
            let fixed = t.fixed.difference(&t.acknowledged).count();
            serde_json::json!({ "stage": stage, "raised": t.raised.len(), "fixed": fixed, "acknowledged": t.acknowledged.len() })
        })
        .collect();
    let share = |r: &serde_json::Value| r["acknowledged"].as_f64().unwrap_or(0.0) / r["raised"].as_f64().unwrap_or(1.0).max(1.0);
    rows.sort_by(|a, b| share(b).total_cmp(&share(a)).then(b["raised"].as_u64().cmp(&a["raised"].as_u64())));
    Ok(Answer { findings: vec![], summary: format!("{} runs", runs.len()), data: Some(serde_json::Value::Array(rows)) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_fixed_and_acknowledged_findings_per_stage() {
        let ledger = [
            r#"{"at":"1","branch":"a","findings":[{"stage":"sql","target":"x"},{"stage":"sql","target":"y"},{"stage":"naming","target":"n"}]}"#,
            r#"{"at":"2","branch":"a","findings":[{"stage":"sql","target":"y"}],"acknowledged":[{"stage":"naming","target":"n"}]}"#,
            "{cut short",
        ]
        .join("\n");
        let request: Request = serde_json::from_value(serde_json::json!({
            "command": "stats",
            "options": { "ledger": ledger, "acknowledged": [{ "gate": "new-deps", "target": "yaml", "why": "w" }], "trailers": [{ "sha": "abc", "gate": "naming" }] }
        }))
        .unwrap();
        let rows = run(&request).unwrap().data.unwrap();
        let get = |stage: &str| rows.as_array().unwrap().iter().find(|r| r["stage"] == stage).unwrap().clone();
        assert_eq!(
            (get("sql")["raised"].as_u64(), get("sql")["fixed"].as_u64(), get("sql")["acknowledged"].as_u64()),
            (Some(2), Some(1), Some(0))
        );
        assert_eq!(
            (get("naming")["raised"].as_u64(), get("naming")["fixed"].as_u64(), get("naming")["acknowledged"].as_u64()),
            (Some(2), Some(0), Some(2))
        );
        let order: Vec<&str> = rows.as_array().unwrap().iter().map(|r| r["stage"].as_str().unwrap()).collect();
        assert_eq!(order, vec!["naming", "new-deps", "sql"]);
    }
}
