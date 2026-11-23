//! What a run touched and where its time went, from V8's own records: the coverage files NODE_V8_COVERAGE writes
//! (every function each process ran, with call counts) and the `.cpuprofile` files `--cpu-prof` writes (samples of
//! the stack every millisecond or so). Several runs are combined by median; runs on the base commit give the
//! baseline, and a function that got clearly slower is reported.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::{Answer, Finding, Request};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Run {
    #[serde(default)]
    coverage_dir: Option<String>,
    #[serde(default)]
    profile_dir: Option<String>,
    /// Profiles already in memory (taken over the inspector, one per request), as JSON text.
    #[serde(default)]
    profiles: Vec<serde_json::Value>,
    /// Coverage already in memory, as V8's `takePreciseCoverage` result lists.
    #[serde(default)]
    coverage: Vec<serde_json::Value>,
    #[serde(default)]
    wall_ms: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Options {
    #[serde(default)]
    runs: Vec<Run>,
    #[serde(default)]
    base_runs: Vec<Run>,
    /// A function is slower when it gained at least this many milliseconds of self time…
    #[serde(default = "default_min_ms")]
    min_ms: f64,
    /// …and at least this share of what it took on the base.
    #[serde(default = "default_min_share")]
    min_share: f64,
    /// The root of the base's worktree, so its paths read as the project's.
    #[serde(default)]
    base_root: Option<String>,
}

fn default_min_ms() -> f64 {
    20.0
}
fn default_min_share() -> f64 {
    0.25
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    file: String,
    name: String,
    line: u32,
    count: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hot {
    file: String,
    name: String,
    line: u32,
    self_ms: f64,
    total_ms: f64,
}

/// A script URL as a path under `root`, or the package it belongs to, or None for Node's own code.
enum Place {
    Project(String),
    Package(String),
}

fn place(url: &str, root: &Path) -> Option<Place> {
    let path = url.strip_prefix("file://")?;
    let path = PathBuf::from(percent_decode(path));
    if let Some(i) = path.to_string_lossy().rfind("node_modules/") {
        let rest = &path.to_string_lossy()[i + "node_modules/".len()..];
        let mut parts = rest.split('/');
        let first = parts.next().unwrap_or("");
        let name = if first.starts_with('@') { format!("{first}/{}", parts.next().unwrap_or("")) } else { first.to_string() };
        return Some(Place::Package(name));
    }
    let rel = path.strip_prefix(root).ok()?;
    Some(Place::Project(rel.to_string_lossy().replace('\\', "/")))
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn json_files(dir: &str, ext: &str) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == ext)).collect();
    paths.par_iter().filter_map(|p| serde_json::from_slice(&std::fs::read(p).ok()?).ok()).collect()
}

/// Line of a function in a file: from the offset when the file on disk is what ran, else where its name is defined.
fn line_of(root: &Path, file: &str, name: &str, offset: usize, cache: &mut HashMap<String, Option<String>>) -> u32 {
    let text = cache.entry(file.to_string()).or_insert_with(|| std::fs::read_to_string(root.join(file)).ok());
    let Some(text) = text else { return 0 };
    let transpiled = file.ends_with(".ts") || file.ends_with(".tsx") || file.ends_with(".jsx");
    let at = if !transpiled && offset <= text.len() {
        Some(offset)
    } else if !name.is_empty() {
        [format!("function {name}"), format!("{name} = "), format!("{name}("), format!("{name}: ")].iter().find_map(|needle| text.find(needle.as_str()))
    } else {
        None
    };
    at.map_or(0, |a| text[..a.min(text.len())].matches('\n').count() as u32 + 1)
}

/// Every project function a run called, with how often.
fn touched(run: &Run, root: &Path, cache: &mut HashMap<String, Option<String>>) -> Vec<Touched> {
    let mut docs: Vec<serde_json::Value> = run.coverage.clone();
    if let Some(dir) = &run.coverage_dir {
        docs.extend(json_files(dir, "json").into_iter().map(|d| d["result"].clone()));
    }
    let mut counts: HashMap<(String, String, usize), u64> = HashMap::new();
    for doc in docs {
        for script in doc.as_array().into_iter().flatten() {
            let Some(Place::Project(file)) = script["url"].as_str().and_then(|u| place(u, root)) else { continue };
            for f in script["functions"].as_array().into_iter().flatten() {
                let Some(range) = f["ranges"].as_array().and_then(|r| r.first()) else { continue };
                let count = range["count"].as_u64().unwrap_or(0);
                let name = f["functionName"].as_str().unwrap_or("").to_string();
                // The module's top level runs on import; it is not a function anyone called.
                if count == 0 || (name.is_empty() && range["startOffset"].as_u64() == Some(0)) {
                    continue;
                }
                *counts.entry((file.clone(), name, range["startOffset"].as_u64().unwrap_or(0) as usize)).or_default() += count;
            }
        }
    }
    let mut out: Vec<Touched> = counts
        .into_iter()
        .map(|((file, name, offset), count)| {
            let line = line_of(root, &file, &name, offset, cache);
            Touched { name: if name.is_empty() { "(anonymous)".into() } else { name }, file, line, count }
        })
        .collect();
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    out
}

/// Self and total milliseconds per function, and self milliseconds per package, across a run's profiles.
/// Self and total time per function (file, name, line), and self time per file.
type Timings = (HashMap<(String, String, u32), (f64, f64)>, HashMap<String, f64>);

fn timings(run: &Run, root: &Path) -> Timings {
    let mut profiles = run.profiles.clone();
    if let Some(dir) = &run.profile_dir {
        profiles.extend(json_files(dir, "cpuprofile"));
    }
    let mut per_fn: HashMap<(String, String, u32), (f64, f64)> = HashMap::new();
    let mut per_pkg: HashMap<String, f64> = HashMap::new();
    for p in profiles {
        let nodes = p["nodes"].as_array().cloned().unwrap_or_default();
        let index: HashMap<u64, usize> = nodes.iter().enumerate().filter_map(|(i, n)| Some((n["id"].as_u64()?, i))).collect();
        let mut self_us = vec![0f64; nodes.len()];
        let samples = p["samples"].as_array().cloned().unwrap_or_default();
        let deltas = p["timeDeltas"].as_array().cloned().unwrap_or_default();
        for (i, s) in samples.iter().enumerate() {
            // A sample's time is the gap to the next sample.
            let dt = deltas.get(i + 1).and_then(|d| d.as_f64()).unwrap_or(0.0).max(0.0);
            if let Some(&n) = s.as_u64().and_then(|id| index.get(&id)) {
                self_us[n] += dt;
            }
        }
        // Total time: a node's own plus its descendants'. Children come after parents' ids, so sum bottom up.
        let mut total_us = self_us.clone();
        let mut parent = vec![usize::MAX; nodes.len()];
        for (i, n) in nodes.iter().enumerate() {
            for c in n["children"].as_array().into_iter().flatten() {
                if let Some(&ci) = c.as_u64().and_then(|id| index.get(&id)) {
                    parent[ci] = i;
                }
            }
        }
        let mut order: Vec<usize> = (0..nodes.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(depth(i, &parent)));
        for &i in &order {
            if parent[i] != usize::MAX {
                total_us[parent[i]] += total_us[i];
            }
        }
        // A function that recurses appears on many nodes; count its total once per stack, at its outermost node.
        for (i, n) in nodes.iter().enumerate() {
            let frame = &n["callFrame"];
            let url = frame["url"].as_str().unwrap_or("");
            match place(url, root) {
                Some(Place::Project(file)) => {
                    let key = (file, frame["functionName"].as_str().unwrap_or("").to_string(), (frame["lineNumber"].as_i64().unwrap_or(-1).max(-1) + 1) as u32);
                    let outermost = !ancestors(i, &parent).any(|a| nodes[a]["callFrame"]["url"] == frame["url"] && nodes[a]["callFrame"]["functionName"] == frame["functionName"] && nodes[a]["callFrame"]["lineNumber"] == frame["lineNumber"]);
                    let e = per_fn.entry(key).or_default();
                    e.0 += self_us[i] / 1000.0;
                    if outermost {
                        e.1 += total_us[i] / 1000.0;
                    }
                }
                Some(Place::Package(name)) => *per_pkg.entry(name).or_default() += self_us[i] / 1000.0,
                None => {}
            }
        }
    }
    (per_fn, per_pkg)
}

fn depth(mut i: usize, parent: &[usize]) -> usize {
    let mut d = 0;
    while parent[i] != usize::MAX {
        i = parent[i];
        d += 1;
    }
    d
}

fn ancestors(i: usize, parent: &[usize]) -> impl Iterator<Item = usize> + '_ {
    std::iter::successors(Some(parent[i]).filter(|&p| p != usize::MAX), move |&p| Some(parent[p]).filter(|&q| q != usize::MAX))
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = v.len() / 2;
    if v.len().is_multiple_of(2) {
        (v[m - 1] + v[m]) / 2.0
    } else {
        v[m]
    }
}

/// Median self and total time per function over runs, with functions a run did not hit counted as zero.
fn combined(runs: &[Run], root: &Path) -> Timings {
    let all: Vec<_> = runs.par_iter().map(|r| timings(r, root)).collect();
    let keys: std::collections::HashSet<_> = all.iter().flat_map(|(f, _)| f.keys().cloned()).collect();
    let pkgs: std::collections::HashSet<_> = all.iter().flat_map(|(_, p)| p.keys().cloned()).collect();
    let per_fn = keys
        .into_iter()
        .map(|k| {
            let s = median(all.iter().map(|(f, _)| f.get(&k).map_or(0.0, |v| v.0)).collect());
            let t = median(all.iter().map(|(f, _)| f.get(&k).map_or(0.0, |v| v.1)).collect());
            (k, (s, t))
        })
        .collect();
    let per_pkg = pkgs.into_iter().map(|k| { let m = median(all.iter().map(|(_, p)| p.get(&k).copied().unwrap_or(0.0)).collect()); (k, m) }).collect();
    (per_fn, per_pkg)
}

/// The fastest and slowest self time of each function (by file and name) across runs, a run that missed it counting
/// as zero, and the fastest and slowest wall time.
type Spread = (HashMap<(String, String), (f64, f64)>, (f64, f64));

fn spread(runs: &[Run], root: &Path) -> Spread {
    // Per run, self time by file and name: lines move, and one name may have several frames.
    let all: Vec<HashMap<(String, String), f64>> = runs
        .par_iter()
        .map(|r| {
            let mut by_name: HashMap<(String, String), f64> = HashMap::new();
            for ((file, name, _), (self_ms, _)) in timings(r, root).0 {
                *by_name.entry((file, name)).or_default() += self_ms;
            }
            by_name
        })
        .collect();
    let mut out: HashMap<(String, String), (f64, f64)> = HashMap::new();
    for key in all.iter().flat_map(|m| m.keys()).cloned().collect::<std::collections::HashSet<_>>() {
        let range = all.iter().map(|m| m.get(&key).copied().unwrap_or(0.0)).fold((f64::INFINITY, 0.0), |(lo, hi): (f64, f64), v| (lo.min(v), hi.max(v)));
        out.insert(key, range);
    }
    let walls = runs.iter().map(|r| r.wall_ms).fold((f64::INFINITY, 0.0), |(lo, hi): (f64, f64), v| (lo.min(v), hi.max(v)));
    (out, walls)
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let options: Options = serde_json::from_value(request.options.clone()).map_err(|e| format!("trace options: {e}"))?;
    if options.runs.is_empty() {
        return Err("trace-report needs at least one run".into());
    }
    let root = PathBuf::from(&request.root);
    let mut cache = HashMap::new();
    let mut touched_all: HashMap<(String, String, u32), u64> = HashMap::new();
    for r in &options.runs {
        for t in touched(r, &root, &mut cache) {
            let count = touched_all.entry((t.file, t.name, t.line)).or_default();
            *count = (*count).max(t.count);
        }
    }
    let mut touched_list: Vec<Touched> = touched_all.into_iter().map(|((file, name, line), count)| Touched { file, name, line, count }).collect();
    touched_list.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    let (now, pkgs) = combined(&options.runs, &root);
    // An unnamed frame on a module's first line is the module's own top-level code.
    let label = |name: &str, line: u32| if !name.is_empty() { name.to_string() } else if line <= 1 { "(top level)".into() } else { "(anonymous)".into() };
    let mut hot: Vec<Hot> = now.iter().map(|((file, name, line), (s, t))| Hot { file: file.clone(), name: label(name, *line), line: *line, self_ms: round(*s), total_ms: round(*t) }).collect();
    hot.sort_by(|a, b| b.self_ms.partial_cmp(&a.self_ms).unwrap_or(std::cmp::Ordering::Equal));
    hot.truncate(50);
    let mut deps: Vec<(String, f64)> = pkgs.into_iter().map(|(k, v)| (k, round(v))).collect();
    deps.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    deps.truncate(15);
    let wall_now = median(options.runs.iter().map(|r| r.wall_ms).collect());
    let mut findings = Vec::new();
    let mut slower = Vec::new();
    let mut wall_base = 0.0;
    let mut inconclusive = Vec::new();
    let (now_spread, wall_range) = spread(&options.runs, &root);
    let mut base_wall_range = (0.0, 0.0);
    if !options.base_runs.is_empty() {
        let base_root = options.base_root.as_ref().map(PathBuf::from).unwrap_or_else(|| root.clone());
        let (base, _) = combined(&options.base_runs, &base_root);
        let (base_spread, base_walls) = spread(&options.base_runs, &base_root);
        base_wall_range = base_walls;
        // With two or more runs a side, a difference counts only when the ranges do not overlap: the fastest run now
        // is slower than the slowest run on the base. Otherwise the medians differ by noise as often as by code.
        let ranged = options.runs.len() >= 2 && options.base_runs.len() >= 2;
        wall_base = median(options.base_runs.iter().map(|r| r.wall_ms).collect());
        // Lines move between commits; a function is the same function by file and name.
        let base_by_name: HashMap<(&str, &str), f64> = base.iter().map(|((f, n, _), (s, _))| ((f.as_str(), n.as_str()), *s)).collect();
        for ((file, name, line), (s, _)) in &now {
            let before = base_by_name.get(&(file.as_str(), name.as_str())).copied().unwrap_or(0.0);
            if name.is_empty() || !file.starts_with(&request.prefix) {
                continue;
            }
            if s - before >= options.min_ms && (before == 0.0 || (s - before) / before >= options.min_share) {
                let key = (file.clone(), name.clone());
                let fastest_now = now_spread.get(&key).map_or(*s, |r| r.0);
                let slowest_base = base_spread.get(&key).map_or(before, |r| r.1);
                if ranged && fastest_now <= slowest_base {
                    inconclusive.push(serde_json::json!({ "file": file, "name": name, "line": line, "baseMs": round(before), "nowMs": round(*s), "nowFastestMs": round(fastest_now), "baseSlowestMs": round(slowest_base) }));
                    continue;
                }
                slower.push(serde_json::json!({ "file": file, "name": name, "line": line, "baseMs": round(before), "nowMs": round(*s) }));
                let was = if before >= 1.0 { format!("{before:.0}ms on the base (+{:.0}%)", (s - before) / before * 100.0) } else { "under 1ms on the base".into() };
                findings.push(Finding {
                    file: file.clone(),
                    line: *line,
                    target: format!("{file}:slower:{name}"),
                    message: format!("{file}:{line} {name} takes {s:.0}ms of its own time, {was}: profile it with `intersite trace` and look at what it now does per call"),
                });
            }
        }
        findings.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    }
    let data = serde_json::json!({
        "touched": touched_list,
        "hot": hot,
        "dependencies": deps.iter().map(|(n, ms)| serde_json::json!({ "name": n, "selfMs": ms })).collect::<Vec<_>>(),
        "slower": slower,
        "inconclusive": inconclusive,
        "wallMs": round(wall_now),
        "wallRange": [round(wall_range.0), round(wall_range.1)],
        "baseWallMs": round(wall_base),
        "baseWallRange": [round(base_wall_range.0), round(base_wall_range.1)],
    });
    let summary = format!("{} project functions touched; {} runs", data["touched"].as_array().map_or(0, |a| a.len()), options.runs.len());
    Ok(Answer { findings, summary, data: Some(data) })
}

fn round(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_profiles_and_coverage_and_finds_slowdowns() {
        let root = std::env::temp_dir().join(format!("intersite-trace-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.js"), "function slow() {}\nfunction fast() {}\n").unwrap();
        let url = format!("file://{}/src/a.js", root.display());
        let profile = |slow_us: f64| serde_json::json!({
            "nodes": [
                { "id": 1, "callFrame": { "functionName": "(root)", "url": "", "lineNumber": -1 }, "children": [2, 3] },
                { "id": 2, "callFrame": { "functionName": "slow", "url": url, "lineNumber": 0 }, "children": [] },
                { "id": 3, "callFrame": { "functionName": "fast", "url": url, "lineNumber": 1 }, "children": [] }
            ],
            "samples": [2, 3, 2],
            "timeDeltas": [0, slow_us, 1000.0, 0]
        });
        let coverage = serde_json::json!([{ "url": url, "functions": [
            { "functionName": "slow", "ranges": [{ "startOffset": 0, "endOffset": 18, "count": 3 }] },
            { "functionName": "fast", "ranges": [{ "startOffset": 19, "endOffset": 37, "count": 0 }] }
        ] }]);
        let request = Request {
            command: "trace-report".into(),
            root: root.to_string_lossy().into(),
            files: vec![],
            added: None,
            prefix: String::new(),
            database_url: None,
            options: serde_json::json!({
                "runs": [{ "profiles": [profile(100_000.0)], "coverage": [coverage], "wallMs": 200 }],
                "baseRuns": [{ "profiles": [profile(5_000.0)], "wallMs": 50 }]
            }),
        };
        let answer = run(&request).unwrap();
        let data = answer.data.unwrap();
        assert_eq!(data["touched"][0]["name"], "slow");
        assert_eq!(data["touched"].as_array().unwrap().len(), 1);
        assert_eq!(data["hot"][0]["name"], "slow");
        assert_eq!(answer.findings.len(), 1);
        assert!(answer.findings[0].message.starts_with("src/a.js:1 slow takes 100ms of its own time, 5ms on the base (+1900%)"), "{}", answer.findings[0].message);
    }
}
