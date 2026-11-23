//! The repository's import graph: every JavaScript and TypeScript file parsed once, its imports and exports read, and
//! each specifier resolved the way the bundler and TypeScript would (tsconfig `paths`, package `exports`, workspace
//! packages, `.js` written for a `.ts` file). The `imports` and `boundaries` gates judge it.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_ecmascript::BoundNames;
use oxc_resolver::{ResolveError, ResolveOptions, Resolver, TsconfigDiscovery};
use oxc_span::GetSpan;
use oxc_syntax::scope::ScopeFlags;
use rayon::prelude::*;
use regex::Regex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use crate::text::{self, Lines};

/// Source files the graph parses: never installed or minified code.
pub static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:[cm]?[jt]sx?)$").unwrap());
static SKIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:node_modules|bower_components|\.git)/|\.min\.[cm]?js$").unwrap());
/// Extensions a specifier without one may stand for, in the order TypeScript and bundlers try them.
pub const EXTENSIONS: [&str; 16] = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.mts", ".d.cts", ".json", ".vue", ".svelte", ".astro", ".node"];
/// React Native and Expo pick a file per platform: `./Button` is `Button.ios.tsx` on iOS.
const PLATFORMS: [&str; 5] = ["", ".ios", ".android", ".native", ".web"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// `import { a } from "x"`, `import x = require("x")`.
    Static,
    /// `import type { A } from "x"`: erased when compiled.
    Type,
    /// `import("x")`.
    Dynamic,
    /// `require("x")`.
    Require,
    /// `export { a } from "x"`, `export * from "x"`.
    ReExport,
    /// `import "x"`.
    Side,
}

pub struct Name {
    /// The name imported: `default` for a default import.
    pub name: String,
    pub line: u32,
    /// `import { type A }`: erased when compiled.
    pub type_only: bool,
}

pub struct Import {
    pub spec: String,
    pub kind: Kind,
    pub line: u32,
    /// Names the import takes from the module; empty for a namespace, side-effect, dynamic or `export *` import.
    pub names: Vec<Name>,
    /// `export * from "x"`: everything x exports is exported again.
    pub star: bool,
    /// Inside a `try`: an optional dependency, tried and allowed to fail.
    pub in_try: bool,
}

impl Import {
    /// Gone once compiled: `import type`, or only `type` names.
    pub fn erased(&self) -> bool {
        self.kind == Kind::Type || (!self.names.is_empty() && self.names.iter().all(|n| n.type_only))
    }
}

#[derive(Default)]
pub struct Module {
    pub imports: Vec<Import>,
    pub exports: HashSet<String>,
    /// CommonJS, `export =`, or no module syntax at all: what it exports cannot be listed.
    pub open: bool,
    pub client: bool,
    pub server: bool,
    /// Non-public environment variables read when the module loads (outside any function), with their line.
    pub env: Vec<(String, u32)>,
    /// Public variables read anywhere (`NEXT_PUBLIC_X`), without their prefix: `X` read beside one is a fallback.
    pub public_env: HashSet<String>,
    /// `declare module "x"` names.
    pub ambient: Vec<String>,
    /// Every statement re-exports: a barrel.
    pub barrel: bool,
    /// t3-env's `createEnv`: built to be imported from client code, it refuses server variables there itself.
    pub env_module: bool,
}

/// Where a specifier leads.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Target {
    /// A file of the repository, by its path from the top.
    File(String),
    /// An installed package or a file outside the repository.
    External,
    Builtin,
    /// Nothing at all.
    Missing,
    /// Could not tell: a virtual module, a URL, a config the resolver could not load.
    Unknown,
}

pub struct Package {
    pub dir: String,
    pub name: Option<String>,
    pub deps: HashSet<String>,
    /// Files and folders its package.json publishes (main, module, types, exports), from the repository top.
    pub entries: Vec<String>,
    /// It maps `#x` specifiers (package.json `imports`).
    pub imports: bool,
}

pub struct Graph {
    pub root: String,
    pub modules: HashMap<String, Module>,
    /// Per file, the target of each of its imports, in order.
    pub targets: HashMap<String, Vec<Target>>,
    pub packages: Vec<Package>,
    pub files: HashSet<String>,
    /// Lowercased paths, to find an import whose case differs from the file's.
    pub lower: HashMap<String, String>,
    aliases: BTreeMap<String, Vec<Alias>>,
}

/// One tsconfig/jsconfig `paths` entry, made absolute against its base folder.
#[derive(Clone)]
struct Alias {
    prefix: String,
    suffix: String,
    wildcard: bool,
    targets: Vec<String>,
}

pub fn parent(p: &str) -> &str {
    p.rfind('/').map_or("", |i| &p[..i])
}

/// POSIX normalisation of a repository path; None when it climbs above the top.
pub fn normalize(path: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            p => out.push(p),
        }
    }
    Some(out.join("/"))
}

pub fn join(dir: &str, rel: &str) -> Option<String> {
    normalize(&if dir.is_empty() { rel.to_string() } else { format!("{dir}/{rel}") })
}

/// The package a bare specifier names: `@scope/name` or `name`, without a subpath.
pub fn package_name(spec: &str) -> &str {
    let mut parts = spec.splitn(3, '/');
    let first = parts.next().unwrap_or("");
    match (first.starts_with('@'), parts.next()) {
        (true, Some(second)) => &spec[..first.len() + 1 + second.len()],
        _ => first,
    }
}

const BUILTINS: [&str; 46] = [
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib", "test", "sqlite", "sea", "events",
];

pub fn is_builtin(spec: &str) -> bool {
    spec.starts_with("node:") || BUILTINS.contains(&package_name(spec))
}

/// Strips JSON comments and trailing commas, leaving strings alone, so tsconfig files parse.
pub fn jsonc(text: &str) -> Option<serde_json::Value> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' {
            let start = i;
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                i += if bytes[i] == b'\\' { 2 } else { 1 };
            }
            i = (i + 1).min(bytes.len());
            out.push_str(&text[start..i]);
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else {
            let next = text[i..].char_indices().nth(1).map_or(text.len() - i, |(n, _)| n);
            out.push_str(&text[i..i + next]);
            i += next;
        }
    }
    static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",(\s*[}\]])").unwrap());
    serde_json::from_str(&TRAILING.replace_all(&out, "$1")).ok()
}

struct Walker<'s> {
    src: &'s str,
    lines: Lines,
    module: Module,
    functions: u32,
    tries: u32,
}

impl Walker<'_> {
    fn line(&self, offset: u32) -> u32 {
        self.lines.line(offset as usize)
    }

    fn text(&self, span: oxc_span::Span) -> &str {
        &self.src[span.start as usize..span.end as usize]
    }

    fn env(&mut self, name: &str, offset: u32) {
        const PUBLIC: [&str; 7] = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_", "EXPO_PUBLIC_", "REACT_APP_", "GATSBY_", "NUXT_PUBLIC_"];
        if let Some(p) = PUBLIC.iter().find(|p| name.starts_with(**p)) {
            self.module.public_env.insert(name[p.len()..].to_string());
            return;
        }
        if self.functions == 0 && !matches!(name, "NODE_ENV" | "NEXT_RUNTIME" | "MODE" | "DEV" | "PROD" | "SSR" | "BASE_URL") {
            let line = self.line(offset);
            self.module.env.push((name.to_string(), line));
        }
    }

    fn dynamic(&mut self, kind: Kind, arg: Option<&Expression>, offset: u32) {
        let spec = match arg {
            Some(Expression::StringLiteral(s)) => s.value.to_string(),
            Some(Expression::TemplateLiteral(t)) if t.expressions.is_empty() => t.quasis.first().map(|q| q.value.raw.to_string()).unwrap_or_default(),
            _ => return,
        };
        let line = self.line(offset);
        self.module.imports.push(Import { spec, kind, line, names: vec![], star: false, in_try: self.tries > 0 });
    }
}

fn is_env_object(text: &str) -> bool {
    matches!(text, "process.env" | "import.meta.env")
}

impl<'a> Visit<'a> for Walker<'_> {
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        self.functions += 1;
        walk::walk_function(self, it, flags);
        self.functions -= 1;
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.functions += 1;
        walk::walk_arrow_function_expression(self, it);
        self.functions -= 1;
    }

    fn visit_try_statement(&mut self, it: &TryStatement<'a>) {
        self.tries += 1;
        self.visit_block_statement(&it.block);
        self.tries -= 1;
        if let Some(handler) = &it.handler {
            self.visit_catch_clause(handler);
        }
        if let Some(finalizer) = &it.finalizer {
            self.visit_block_statement(finalizer);
        }
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        self.dynamic(Kind::Dynamic, Some(&it.source), it.span.start);
        walk::walk_import_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::Identifier(id) = &it.callee {
            if id.name == "require" && it.arguments.len() == 1 {
                self.dynamic(Kind::Require, it.arguments[0].as_expression(), it.span.start);
            } else if id.name == "createEnv" {
                self.module.env_module = true;
            }
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        let left = self.text(it.left.span());
        if left == "module.exports" || left.starts_with("module.exports.") || left.starts_with("exports.") {
            self.module.open = true;
        }
        walk::walk_assignment_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if is_env_object(self.text(it.object.span())) {
            let name = it.property.name.to_string();
            self.env(&name, it.span.start);
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        if is_env_object(self.text(it.object.span())) {
            if let Expression::StringLiteral(s) = &it.expression {
                let name = s.value.to_string();
                self.env(&name, it.span.start);
            }
        }
        walk::walk_computed_member_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (BindingPattern::ObjectPattern(pattern), Some(init)) = (&it.id, &it.init) {
            if is_env_object(self.text(init.span())) {
                for p in &pattern.properties {
                    if let Some(name) = p.key.static_name() {
                        let name = name.to_string();
                        self.env(&name, p.span.start);
                    }
                }
            }
        }
        walk::walk_variable_declarator(self, it);
    }
}

fn export_name(n: &ModuleExportName) -> String {
    n.name().to_string()
}

/// Reads one file: imports, exports and what its directives and environment reads say about where it runs.
pub fn read_module(path: &str, src: &str) -> Option<Module> {
    crate::js::parse(path, src, |program| {
        let mut w = Walker { src, lines: Lines::new(src), module: Module::default(), functions: 0, tries: 0 };
        for d in &program.directives {
            match d.directive.as_str() {
                "use client" => w.module.client = true,
                "use server" => w.module.server = true,
                _ => {}
            }
        }
        let mut syntax = false;
        let mut reexports = 0;
        let mut others = 0;
        for statement in &program.body {
            match statement {
                Statement::ImportDeclaration(d) => {
                    syntax = true;
                    let line = w.line(d.source.span.start);
                    let type_only = d.import_kind.is_type();
                    let mut names = vec![];
                    for s in d.specifiers.iter().flatten() {
                        match s {
                            ImportDeclarationSpecifier::ImportSpecifier(s) => names.push(Name { name: export_name(&s.imported), line: w.line(s.span.start), type_only: s.import_kind.is_type() }),
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => names.push(Name { name: "default".into(), line: w.line(s.span.start), type_only: false }),
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {}
                        }
                    }
                    let kind = if d.specifiers.is_none() { Kind::Side } else if type_only { Kind::Type } else { Kind::Static };
                    w.module.imports.push(Import { spec: d.source.value.to_string(), kind, line, names, star: false, in_try: false });
                }
                Statement::ExportNamedDeclaration(d) => {
                    syntax = true;
                    if let Some(decl) = &d.declaration {
                        others += 1;
                        match decl {
                            Declaration::VariableDeclaration(v) => v.bound_names(&mut |id| {
                                w.module.exports.insert(id.name.to_string());
                            }),
                            Declaration::FunctionDeclaration(f) => f.id.iter().for_each(|id| {
                                w.module.exports.insert(id.name.to_string());
                            }),
                            Declaration::ClassDeclaration(c) => c.id.iter().for_each(|id| {
                                w.module.exports.insert(id.name.to_string());
                            }),
                            Declaration::TSTypeAliasDeclaration(t) => {
                                w.module.exports.insert(t.id.name.to_string());
                            }
                            Declaration::TSInterfaceDeclaration(t) => {
                                w.module.exports.insert(t.id.name.to_string());
                            }
                            Declaration::TSEnumDeclaration(t) => {
                                w.module.exports.insert(t.id.name.to_string());
                            }
                            Declaration::TSModuleDeclaration(t) => {
                                if let TSModuleDeclarationName::Identifier(id) = &t.id {
                                    w.module.exports.insert(id.name.to_string());
                                }
                            }
                            Declaration::TSImportEqualsDeclaration(t) => {
                                w.module.exports.insert(t.id.name.to_string());
                            }
                            Declaration::TSGlobalDeclaration(_) => {}
                        }
                    }
                    for s in &d.specifiers {
                        w.module.exports.insert(export_name(&s.exported));
                    }
                    if let Some(source) = &d.source {
                        reexports += 1;
                        let line = w.line(source.span.start);
                        let names = d.specifiers.iter().map(|s| Name { name: export_name(&s.local), line: w.line(s.span.start), type_only: s.export_kind.is_type() }).collect();
                        let kind = if d.export_kind.is_type() { Kind::Type } else { Kind::ReExport };
                        w.module.imports.push(Import { spec: source.value.to_string(), kind, line, names, star: false, in_try: false });
                    } else if d.declaration.is_none() {
                        // `export { a, b }` of names this file imported counts as re-exporting; of its own, as code.
                        reexports += 1;
                    }
                }
                Statement::ExportAllDeclaration(d) => {
                    syntax = true;
                    reexports += 1;
                    let line = w.line(d.source.span.start);
                    match &d.exported {
                        Some(name) => {
                            w.module.exports.insert(export_name(name));
                            w.module.imports.push(Import { spec: d.source.value.to_string(), kind: Kind::ReExport, line, names: vec![], star: false, in_try: false });
                        }
                        None => w.module.imports.push(Import { spec: d.source.value.to_string(), kind: if d.export_kind.is_type() { Kind::Type } else { Kind::ReExport }, line, names: vec![], star: true, in_try: false }),
                    }
                }
                Statement::ExportDefaultDeclaration(_) => {
                    syntax = true;
                    others += 1;
                    w.module.exports.insert("default".into());
                }
                Statement::TSExportAssignment(_) => {
                    syntax = true;
                    w.module.open = true;
                }
                Statement::TSImportEqualsDeclaration(d) => {
                    if let TSModuleReference::ExternalModuleReference(r) = &d.module_reference {
                        syntax = true;
                        let line = w.line(r.expression.span.start);
                        w.module.imports.push(Import { spec: r.expression.value.to_string(), kind: Kind::Static, line, names: vec![], star: false, in_try: false });
                    }
                }
                Statement::TSModuleDeclaration(d) => {
                    if let TSModuleDeclarationName::StringLiteral(s) = &d.id {
                        w.module.ambient.push(s.value.to_string());
                    }
                }
                Statement::TSNamespaceExportDeclaration(_) | Statement::TSGlobalDeclaration(_) => {}
                _ => others += 1,
            }
        }
        w.visit_program(program);
        // No import or export at all: a script, or a .d.ts of globals; what it exports cannot be listed.
        if !syntax {
            w.module.open = true;
        }
        w.module.barrel = reexports > 0 && others == 0 && w.module.imports.iter().all(|i| matches!(i.kind, Kind::ReExport | Kind::Type | Kind::Static));
        // A JavaScript file's JSDoc `@typedef`s are types other files may import.
        if path.ends_with("js") && src.contains("@typedef") {
            static TYPEDEF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@(?:typedef|callback)\s+(?:\{[^\n]*\}\s+)?([\w$]+)").unwrap());
            for c in TYPEDEF.captures_iter(src) {
                w.module.exports.insert(c[1].to_string());
            }
        }
        w.module
    })
}

fn read_json(root: &str, file: &str) -> Option<serde_json::Value> {
    jsonc(&std::fs::read_to_string(Path::new(root).join(file)).ok()?)
}

/// Every string inside a JSON value (the targets of an `exports` map).
fn strings(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        serde_json::Value::Object(o) => o.values().for_each(|x| strings(x, out)),
        _ => {}
    }
}

fn packages(root: &str, files: &[String]) -> Vec<Package> {
    files
        .iter()
        .filter(|f| (f.as_str() == "package.json" || f.ends_with("/package.json")) && !SKIP.is_match(f))
        .filter_map(|f| {
            let json = read_json(root, f)?;
            let dir = parent(f).to_string();
            let mut deps = HashSet::new();
            for key in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
                if let Some(o) = json.get(key).and_then(|v| v.as_object()) {
                    deps.extend(o.keys().cloned());
                }
            }
            let mut published = vec![];
            for key in ["main", "module", "types", "typings", "browser", "exports", "bin", "source"] {
                if let Some(v) = json.get(key) {
                    strings(v, &mut published);
                }
            }
            let entries = published.iter().filter(|p| !p.contains('*')).filter_map(|p| join(&dir, p)).collect();
            let name = json.get("name").and_then(|n| n.as_str()).map(str::to_string);
            Some(Package { dir, name, deps, entries, imports: json.get("imports").is_some_and(|i| i.is_object()) })
        })
        .collect()
}

/// tsconfig/jsconfig `paths`, keyed by the folder holding the config. Follows `extends` inside the repository.
fn aliases(root: &str, files: &[String]) -> BTreeMap<String, Vec<Alias>> {
    static CONFIG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:tsconfig|jsconfig)[\w.-]*\.json$").unwrap());
    let mut out: BTreeMap<String, Vec<Alias>> = BTreeMap::new();
    for file in files.iter().filter(|f| CONFIG.is_match(f) && !SKIP.is_match(f)) {
        // Walk the extends chain: the nearest `paths` and the nearest `baseUrl` win, each relative to its own config.
        let (mut paths, mut base): (Option<(serde_json::Value, String)>, Option<String>) = (None, None);
        let mut current = Some(file.clone());
        let mut seen = HashSet::new();
        while let Some(config) = current.take() {
            if !seen.insert(config.clone()) {
                break;
            }
            let Some(json) = read_json(root, &config) else { break };
            let options = json.get("compilerOptions");
            if paths.is_none() {
                if let Some(p) = options.and_then(|o| o.get("paths")).filter(|p| p.is_object()) {
                    paths = Some((p.clone(), parent(&config).to_string()));
                }
            }
            if base.is_none() {
                if let Some(b) = options.and_then(|o| o.get("baseUrl")).and_then(|b| b.as_str()) {
                    base = join(parent(&config), b);
                }
            }
            let extends: Vec<String> = match json.get("extends") {
                Some(serde_json::Value::String(s)) => vec![s.clone()],
                Some(serde_json::Value::Array(a)) => a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect(),
                _ => vec![],
            };
            current = extends.into_iter().rev().find(|e| e.starts_with('.')).and_then(|e| join(parent(&config), &if e.ends_with(".json") { e } else { format!("{e}.json") }));
        }
        let Some((paths, paths_dir)) = paths else { continue };
        let base = base.unwrap_or(paths_dir);
        let list = out.entry(parent(file).to_string()).or_default();
        for (key, targets) in paths.as_object().into_iter().flatten() {
            let targets: Vec<String> = targets.as_array().into_iter().flatten().filter_map(|t| t.as_str()).filter_map(|t| join(&base, t)).collect();
            let (prefix, suffix, wildcard) = match key.split_once('*') {
                Some((p, s)) => (p.to_string(), s.to_string(), true),
                None => (key.clone(), String::new(), false),
            };
            list.push(Alias { prefix, suffix, wildcard, targets });
        }
    }
    out
}

impl Graph {
    pub fn build(root: &str, files: &[String]) -> Graph {
        let code: Vec<&String> = files.iter().filter(|f| CODE.is_match(f) && !SKIP.is_match(f)).collect();
        let modules: HashMap<String, Module> = code.par_iter().filter_map(|f| Some(((*f).clone(), read_module(f, &text::read(root, f)?)?))).collect();
        let mut graph = Graph {
            root: root.to_string(),
            packages: packages(root, files),
            files: files.iter().cloned().collect(),
            lower: files.iter().map(|f| (f.to_lowercase(), f.clone())).collect(),
            aliases: aliases(root, files),
            modules,
            targets: HashMap::new(),
        };
        let resolver = Resolver::new(resolve_options(true));
        let plain = Resolver::new(resolve_options(false));
        let targets: HashMap<String, Vec<Target>> = graph
            .modules
            .par_iter()
            .map(|(file, m)| (file.clone(), m.imports.iter().map(|i| graph.resolve(&resolver, &plain, file, &i.spec)).collect()))
            .collect();
        graph.targets = targets;
        graph
    }

    /// The `paths` aliases that apply to a file: those of every config in the nearest folder holding one.
    fn aliases_for(&self, file: &str) -> &[Alias] {
        let mut dir = parent(file);
        loop {
            if let Some(list) = self.aliases.get(dir) {
                return list;
            }
            if dir.is_empty() {
                return &[];
            }
            dir = parent(dir);
        }
    }

    /// Whether a specifier is one of the project's own aliases (tsconfig `paths`, package `imports`, SvelteKit `$lib`).
    pub fn is_alias(&self, file: &str, spec: &str) -> bool {
        (spec.starts_with('#') && self.packages_of(file).iter().any(|p| p.imports)) || (spec.starts_with("$lib") && self.svelte_dir(file).is_some()) || self.aliases_for(file).iter().any(|a| if a.wildcard { spec.starts_with(&a.prefix) && spec.ends_with(&a.suffix) } else { spec == a.prefix })
    }

    /// On disk, not in git's list: that still names a tracked file the change deleted.
    fn exists(&self, path: &str) -> bool {
        Path::new(&self.root).join(path).is_file()
    }

    /// A path written without its extension, as TypeScript and React Native would find it.
    pub fn find_file(&self, base: &str) -> Option<String> {
        if self.exists(base) {
            return Some(base.to_string());
        }
        let stems: Vec<String> = match base.rsplit_once('.') {
            Some((stem, "js" | "jsx" | "mjs" | "cjs")) if !stem.ends_with('/') => vec![base.to_string(), stem.to_string()],
            _ => vec![base.to_string()],
        };
        for stem in &stems {
            for dir_index in ["", "/index"] {
                for platform in PLATFORMS {
                    for ext in EXTENSIONS {
                        let candidate = format!("{stem}{dir_index}{platform}{ext}");
                        if self.exists(&candidate) {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
        None
    }

    /// The SvelteKit app folder a file is in, whose `$lib` is its `src/lib`.
    fn svelte_dir<'f>(&self, file: &'f str) -> Option<&'f str> {
        let mut dir = parent(file);
        loop {
            if ["svelte.config.js", "svelte.config.ts", "svelte.config.mjs"].iter().any(|n| self.exists(&join(dir, n).unwrap_or_default())) {
                return Some(dir);
            }
            if dir.is_empty() {
                return None;
            }
            dir = parent(dir);
        }
    }

    fn by_alias(&self, file: &str, spec: &str) -> Option<String> {
        if let Some(rest) = spec.strip_prefix("$lib") {
            return self.find_file(&join(self.svelte_dir(file)?, &format!("src/lib{rest}"))?);
        }
        for alias in self.aliases_for(file) {
            let matched = if alias.wildcard { spec.strip_prefix(alias.prefix.as_str()).and_then(|r| r.strip_suffix(alias.suffix.as_str())) } else { (spec == alias.prefix).then_some("") };
            let Some(star) = matched else { continue };
            for target in &alias.targets {
                if let Some(found) = normalize(&target.replace('*', star)).and_then(|t| self.find_file(&t)) {
                    return Some(found);
                }
            }
        }
        None
    }

    fn resolve(&self, resolver: &Resolver, plain: &Resolver, file: &str, spec: &str) -> Target {
        let spec = spec.split(['?']).next().unwrap_or(spec);
        if spec.is_empty() || spec.contains("://") || spec.contains('{') || spec.starts_with('/') {
            return Target::Unknown;
        }
        if is_builtin(spec) && !spec.starts_with('.') {
            return Target::Builtin;
        }
        let relative = spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == "..";
        if relative {
            return match join(parent(file), spec).and_then(|p| self.find_file(&p)) {
                Some(found) if found.split('/').any(|s| s == "node_modules") => Target::External,
                Some(found) => Target::File(found),
                None => match self.oxc(resolver, plain, file, spec) {
                    Target::Unknown | Target::Missing => Target::Missing,
                    other => other,
                },
            };
        }
        if let Some(found) = self.by_alias(file, spec) {
            return Target::File(found);
        }
        let found = self.oxc(resolver, plain, file, spec);
        if found == Target::Missing && !self.is_alias(file, spec) && self.declares(file, spec) {
            // Declared but not installed here (no node_modules): it exists, just not on this disk.
            return Target::External;
        }
        found
    }

    fn oxc(&self, resolver: &Resolver, plain: &Resolver, file: &str, spec: &str) -> Target {
        let path = PathBuf::from(&self.root).join(file);
        let mut answer = resolver.resolve_file(&path, spec);
        if matches!(answer, Err(ResolveError::TsconfigNotFound(_) | ResolveError::IOError(_) | ResolveError::TsconfigSelfReference(_) | ResolveError::TsconfigCircularExtend(_) | ResolveError::Json(_))) {
            answer = plain.resolve(path.parent().unwrap_or(Path::new(&self.root)), spec);
        }
        match answer {
            Ok(r) => {
                let full = r.path();
                match full.strip_prefix(&self.root).ok().and_then(|p| p.to_str()) {
                    Some(rel) if !rel.split('/').any(|s| s == "node_modules") => Target::File(rel.trim_start_matches('/').to_string()),
                    _ => Target::External,
                }
            }
            Err(ResolveError::Builtin { .. }) => Target::Builtin,
            Err(ResolveError::NotFound(_) | ResolveError::MatchedAliasNotFound(..)) => Target::Missing,
            // The package is there, but this subpath is not exported, or its exports map names a file not built yet.
            Err(ResolveError::PackagePathNotExported { .. } | ResolveError::InvalidPackageTarget(..)) => Target::External,
            Err(_) => Target::Unknown,
        }
    }

    /// The package folders from a file up to the repository top, nearest first.
    pub fn packages_of(&self, file: &str) -> Vec<&Package> {
        let mut list: Vec<&Package> = self.packages.iter().filter(|p| p.dir.is_empty() || file.starts_with(&format!("{}/", p.dir))).collect();
        list.sort_by_key(|p| std::cmp::Reverse(p.dir.len()));
        list
    }

    /// Whether a package.json between the file and the top declares the package a bare specifier names (or its
    /// `@types` package), or the specifier is one of the repository's own packages.
    pub fn declares(&self, file: &str, spec: &str) -> bool {
        let name = package_name(spec);
        let types = format!("@types/{}", name.trim_start_matches('@').replace('/', "__"));
        self.packages_of(file).iter().any(|p| p.deps.contains(name) || p.deps.contains(&types) || p.name.as_deref() == Some(name)) || self.packages.iter().any(|p| p.name.as_deref() == Some(name))
    }

    /// Everything a file exports, through `export *` chains; None when that cannot be listed.
    pub fn exports_of(&self, file: &str, versions: &HashMap<String, Module>) -> Option<HashSet<String>> {
        let mut out = HashSet::new();
        let mut stack = vec![file.to_string()];
        let mut seen = HashSet::new();
        while let Some(f) = stack.pop() {
            if !seen.insert(f.clone()) {
                continue;
            }
            let m = versions.get(&f).or_else(|| self.modules.get(&f))?;
            if m.open {
                return None;
            }
            out.extend(m.exports.iter().cloned());
            for (i, import) in m.imports.iter().enumerate() {
                if !import.star {
                    continue;
                }
                // A re-export from the base version of a file is resolved against today's tree: close enough.
                let target = self.targets.get(&f).and_then(|t| t.get(i)).cloned().or_else(|| match join(parent(&f), &import.spec).and_then(|p| self.find_file(&p)) {
                    Some(found) => Some(Target::File(found)),
                    None => Some(Target::Missing),
                });
                match target {
                    Some(Target::File(next)) if CODE.is_match(&next) && !next.ends_with(".json") => stack.push(next),
                    _ => return None,
                }
            }
        }
        // `export *` never re-exports a default, but a file's own default stays.
        out.remove("default");
        if let Some(m) = versions.get(file).or_else(|| self.modules.get(file)) {
            if m.exports.contains("default") {
                out.insert("default".into());
            }
        }
        Some(out)
    }
}

fn resolve_options(tsconfig: bool) -> ResolveOptions {
    let v = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    ResolveOptions {
        tsconfig: tsconfig.then_some(TsconfigDiscovery::Auto),
        extensions: v(&EXTENSIONS),
        extension_alias: vec![
            (".js".into(), v(&[".ts", ".tsx", ".d.ts", ".js", ".jsx"])),
            (".jsx".into(), v(&[".tsx", ".jsx"])),
            (".mjs".into(), v(&[".mts", ".d.mts", ".mjs"])),
            (".cjs".into(), v(&[".cts", ".d.cts", ".cjs"])),
        ],
        condition_names: v(&["types", "import", "require", "node", "browser", "react-native", "worker", "workerd", "edge-light", "bun", "deno", "development", "default"]),
        main_fields: v(&["types", "typings", "module", "main", "browser", "react-native"]),
        builtin_modules: true,
        symlinks: true,
        ..ResolveOptions::default()
    }
}

/// A glob over repository paths: `**` any folders, `*` within one name, `?` one character.
pub fn glob(pattern: &str) -> Option<Regex> {
    let mut re = String::from("^");
    let chars: Vec<char> = pattern.trim_start_matches("./").chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                i += 1;
                if chars.get(i + 1) == Some(&'/') {
                    i += 1;
                    re.push_str("(?:.*/)?");
                } else {
                    re.push_str(".*");
                }
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&re).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_imports_exports_and_where_a_module_runs() {
        let src = "'use client';\nimport a, { b, type C } from './a';\nimport type { D } from './d';\nimport './side.css';\nimport * as ns from 'pkg';\nexport { e } from './e';\nexport * from './f';\nexport * as g from './g';\nexport const { h, i: [j] } = obj;\nexport function k() {}\nexport type L = 1;\nexport interface M {}\nexport enum N {}\nexport default 1;\nconst url = process.env.DATABASE_URL;\nfunction later() { return process.env.LATER; }\nconst x = require('x');\ntry { require('optional'); } catch {}\nconst y = import('./lazy');\n";
        let m = read_module("a.tsx", src).unwrap();
        assert!(m.client && !m.server && !m.open && !m.barrel);
        let imports: Vec<(&str, Kind, Vec<&str>, bool, bool)> = m.imports.iter().map(|i| (i.spec.as_str(), i.kind, i.names.iter().map(|n| n.name.as_str()).collect(), i.star, i.in_try)).collect();
        assert_eq!(
            imports,
            vec![
                ("./a", Kind::Static, vec!["default", "b", "C"], false, false),
                ("./d", Kind::Type, vec!["D"], false, false),
                ("./side.css", Kind::Side, vec![], false, false),
                ("pkg", Kind::Static, vec![], false, false),
                ("./e", Kind::ReExport, vec!["e"], false, false),
                ("./f", Kind::ReExport, vec![], true, false),
                ("./g", Kind::ReExport, vec![], false, false),
                ("x", Kind::Require, vec![], false, false),
                ("optional", Kind::Require, vec![], false, true),
                ("./lazy", Kind::Dynamic, vec![], false, false),
            ]
        );
        let mut exports: Vec<&str> = m.exports.iter().map(String::as_str).collect();
        exports.sort();
        assert_eq!(exports, vec!["L", "M", "N", "default", "e", "g", "h", "j", "k"]);
        assert_eq!(m.env, vec![("DATABASE_URL".to_string(), 15)]);
    }

    #[test]
    fn commonjs_scripts_and_barrels() {
        assert!(read_module("a.js", "module.exports = { a: 1 };\n").unwrap().open);
        assert!(read_module("a.js", "console.log(1);\n").unwrap().open);
        assert!(read_module("index.ts", "export * from './a';\nexport { b } from './b';\nexport type { C } from './c';\n").unwrap().barrel);
        assert!(!read_module("index.ts", "export * from './a';\nexport const x = 1;\n").unwrap().barrel);
        let typedefs = read_module("lib.mjs", "/** @typedef {{ a: string }} Options */\nexport const run = 1;\n").unwrap();
        assert!(typedefs.exports.contains("Options"));
    }

    #[test]
    fn helpers() {
        assert_eq!(package_name("@scope/name/sub"), "@scope/name");
        assert_eq!(package_name("name/sub"), "name");
        assert!(is_builtin("node:fs") && is_builtin("fs/promises") && !is_builtin("fsevents"));
        assert_eq!(normalize("a/./b/../c"), Some("a/c".into()));
        assert_eq!(normalize("../a"), None);
        assert_eq!(jsonc("{\n // c\n \"a\": \"http://x\", /* b */ \"b\": [1,],\n}").unwrap()["a"], "http://x");
        let g = glob("src/features/*/**").unwrap();
        assert!(g.is_match("src/features/cart/a/b.ts") && !g.is_match("src/lib/a.ts"));
    }
}
