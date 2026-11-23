//! The boundaries check: imports that cross a line the project draws. A relative path into another workspace
//! package, a workspace package used but not declared, a new barrel file, server-only code pulled into a
//! `"use client"` module, and (when configured) an import against the declared layers or between features.

use regex::Regex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;

use crate::graph::{self, Graph, Kind, Module, Package, Target};
use crate::{rel, Answer, Finding, Request};

static FIXTURE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:__)?(?:test[-_])?fixtures?(?:__)?/|(?:^|/)(?:testdata|examples?|templates?)/").unwrap());
/// Tests, scripts, configs and tooling: they may reach into a sibling package's files, the product may not.
static TOOLING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:scripts?|tests?|__tests__|e2e|qa|lint|tools?|bench(?:marks?)?|load-tests?|[\w-]*acceptance|stories|storybook|\.storybook)/|\.(?:test|spec|stories|config)\.[cm]?[jt]sx?$|(?:^|/)(?:babel|metro)\.config\.").unwrap()
});
static INDEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)index\.(?:ts|tsx|js|jsx|mjs|mts)$").unwrap());
/// Folders a package builds into: an entry `dist/x.js` was written from `src/x.ts`.
static BUILT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\./)?(?:dist|build|lib|out|esm|cjs|src)/").unwrap());

/// Packages that only work on a server: database drivers and ORMs, secrets-holding SDKs, Node's system modules.
const SERVER_PACKAGES: [&str; 33] = [
    "server-only", "@prisma/client", "prisma", "pg", "postgres", "mysql", "mysql2", "better-sqlite3", "sqlite3", "mongodb", "mongoose", "ioredis", "redis", "firebase-admin", "stripe", "resend", "nodemailer", "@sendgrid/mail", "bcrypt", "argon2", "@node-rs/argon2", "@node-rs/bcrypt", "jsonwebtoken", "twilio", "openai", "@anthropic-ai/sdk", "googleapis", "@neondatabase/serverless", "@vercel/postgres", "@planetscale/database", "@clerk/backend", "drizzle-kit", "knex",
];
const SERVER_PREFIXES: [&str; 6] = ["@aws-sdk/", "@google-cloud/", "drizzle-orm/node-postgres", "drizzle-orm/postgres-js", "drizzle-orm/mysql2", "drizzle-orm/better-sqlite3"];
const SERVER_SPECS: [&str; 3] = ["next/headers", "@clerk/nextjs/server", "next/server"];
/// Node modules a browser bundle has no stand-in for (Next.js polyfills path, crypto, buffer and the like).
const NODE_ONLY: [&str; 13] = ["fs", "fs/promises", "child_process", "net", "tls", "dgram", "dns", "cluster", "worker_threads", "readline", "module", "v8", "inspector"];

fn server_import(spec: &str) -> bool {
    let package = graph::package_name(spec);
    SERVER_PACKAGES.contains(&package) || SERVER_PREFIXES.iter().any(|p| spec.starts_with(p)) || SERVER_SPECS.contains(&spec) || spec.starts_with("node:") || NODE_ONLY.contains(&spec)
}

/// Why a module is server-only, if it is: a server package imported, or a secret read when it loads.
fn server_reason(m: &Module) -> Option<String> {
    if m.server {
        return None;
    }
    if let Some(i) = m.imports.iter().find(|i| !i.erased() && server_import(&i.spec)) {
        return Some(format!("imports {}", i.spec));
    }
    // `process.env.NEXT_PUBLIC_X || process.env.X` falls back to the server's copy on purpose.
    (!m.env_module).then(|| m.env.iter().find(|(name, _)| !m.public_env.contains(name)).map(|(name, _)| format!("reads {name}"))).flatten()
}

/// The package a file belongs to: the nearest package.json above it.
fn package_of<'g>(graph: &'g Graph, file: &str) -> Option<&'g Package> {
    graph.packages_of(file).into_iter().find(|p| !FIXTURE.is_match(&format!("{}/", p.dir)))
}

fn no_ext(path: &str) -> &str {
    let name = path.rfind('/').map_or(0, |i| i + 1);
    match path[name..].find('.') {
        Some(i) if i > 0 => &path[..name + i],
        _ => path,
    }
}

/// Whether an index file is what its package publishes: a package entry, or a folder an `exports` subpath names.
fn is_entry(graph: &Graph, file: &str, entry_globs: &[Regex], prefix: &str) -> bool {
    if entry_globs.iter().any(|g| g.is_match(file.strip_prefix(prefix).unwrap_or(file))) {
        return true;
    }
    let Some(p) = package_of(graph, file) else { return false };
    let inside = if p.dir.is_empty() { file } else { &file[p.dir.len() + 1..] };
    let short = BUILT.replace(inside, "");
    if no_ext(&short) == "index" {
        return true;
    }
    p.entries.iter().any(|e| {
        let e = if p.dir.is_empty() { e.as_str() } else { e.strip_prefix(&format!("{}/", p.dir)).unwrap_or(e) };
        let e = BUILT.replace(e, "");
        no_ext(&e) == no_ext(&short) || format!("{}/index", no_ext(&e)) == no_ext(&short)
    })
}

struct Layers {
    layers: Vec<(String, Vec<Regex>)>,
    features: Option<Regex>,
}

impl Layers {
    fn read(options: &serde_json::Value) -> Layers {
        let layers = options["layers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| Some((l["name"].as_str()?.to_string(), l["paths"].as_array()?.iter().filter_map(|g| graph::glob(g.as_str()?)).collect())))
            .collect();
        let features = options["features"].as_str().and_then(|f| {
            let pattern = graph::glob(f)?.as_str().trim_end_matches('$').replacen("[^/]*", "([^/]+)", 1);
            Regex::new(&format!("{pattern}(?:/|$)")).ok()
        });
        Layers { layers, features }
    }

    fn layer(&self, path: &str) -> Option<usize> {
        self.layers.iter().position(|(_, globs)| globs.iter().any(|g| g.is_match(path)))
    }

    fn feature<'p>(&self, path: &'p str) -> Option<&'p str> {
        self.features.as_ref()?.captures(path).and_then(|c| c.get(1)).map(|m| m.as_str())
    }
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let graph = Graph::build(&request.root, &request.files);
    let o = &request.options;
    let fresh: HashSet<String> = serde_json::from_value(o["fresh"].clone()).unwrap_or_default();
    let entry_globs: Vec<Regex> = o["entryPaths"].as_array().into_iter().flatten().filter_map(|g| graph::glob(g.as_str()?)).collect();
    let layers = Layers::read(o);
    let prefix = request.prefix.as_str();
    let mut findings = Vec::new();
    let mut project: Vec<&String> = graph.modules.keys().filter(|f| f.starts_with(prefix) && !f.ends_with(".d.ts") && !FIXTURE.is_match(f)).collect();
    project.sort();
    let edge_count: usize = project.iter().map(|f| graph.modules[*f].imports.len()).sum();

    // 1-2, 5: one import at a time.
    for file in &project {
        let m = &graph.modules[*file];
        let name = rel(prefix, file);
        let own = package_of(&graph, file);
        for (i, import) in m.imports.iter().enumerate() {
            if !request.changed(file, import.line) {
                continue;
            }
            let target = &graph.targets[*file][i];
            let spec = &import.spec;
            if let (Target::File(t), Some(own)) = (target, own) {
                let theirs = package_of(&graph, t);
                if spec.starts_with('.') && !own.dir.is_empty() && !TOOLING.is_match(file) && graph::CODE.is_match(t) {
                    if let Some(theirs) = theirs.filter(|p| p.name.is_some() && p.dir != own.dir && !p.dir.is_empty() && !own.dir.starts_with(&format!("{}/", p.dir)) && !p.dir.starts_with(&format!("{}/", own.dir))) {
                        let pkg = theirs.name.clone().unwrap_or_else(|| theirs.dir.clone());
                        findings.push(Finding {
                            file: (*file).clone(),
                            line: import.line,
                            target: format!("boundaries:{name}:{spec}"),
                            message: format!("{name}:{} imports \"{spec}\", a file inside package {pkg} ({}), by relative path: import it by its package name and declare it in {}/package.json; a relative path skips that package's build, exports and dependencies", import.line, rel(prefix, &theirs.dir), rel(prefix, &own.dir)),
                        });
                        continue;
                    }
                }
            }
            if !spec.starts_with('.') && !graph.is_alias(file, spec) && !import.erased() {
                let package = graph::package_name(spec);
                if let Some(own) = own.filter(|p| !p.dir.is_empty() && p.name.as_deref() != Some(package) && !p.deps.contains(package)) {
                    if graph.packages.iter().any(|p| p.name.as_deref() == Some(package) && !FIXTURE.is_match(&format!("{}/", p.dir))) {
                        findings.push(Finding {
                            file: (*file).clone(),
                            line: import.line,
                            target: format!("boundaries:{}:{package}", rel(prefix, &own.dir)),
                            message: format!("{name}:{} imports workspace package {package}, which {}/package.json does not declare: add \"{package}\": \"workspace:*\" (or its version) to its dependencies, so installs, builds and caches know this package needs it", import.line, rel(prefix, &own.dir)),
                        });
                    }
                }
            }
            if let Target::File(t) = target {
                if import.erased() {
                    continue;
                }
                let (from, to) = (file.strip_prefix(prefix).unwrap_or(file), t.strip_prefix(prefix).unwrap_or(t));
                if let (Some(a), Some(b)) = (layers.layer(from), layers.layer(to)) {
                    if b < a {
                        let order: Vec<&str> = layers.layers.iter().map(|(n, _)| n.as_str()).collect();
                        findings.push(Finding {
                            file: (*file).clone(),
                            line: import.line,
                            target: format!("boundaries:{name}:{spec}"),
                            message: format!("{name}:{} imports {} from layer {}, above its own layer {}: layers import only downward ({}); move what both need down a layer, or pass it in from above", import.line, rel(prefix, t), layers.layers[b].0, layers.layers[a].0, order.join(" > ")),
                        });
                        continue;
                    }
                }
                if let (Some(a), Some(b)) = (layers.feature(from), layers.feature(to)) {
                    if a != b {
                        findings.push(Finding {
                            file: (*file).clone(),
                            line: import.line,
                            target: format!("boundaries:{name}:{spec}"),
                            message: format!("{name}:{} imports {} from feature {b} into feature {a}: features do not import each other; move what both need into a shared folder", import.line, rel(prefix, t)),
                        });
                    }
                }
            }
        }
    }

    // 3. Barrels: a new index file of re-exports, or an existing one growing, unless the project keeps barrels.
    let barrels: Vec<&String> = project.iter().copied().filter(|f| INDEX.is_match(f) && graph.modules[f.as_str()].barrel && !is_entry(&graph, f, &entry_globs, prefix)).collect();
    let whole = request.added.is_none();
    let kept = barrels.iter().filter(|f| whole || !fresh.contains(f.as_str())).count();
    if kept < 3 {
        for file in barrels {
            let m = &graph.modules[file.as_str()];
            let name = rel(prefix, file);
            let message = "every import of it loads all it re-exports (slower builds, tests and pages, and import cycles through it): import the files directly";
            if whole || fresh.contains(file.as_str()) {
                let new = if whole { "a barrel file" } else { "a new barrel file" };
                findings.push(Finding { file: file.clone(), line: 1, target: format!("boundaries:{name}"), message: format!("{name} is {new}, made only of re-exports: {message}; do not add index files to group exports") });
            } else if let Some(i) = m.imports.iter().find(|i| i.star && request.added.is_some() && request.changed(file, i.line)) {
                findings.push(Finding { file: file.clone(), line: i.line, target: format!("boundaries:{name}"), message: format!("{name}:{} adds `export * from \"{}\"` to a barrel file: {message}", i.line, i.spec) });
            }
        }
    }

    // 4. Client code reaching server-only code.
    findings.extend(client_server(&graph, request, &project));
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    findings.dedup_by(|a, b| a.target == b.target && a.line == b.line);
    Ok(Answer { findings, summary: format!("{edge_count} imports in {} files checked", project.len()), data: None })
}

/// An edge the bundler follows: a value import of a project file that is not a client or server-action module
/// itself (those are entries of their own).
fn follows<'g>(graph: &'g Graph, file: &str) -> impl Iterator<Item = (usize, &'g String)> + 'g {
    let m = &graph.modules[file];
    let targets = &graph.targets[file];
    m.imports.iter().enumerate().filter(|(_, i)| !i.erased() && i.kind != Kind::Type).filter_map(move |(i, _)| match &targets[i] {
        Target::File(t) => graph.modules.get(t).filter(|tm| !tm.client && !tm.server).map(|_| (i, t)),
        _ => None,
    })
}

fn chain(prefix: &str, path: &[&str], reason: &str) -> String {
    let names: Vec<String> = path.iter().map(|p| rel(prefix, p)).collect();
    let shown = if names.len() > 6 { format!("{} → … → {}", names[..2].join(" → "), names[names.len() - 3..].join(" → ")) } else { names.join(" → ") };
    format!("{shown} ({reason})")
}

/// The files from `start` to the server-only module it reaches, following `toward`.
fn walk_toward<'g>(toward: &HashMap<&'g str, Option<&'g str>>, start: &'g str) -> Vec<&'g str> {
    let mut path = vec![];
    let mut at = Some(start);
    while let Some(f) = at {
        path.push(f);
        at = toward.get(f).copied().flatten();
    }
    path
}

/// The files from the client module to `at`, following how the search reached each.
fn walk_back<'g>(came: &HashMap<&'g str, &'g str>, mut at: &'g str) -> Vec<&'g str> {
    let mut path = vec![at];
    while let Some(from) = came.get(at) {
        at = from;
        path.push(at);
    }
    path.reverse();
    path
}

fn client_server<'g>(graph: &'g Graph, request: &Request, project: &[&'g String]) -> Vec<Finding> {
    let prefix = request.prefix.as_str();
    let reasons: HashMap<&str, String> = graph.modules.iter().filter_map(|(f, m)| Some((f.as_str(), server_reason(m)?))).collect();
    if reasons.is_empty() {
        return vec![];
    }
    // Toward the nearest server-only module: the next file on the way, from every file that reaches one.
    let mut importers: HashMap<&str, Vec<&str>> = HashMap::new();
    for f in graph.modules.keys() {
        for (_, t) in follows(graph, f) {
            importers.entry(t.as_str()).or_default().push(f.as_str());
        }
    }
    let mut toward: HashMap<&'g str, Option<&'g str>> = reasons.keys().map(|f| (*f, None)).collect();
    let mut queue: VecDeque<&str> = reasons.keys().copied().collect();
    while let Some(f) = queue.pop_front() {
        for &from in importers.get(f).into_iter().flatten() {
            if !toward.contains_key(from) {
                toward.insert(from, Some(f));
                queue.push_back(from);
            }
        }
    }
    let mut findings = vec![];
    let whole = request.added.is_none();
    for client in project.iter().filter(|f| graph.modules[f.as_str()].client) {
        // Breadth-first from the client module, remembering how each file was reached.
        let mut came: HashMap<&'g str, &'g str> = HashMap::new();
        let mut queue = VecDeque::from([client.as_str()]);
        let mut seen = HashSet::from([client.as_str()]);
        'bfs: while let Some(u) = queue.pop_front() {
            for (i, v) in follows(graph, u) {
                let import = &graph.modules[u].imports[i];
                if toward.contains_key(v.as_str()) && (whole || request.changed(u, import.line)) && u.starts_with(prefix) {
                    let mut path = walk_back(&came, u);
                    path.extend(walk_toward(&toward, v));
                    let server = *path.last().unwrap_or(&"");
                    let name = rel(prefix, u);
                    findings.push(Finding {
                        file: u.to_string(),
                        line: import.line,
                        target: format!("boundaries:{}:client:{}", rel(prefix, client), rel(prefix, server)),
                        message: format!("{name}:{} imports \"{}\" into client code: {}, so server-only code ships to the browser bundle, where it breaks or leaks: keep the server part behind a server action or route and import only browser-safe modules here; do not mark the server module \"use client\"", import.line, import.spec, chain(prefix, &path, &reasons[server])),
                    });
                    if whole {
                        break 'bfs;
                    }
                }
                if seen.insert(v.as_str()) {
                    came.insert(v.as_str(), u);
                    queue.push_back(v.as_str());
                }
            }
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_imports_and_reasons() {
        assert!(server_import("pg") && server_import("node:crypto") && server_import("@aws-sdk/client-s3") && server_import("fs/promises"));
        assert!(!server_import("path") && !server_import("@stripe/stripe-js") && !server_import("zod"));
        let m = graph::read_module("db.ts", "import { Pool } from 'pg';\nexport const pool = new Pool();\n").unwrap();
        assert_eq!(server_reason(&m).as_deref(), Some("imports pg"));
        let env = graph::read_module("env.ts", "export const url = process.env.DATABASE_URL;\nexport const pub = process.env.NEXT_PUBLIC_URL;\n").unwrap();
        assert_eq!(server_reason(&env).as_deref(), Some("reads DATABASE_URL"));
        let lazy = graph::read_module("x.ts", "export function url() { return process.env.DATABASE_URL; }\n").unwrap();
        assert_eq!(server_reason(&lazy), None);
        let t3 = graph::read_module("env.ts", "export const env = createEnv({ runtimeEnv: { DATABASE_URL: process.env.DATABASE_URL } });\n").unwrap();
        assert_eq!(server_reason(&t3), None);
    }

    #[test]
    fn layers_and_features() {
        let l = Layers::read(&serde_json::json!({ "layers": [{ "name": "app", "paths": ["src/app/**"] }, { "name": "shared", "paths": ["src/shared/**"] }], "features": "src/features/*" }));
        assert_eq!(l.layer("src/app/page.tsx"), Some(0));
        assert_eq!(l.layer("src/shared/ui/button.tsx"), Some(1));
        assert_eq!(l.feature("src/features/cart/api.ts"), Some("cart"));
        assert_eq!(l.feature("src/lib/x.ts"), None);
    }
}
