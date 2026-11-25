//! What the npm registry knows about a package a change adds: whether it exists, how many versions it has, and when
//! it was first published. An invented name (an LLM's guess) does not exist yet, and anyone can register it later
//! with malware; a days-old package with one version is worth a second look. Any network trouble means "unknown",
//! never a failure.

use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub enum Known {
    Missing,
    Found { versions: usize, days: Option<u64> },
}

/// Full documents are fetched only for packages with few versions: a popular package's runs to megabytes.
const FEW_VERSIONS: usize = 30;

/// Days since 1970-01-01 of an ISO date (`2024-05-01T…`), by the civil-from-days inverse (Howard Hinnant).
fn epoch_days(iso: &str) -> Option<i64> {
    let (y, m, d): (i64, i64, i64) = (iso.get(0..4)?.parse().ok()?, iso.get(5..7)?.parse().ok()?, iso.get(8..10)?.parse().ok()?);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

fn get(agent: &ureq::Agent, url: &str, abbreviated: bool) -> Result<serde_json::Value, Option<()>> {
    let request = agent.get(url);
    let request = if abbreviated { request.set("Accept", "application/vnd.npm.install-v1+json") } else { request };
    match request.call() {
        Ok(response) => response.into_json().map_err(|_| Some(())),
        Err(ureq::Error::Status(404, _)) => Err(None),
        Err(_) => Err(Some(())),
    }
}

fn lookup(agent: &ureq::Agent, registry: &str, name: &str, today: i64) -> Option<Known> {
    let url = format!("{}/{}", registry.trim_end_matches('/'), name.replace('/', "%2F"));
    let doc = match get(agent, &url, true) {
        Ok(doc) => doc,
        Err(None) => return Some(Known::Missing),
        Err(Some(())) => return None,
    };
    let versions = doc["versions"].as_object().map_or(0, |v| v.len());
    let days = if versions <= FEW_VERSIONS {
        get(agent, &url, false)
            .ok()
            .and_then(|full| full["time"]["created"].as_str().and_then(epoch_days))
            .map(|d| (today - d).max(0) as u64)
    } else {
        None
    };
    Some(Known::Found { versions, days })
}

/// The registry's answer for each name it could answer for, asked in parallel. An empty registry asks nothing.
pub fn lookup_all(registry: &str, names: &[String]) -> HashMap<String, Known> {
    if registry.is_empty() || names.is_empty() {
        return HashMap::new();
    }
    let Ok(tls) = native_tls::TlsConnector::new() else { return HashMap::new() };
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(4)).tls_connector(Arc::new(tls)).build();
    let today = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64 / 86_400);
    names.par_iter().with_max_len(1).filter_map(|name| Some((name.clone(), lookup(&agent, registry, name, today)?))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_count_days_from_the_epoch() {
        assert_eq!(epoch_days("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(epoch_days("2000-03-01T00:00:00Z"), Some(11017));
        assert_eq!(epoch_days("2024-02-29"), Some(19782));
        assert_eq!(epoch_days("nope"), None);
    }
}
