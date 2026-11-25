//! What a failed test run proves. A run that stopped on a failed assertion (or a runner's own per-test timeout, or an
//! error the code threw) is evidence about the code; one that never got that far is not: the code did not compile or
//! load, a dependency or the command is missing, the machine or a service failed, or Intersite stopped it at its
//! time limit. `fails-on-base` and `mutation` count only the first kind, so a test that cannot even run on the base
//! never proves a fix, and a mutant that breaks the build is invalid, not killed.

use regex::Regex;
use std::sync::LazyLock;

use crate::{Answer, Request};

/// A failure the tests themselves report. Checked first: a runner that prints `FAIL` for a file that did not load also
/// prints the load error, but a real assertion failure is never only a load error.
static ASSERTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"AssertionError|AssertionFailedError|ComparisonFailure|expect\(received\)|(?m)^\s*(?:Expected|Received)(?: value)?:|XCTAssert\w* failed|assertion failed|panicked at|Test timed out in \d+|Exceeded timeout of \d+|test timed out after \d+|Timeout of \d+ms exceeded|testTimeoutFailure").unwrap()
});
/// The code did not compile or load: a type error from a compiling runner, a syntax error, an import that names
/// something not there.
static COMPILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"error TS\d{4}:|SyntaxError|Transform failed with \d+ error|Failed to (?:load url|parse source|resolve import)|does not provide an export named|Cannot find module '\.\.?/|ERR_MODULE_NOT_FOUND[^\n]*'\.\.?/|Module not found: Error: Can't resolve '\.\.?/|error\[E\d{4}\]|error: cannot find '\w+' in scope").unwrap()
});
/// The run could not start or the machine failed it: a missing command, script or package, a service not running, no
/// memory or disk.
static SETUP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"command not found|: not found\b|is not recognized as an internal or external command|Missing script:|Cannot find (?:package|module) '[^'./][^']*'|ERR_MODULE_NOT_FOUND|Module not found: Error: Can't resolve '[^'./]|ECONNREFUSED|EADDRINUSE|ENOTFOUND|getaddrinfo|heap out of memory|ENOMEM|ENOSPC").unwrap()
});

/// One run's kind: `pass`, `fail` (evidence), or `compile`, `setup`, `timeout` (no evidence), with the line that says
/// why for the last three.
pub fn classify(output: &str, code: Option<i64>, timed_out: bool) -> (&'static str, String) {
    if timed_out {
        return ("timeout", String::new());
    }
    if code == Some(0) {
        return ("pass", String::new());
    }
    if ASSERTED.is_match(output) {
        return ("fail", String::new());
    }
    let line = |re: &Regex| output.lines().find(|l| re.is_match(l)).map(|l| l.trim().chars().take(160).collect()).unwrap_or_default();
    if COMPILE.is_match(output) {
        return ("compile", line(&COMPILE));
    }
    if code == Some(127) || SETUP.is_match(output) {
        return ("setup", line(&SETUP));
    }
    // Killed by a signal Intersite did not send: the machine stopped it (out of memory, a crash), not a test.
    if code.is_none() {
        return ("setup", "stopped by a signal".to_string());
    }
    // Any other failure is an error the code threw or a runner's own verdict: evidence.
    ("fail", String::new())
}

/// The test files a run's output names as failing, from `expect` (paths relative to where the tests ran): when the
/// output names test files and none of them is one of these, the failure is somewhere else.
fn elsewhere(output: &str, expect: &[String]) -> Option<String> {
    static TEST_FILE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\w./-]*?[\w-]+(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py)|Tests?\.swift)\b").unwrap());
    // Only lines that report a failure: a runner names the files that passed too.
    static FAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"✖|×|✗|❯|\bFAIL|not ok|(?i:fail)|Error|^\s*at ").unwrap());
    let named: Vec<&str> =
        output.lines().filter(|l| FAILING.is_match(l)).flat_map(|l| TEST_FILE.find_iter(l).map(|m| m.as_str())).collect();
    if named.is_empty() || expect.is_empty() {
        return None;
    }
    let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    let wanted: Vec<String> = expect.iter().map(|p| base(p)).collect();
    if named.iter().any(|n| wanted.contains(&base(n))) {
        return None;
    }
    Some(named[0].to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// What the test command printed.
    output: String,
    /// Its exit code; none when a signal ended it.
    code: Option<i64>,
    timed_out: bool,
    /// The tests the run was expected to fail in; only fails-on-base names them.
    #[serde(default)]
    expect: Vec<String>,
}

/// `{ output, code, timedOut, expect? }` → `data: { kind, why, elsewhere? }`.
pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { output, code, timed_out, expect } = request.options()?;
    let (kind, why) = classify(&output, code, timed_out);
    let other = if kind == "fail" { elsewhere(&output, &expect) } else { None };
    Ok(Answer { findings: vec![], summary: String::new(), data: Some(serde_json::json!({ "kind": kind, "why": why, "elsewhere": other })) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_assertion_is_evidence_and_a_load_error_is_not() {
        assert_eq!(classify("not ok 1 - adds\n  AssertionError [ERR_ASSERTION]: 0 == 4", Some(1), false).0, "fail");
        assert_eq!(classify(" FAIL  test/a.test.ts > adds\nAssertionError: expected 0 to be 4", Some(1), false).0, "fail");
        assert_eq!(classify("expect(received).toBe(expected)\n\nExpected: 4\nReceived: 0", Some(1), false).0, "fail");
        assert_eq!(classify("Error: Test timed out in 5000ms.", Some(1), false).0, "fail");
        assert_eq!(
            classify("TypeError: Cannot read properties of undefined (reading 'id')\n    at test/a.test.ts:4:9", Some(1), false).0,
            "fail"
        );
        let (kind, why) = classify(" FAIL  test/a.test.ts [ test/a.test.ts ]\nSyntaxError: The requested module '../add.mjs' does not provide an export named 'add'", Some(1), false);
        assert_eq!(
            (kind, why.as_str()),
            ("compile", "SyntaxError: The requested module '../add.mjs' does not provide an export named 'add'")
        );
        assert_eq!(classify("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", Some(2), false).0, "compile");
        assert_eq!(classify("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /x/a.mjs", Some(1), false).0, "setup");
        assert_eq!(classify("sh: vitest: command not found", Some(127), false).0, "setup");
        assert_eq!(classify("npm error Missing script: \"test\"", Some(1), false).0, "setup");
        assert_eq!(classify("connect ECONNREFUSED 127.0.0.1:5432", Some(1), false).0, "setup");
        assert_eq!(classify("", None, false).0, "setup");
        assert_eq!(classify("anything", Some(1), true).0, "timeout");
        assert_eq!(classify("anything", Some(0), false).0, "pass");
    }

    #[test]
    fn a_failure_in_a_test_file_the_change_did_not_touch_is_elsewhere() {
        let out = " FAIL  test/other.test.ts > flaky\nAssertionError: expected 1 to be 2";
        assert_eq!(elsewhere(out, &["test/add.test.ts".into()]).as_deref(), Some("test/other.test.ts"));
        assert_eq!(elsewhere(" FAIL  test/add.test.ts > adds", &["test/add.test.ts".into()]), None);
        assert_eq!(elsewhere("not ok 1 - adds\nAssertionError", &["test/add.test.mjs".into()]), None);
        let spec = "✔ test/add.test.mjs (37ms)\ntest at test/flaky.test.mjs:1:1\n✖ test/flaky.test.mjs (37ms)";
        assert_eq!(elsewhere(spec, &["test/add.test.mjs".into()]).as_deref(), Some("test/flaky.test.mjs"));
    }
}
