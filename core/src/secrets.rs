//! The secrets check: credentials a change adds to any text file (code, env files, YAML, JSON, Markdown, shell,
//! Dockerfiles, Terraform, notebooks), env files committed with real secret values, and private key files.
//! Only token formats with a recognisable shape count, placeholders never do, and the secret is never printed.

use rayon::prelude::*;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::text;
use crate::{Answer, Finding, Request};

/// A credential format: its name, its pattern, and whether lint's `no-hardcoded-secret` already reports it in a
/// JavaScript or TypeScript string (those lines are lint's, not this gate's).
struct Kind {
    name: &'static str,
    re: Regex,
    lint: bool,
}

static KINDS: LazyLock<Vec<Kind>> = LazyLock::new(|| {
    let k = |name, re: &str, lint| Kind { name, re: Regex::new(re).unwrap(), lint };
    vec![
        k("Stripe live key", r"\b(?:sk|rk)_live_[0-9A-Za-z]{16,}", true),
        k("Stripe webhook secret", r"\bwhsec_[0-9A-Za-z+/=]{24,}", true),
        k("GitHub token", r"\b(?:gh[pousr]_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{40,})", true),
        k("GitLab token", r"\bglpat-[0-9A-Za-z_-]{20,}", true),
        k("AWS access key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", true),
        k("Slack token", r"\bxox[abposr]-[0-9A-Za-z-]{20,}", true),
        k("Slack webhook", r"hooks\.slack\.com/services/T[0-9A-Z]{6,}/B[0-9A-Z]{6,}/[0-9A-Za-z]{20,}", true),
        k("Anthropic key", r"\bsk-ant-[0-9A-Za-z_-]{20,}", true),
        k("OpenAI key", r"\bsk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{20,}|\bsk-[0-9A-Za-z]{20}T3BlbkFJ[0-9A-Za-z]{20}", true),
        k("OpenRouter key", r"\bsk-or-v1-[0-9a-f]{64}\b", false),
        k("SendGrid key", r"\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}", true),
        k("Supabase secret key", r"\bsb_secret_[0-9A-Za-z_-]{20,}", true),
        k("Supabase access token", r"\bsbp_[0-9a-f]{40}\b", false),
        k("npm token", r"\bnpm_[0-9A-Za-z]{36}\b", true),
        k("Twilio API key", r"\bSK[0-9a-fA-F]{32}\b", false),
        k("Shopify token", r"\bshp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}\b", false),
        k("Hugging Face token", r"\bhf_[A-Za-z]{34}\b", false),
        k("Linear key", r"\blin_api_[0-9A-Za-z]{40}\b", false),
        k("PlanetScale token", r"\bpscale_(?:tkn|pw|oauth)_[0-9A-Za-z_.-]{32,}", false),
        k("Groq key", r"\bgsk_[0-9A-Za-z]{52}\b", false),
        k("xAI key", r"\bxai-[0-9A-Za-z]{80}\b", false),
        k("Replicate token", r"\br8_[0-9A-Za-z]{37}\b", false),
        k("private key", r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:\s|\\[nr])*[A-Za-z0-9+/=]{40}", true),
    ]
});

/// A connection URL with an inline password: scheme, password and host, judged in `db_password`.
static DB_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?)://[^:/\s@]+:([^@\s/]+)@([^:/\s?#]+)").unwrap()
});
/// Hosts on the developer's machine or a compose network: their passwords guard nothing.
const LOCAL_HOSTS: [&str; 13] = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "host",
    "host.docker.internal",
    "db",
    "database",
    "postgres",
    "postgresql",
    "mysql",
    "redis",
    "mongo",
    "mongodb",
];

/// Whether a URL's password is real: eight characters or more with letters and digits, no variable, a remote host.
fn db_password(password: &str, host: &str) -> bool {
    password.len() >= 8
        && password.chars().any(|c| c.is_ascii_digit())
        && password.chars().any(|c| c.is_ascii_alphabetic())
        && !password.contains('$')
        && !LOCAL_HOSTS.contains(&host)
        && !placeholder(password)
}

/// A JSON Web Token; its payload is decoded to see whether it is a Supabase service-role key.
static JWT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{20,}").unwrap());
/// Text that marks a value as a stand-in, not a credential.
static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)x{6}|\*{4}|\.\.\.|your[-_ ]?|replace|placeholder|dummy|fake|redacted|example|sample|changeme|<[^>]*>|\$\{|\{\{|0{10}|1234567890|abcdef").unwrap()
});
/// Lockfiles and caches hold hashes, never credentials someone typed.
static NEVER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:node_modules|dist|build|out|vendor|coverage|\.next|\.turbo)/|(?:^|/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|Package\.resolved|go\.sum)$|\.min\.|\.map$").unwrap()
});
/// Tests, fixtures and mocks hold realistic fakes on purpose.
static FAKES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:tests?|__tests__|spec|fixtures?|__fixtures__|mocks?|__mocks__|testdata|stories|storybook)/").unwrap()
});
static JS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?[jt]sx?$").unwrap());
/// Files that are a private key whatever they hold: keystores and SSH identities.
static KEY_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:p12|pfx|jks))$").unwrap());
/// An env file: `.env`, `.env.local`, `.env.production`, `prod.env`, `.dev.vars`; templates are meant to be committed.
static ENV_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:\.env(?:\.[\w.-]+)?|[\w.-]+\.env|\.dev\.vars)$").unwrap());
static ENV_TEMPLATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)example|sample|template|dist|schema|defaults|\.test$|\.ci$").unwrap());
/// `KEY=value` in an env file, the value unquoted.
static ENV_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'#\s]*)"#).unwrap());
static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|API_?KEY|_KEY$|ACCESS_KEY|CREDENTIAL|DATABASE_URL|DB_URL|CONNECTION_STRING|DSN$")
        .unwrap()
});
static PUBLIC_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|REACT_APP|GATSBY|NUXT_PUBLIC)_|PUBLISHABLE|ANON|PUBLIC_KEY|CLIENT_ID|SITE_KEY")
        .unwrap()
});
/// Values that point at a secret store instead of holding the secret.
static REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:op|vault|sm|gcp|aws|azure|doppler|infisical)://|^\$|localhost|127\.0\.0\.1").unwrap());

/// Whether a matched credential is a stand-in: placeholder words, or too few distinct characters to be random.
fn placeholder(token: &str) -> bool {
    let body = token.rsplit(['_', '-', '.', ':', '/']).find(|p| p.len() >= 8).unwrap_or(token);
    PLACEHOLDER.is_match(token) || body.chars().collect::<HashSet<_>>().len() < 8
}

/// The first characters of a secret, enough to find it, never enough to use it.
fn masked(token: &str) -> String {
    let shown: String = token.chars().take(8.min(token.chars().count() / 3)).collect();
    format!("{shown}…")
}

/// Decodes base64url without padding; None on a character outside the alphabet.
fn base64url(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for &c in text.as_bytes() {
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Whether a JWT's payload says it is a Supabase service-role key (which skips row-level security). The local stack's
/// demo keys, issued by `supabase-demo`, are public.
fn service_role(payload: &str) -> bool {
    let Some(json) = base64url(payload).and_then(|b| String::from_utf8(b).ok()) else { return false };
    let compact: String = json.chars().filter(|c| !c.is_whitespace()).collect();
    compact.contains("\"role\":\"service_role\"") && !compact.contains("supabase-demo")
}

/// Credentials on one line: (kind, the matched text).
fn scan_line(line: &str, js: bool) -> Vec<(&'static str, &str)> {
    let mut out = Vec::new();
    for kind in KINDS.iter() {
        if js && kind.lint {
            continue;
        }
        for m in kind.re.find_iter(line) {
            if !placeholder(m.as_str()) {
                out.push((kind.name, m.as_str()));
            }
        }
    }
    if !js {
        for c in DB_URL.captures_iter(line) {
            if db_password(&c[1], &c[2]) {
                out.push(("database URL with a password", c.get(0).unwrap().as_str()));
            }
        }
    }
    for c in JWT.captures_iter(line) {
        if service_role(&c[1]) {
            out.push(("Supabase service-role key", c.get(0).unwrap().as_str()));
        }
    }
    out
}

/// A secret-named variable an env file sets to a real value: (name, value).
fn env_secret(line: &str) -> Option<(String, String)> {
    let c = ENV_LINE.captures(line)?;
    let (name, value) = (c[1].to_string(), c[2].to_string());
    let real = value.len() >= 12 && !placeholder(&value) && !REFERENCE.is_match(&value);
    (SECRET_NAME.is_match(&name) && !PUBLIC_NAME.is_match(&name) && real).then_some((name, value))
}

const ADVICE: &str = "remove it and rotate it, because a secret that reached git (or a pushed branch) is leaked; read it from an environment variable or secret store. Do not just move it to another tracked file";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// Files new to git (every file, judging the whole repository), where a key file is reported.
    fresh: HashSet<String>,
    /// Files under the test paths, whose secrets are fixtures.
    fakes: HashSet<String>,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { fresh, fakes } = request.options()?;
    let files: Vec<&String> = request.files.iter().filter(|f| !NEVER.is_match(f) && !FAKES.is_match(f) && !fakes.contains(*f)).collect();
    let mut findings: Vec<Finding> = files
        .par_iter()
        .flat_map_iter(|file| {
            let mut out = Vec::new();
            if KEY_FILE.is_match(file) && fresh.contains(*file) && !file.ends_with("debug.keystore") {
                out.push(Finding {
                    file: file.to_string(),
                    line: 0,
                    target: format!("secrets:{file}"),
                    message: format!("{file} is a private key file: {ADVICE}"),
                });
                return out;
            }
            let Some(src) = text::read(&request.root, file) else { return out };
            let js = JS.is_match(file);
            let name = file.rsplit('/').next().unwrap_or(file);
            let env = ENV_FILE.is_match(file) && !ENV_TEMPLATE.is_match(name);
            let mut seen = HashSet::new();
            for (i, line) in src.lines().enumerate() {
                let n = i as u32 + 1;
                if !request.changed(file, n) {
                    continue;
                }
                let mut hits: Vec<(String, String)> = scan_line(line, js).into_iter().map(|(k, t)| (k.to_string(), masked(t))).collect();
                if env && hits.is_empty() {
                    if let Some((var, value)) = env_secret(line) {
                        hits.push((format!("{var} set in a committed env file"), masked(&value)));
                    }
                }
                for (kind, shown) in hits {
                    if seen.insert(kind.clone()) {
                        out.push(Finding {
                            file: file.to_string(),
                            line: n,
                            target: format!("secrets:{file}:{kind}"),
                            message: format!("{file}:{n} {kind} ({shown}): {ADVICE}"),
                        });
                    }
                }
            }
            out
        })
        .collect();
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    Ok(Answer::new(findings, format!("{} files checked for credentials", files.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(line: &str, js: bool) -> Vec<&'static str> {
        scan_line(line, js).into_iter().map(|(k, _)| k).collect()
    }

    #[test]
    fn finds_credentials_and_skips_placeholders() {
        let stripe = format!("STRIPE_KEY={}{}", "sk_live_", "51HxQ2bLk8dPq3RtY7uVw9ZaB");
        assert_eq!(kinds(&stripe, false), vec!["Stripe live key"]);
        assert!(kinds(&stripe, true).is_empty(), "lint reports it in JavaScript");
        assert!(kinds("key: sk_live_xxxxxxxxxxxxxxxxxxxxxxxx", false).is_empty());
        assert!(kinds(&format!("aws_access_key_id = {}", "AKIAIOSFODNN7EXAMPLE"), false).is_empty());
        assert!(kinds("token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false).is_empty());
        assert_eq!(kinds(&format!("  token: {}{}", "ghp_", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"), false), vec!["GitHub token"]);
        assert_eq!(
            kinds(&format!("DATABASE_URL=postgres://admin:{}@db.prod.acme.io:5432/app", "S3cr3tPassw0rd"), false),
            vec!["database URL with a password"]
        );
        assert!(kinds("DATABASE_URL=postgres://postgres:postgres1@localhost:5432/dev", false).is_empty());
        assert!(kinds("url: postgres://app:s3cretpass1@db:5432/app", false).is_empty(), "a compose service is local");
    }

    #[test]
    fn a_service_role_jwt_counts_and_an_anon_one_does_not() {
        let enc = |s: &str| {
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let b = s.as_bytes();
            let mut out = String::new();
            for chunk in b.chunks(3) {
                let n = chunk.iter().fold(0u32, |a, &c| (a << 8) | c as u32) << (8 * (3 - chunk.len()));
                for i in 0..=chunk.len() {
                    out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            out
        };
        let jwt = |payload: &str| {
            format!("SUPABASE_KEY={}.{}.{}", enc(r#"{"alg":"HS256","typ":"JWT"}"#), enc(payload), "Zm9vYmFyYmF6cXV4cXV1eHF1dXg")
        };
        assert_eq!(
            kinds(&jwt(r#"{"iss":"supabase","ref":"abcd","role":"service_role","iat":1700000000}"#), true),
            vec!["Supabase service-role key"]
        );
        assert!(kinds(&jwt(r#"{"iss":"supabase","ref":"abcd","role":"anon","iat":1700000000}"#), true).is_empty());
        assert!(kinds(&jwt(r#"{"iss":"supabase-demo","role":"service_role","exp":1983812996}"#), true).is_empty());
    }

    #[test]
    fn env_files_with_real_secret_values() {
        assert_eq!(env_secret("JWT_SECRET=9fK2LmQp7RtXv3NbZc8Yd").map(|(n, _)| n), Some("JWT_SECRET".into()));
        assert!(env_secret("NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9abcdef1").is_none());
        assert!(env_secret("API_KEY=your-api-key-here").is_none());
        assert!(env_secret("DATABASE_URL=postgres://postgres:postgres@localhost:5432/app").is_none());
        assert!(env_secret("PORT=3000").is_none());
        assert!(env_secret("STRIPE_SECRET_KEY=").is_none());
    }
}
