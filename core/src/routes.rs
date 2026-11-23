//! The routes check: a link, navigation or API call the change adds that no route of the app answers. Each package's
//! route table is read from the framework's file routes (Next.js app and pages routers, React Router and Remix flat
//! routes or `app/routes.ts`, SvelteKit, Nuxt, Astro) and from routes declared in code (React Router `<Route>` and route
//! objects, TanStack `createFileRoute`, Express, Hono, Fastify and Elysia handlers). Whatever cannot be read for sure (a
//! router mounted from a file that cannot be followed, a rewrite with a computed source, a middleware that rewrites)
//! makes the paths under it unknown, and unknown is never reported.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::text::{self, Lines};
use crate::{Answer, Finding, Request};

#[derive(Clone, Debug, PartialEq)]
enum Seg {
    Lit(String),
    Param,
    /// One or more segments.
    Splat,
    /// Zero or more segments.
    OptSplat,
}

/// A route path before its optional parts are expanded: each segment and whether it may be left out.
type Raw = Vec<(Seg, bool)>;

#[derive(Clone, Debug)]
struct Route {
    segs: Vec<Seg>,
    /// The HTTP methods the route answers; None when any (or unknown).
    methods: Option<BTreeSet<String>>,
    api: bool,
}

/// A segment of a path the code uses: a literal, or an interpolated `${…}`.
#[derive(Clone, Debug, PartialEq)]
enum USeg {
    Lit(String),
    Dyn,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum UseKind {
    Nav,
    Api,
}

#[derive(Debug)]
struct Use {
    line: u32,
    kind: UseKind,
    method: Option<String>,
    path: Vec<USeg>,
    shown: String,
}

/// A route handler registered in code: `app.get('/x', h)` on `receiver`.
#[derive(Debug)]
struct Handler {
    receiver: String,
    path: String,
    method: Option<String>,
}

/// `app.use('/p', router)` or `app.route('/p', sub)`: routers mounted under a prefix.
#[derive(Debug)]
struct Mount {
    prefix: String,
    /// Identifiers passed; None for an argument that is not one (a call, an inline router).
    args: Vec<Option<String>>,
}

#[derive(Default, Debug)]
struct Facts {
    uses: Vec<Use>,
    /// Exported value names (`GET`, `POST`…), and whether something exported cannot be read (`export *`).
    exports: Vec<String>,
    export_star: bool,
    default_export: Option<String>,
    /// Exported name to local name, for `export { router as users }`.
    export_locals: HashMap<String, String>,
    /// Local name to (specifier, imported name or "default").
    imports: HashMap<String, (String, String)>,
    /// Page routes declared in code (React Router, TanStack), as colon-style or TanStack paths already parsed.
    declared: Vec<Raw>,
    /// Paths under which routes are declared in a way that cannot be read.
    declared_unknown: Vec<Raw>,
    handlers: Vec<Handler>,
    mounts: Vec<Mount>,
    /// A handler registered with a computed method or path, or a framework whose routes are not read (code-based
    /// TanStack routes, NestJS controllers): the package's routes are not known.
    opaque: bool,
    /// `{ source: "/x" }` values (in next.config, only under rewrites and redirects), and the first path of
    /// `["/old", "/new"]` pairs there.
    source_props: Vec<String>,
    /// next.config: a rewrite or redirect whose source is computed, and the imported names its rewrites use.
    computed_source: bool,
    routing_refs: Vec<String>,
    /// next.config: basePath, i18n or pageExtensions; a middleware: a rewrite.
    pages_off: bool,
    /// vite.config `server.proxy` keys.
    proxies: Vec<String>,
    /// app/routes.ts: the evaluated route config, and whether it mounts the file convention (`flatRoutes()`).
    config: Vec<Raw>,
    config_unknown: Vec<Raw>,
    flat_routes: bool,
}

const METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const VERBS: [&str; 8] = ["get", "post", "put", "patch", "delete", "head", "options", "all"];
const AXIOS_VERBS: [&str; 7] = ["get", "post", "put", "patch", "delete", "head", "options"];
/// Calls that create a server or router whose `.get('/x', h)` calls register routes.
const SERVER_MAKERS: [&str; 8] = ["express", "Router", "Hono", "Fastify", "fastify", "Elysia", "Koa", "OpenAPIHono"];
/// Names a server or router conventionally goes by, for one created elsewhere (a Fastify plugin's parameter).
fn router_name(name: &str) -> bool {
    matches!(name, "app" | "router" | "server" | "fastify" | "instance" | "routes" | "route" | "api_router")
        || name.ends_with("Router")
        || name.ends_with("Routes")
        || name.ends_with("App")
        || name.ends_with("Server")
}

fn unwrap<'b, 'a>(mut e: &'b Expression<'a>) -> &'b Expression<'a> {
    loop {
        e = match e {
            Expression::ParenthesizedExpression(p) => &p.expression,
            Expression::TSAsExpression(t) => &t.expression,
            Expression::TSSatisfiesExpression(t) => &t.expression,
            Expression::TSNonNullExpression(t) => &t.expression,
            Expression::AwaitExpression(a) => &a.argument,
            _ => return e,
        }
    }
}

fn string(e: &Expression) -> Option<String> {
    match unwrap(e) {
        Expression::StringLiteral(s) => Some(s.value.to_string()),
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => t.quasis.first().and_then(|q| q.value.cooked.as_ref()).map(|c| c.to_string()),
        _ => None,
    }
}

fn export_name(n: &ModuleExportName) -> String {
    match n {
        ModuleExportName::IdentifierName(i) => i.name.to_string(),
        ModuleExportName::IdentifierReference(i) => i.name.to_string(),
        ModuleExportName::StringLiteral(s) => s.value.to_string(),
    }
}

/// A path the code uses, when it is internal (starts with one `/`): query and hash dropped, `${…}` parts kept as
/// dynamic segments. Paths to files (`/logo.png`) are left alone: they are assets, often written at build time.
fn use_path(e: &Expression) -> Option<(Vec<USeg>, String)> {
    let raw = match unwrap(e) {
        Expression::StringLiteral(s) => s.value.to_string(),
        Expression::TemplateLiteral(t) => {
            let mut out = String::new();
            for (i, q) in t.quasis.iter().enumerate() {
                out.push_str(q.value.cooked.as_deref().unwrap_or(q.value.raw.as_str()));
                if i < t.expressions.len() {
                    out.push('\u{0}');
                }
            }
            out
        }
        _ => return None,
    };
    path_from(raw)
}

fn path_from(raw: String) -> Option<(Vec<USeg>, String)> {
    if !raw.starts_with('/') || raw.starts_with("//") || raw.starts_with("/\u{0}") {
        return None;
    }
    let cut = raw.find(['?', '#']).unwrap_or(raw.len());
    let path = &raw[..cut];
    let segs: Vec<USeg> = path.split('/').filter(|s| !s.is_empty()).map(|s| if s.contains('\u{0}') { USeg::Dyn } else { USeg::Lit(s.to_string()) }).collect();
    if let Some(USeg::Lit(last)) = segs.last() {
        if last.contains('.') {
            return None;
        }
    }
    let shown = format!("/{}", path.split('/').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/")).replace('\u{0}', "${…}");
    Some((segs, shown))
}

/// Colon-style route paths: React Router, Express, Hono, RR7 config, Next.js rewrites, vercel.json.
fn colon_path(path: &str) -> Raw {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s == "*" || s.starts_with('*') || s == "(.*)" {
                (Seg::OptSplat, false)
            } else if let Some(name) = s.strip_prefix(':') {
                if name.ends_with('?') {
                    (Seg::Param, true)
                } else if name.ends_with('*') || name.contains(".*") {
                    (Seg::OptSplat, false)
                } else if name.ends_with('+') {
                    (Seg::Splat, false)
                } else {
                    (Seg::Param, false)
                }
            } else if s.contains(['(', '{', '*', ':', '[']) {
                (Seg::OptSplat, false)
            } else if let Some(lit) = s.strip_suffix('?') {
                (Seg::Lit(lit.to_string()), true)
            } else {
                (Seg::Lit(s.to_string()), false)
            }
        })
        .collect()
}

/// TanStack Router paths: `$id`, `$` (splat), `{-$opt}`, pathless `_layout` and `(group)` segments.
fn tanstack_path(path: &str) -> Raw {
    path.split('/')
        .filter(|s| !s.is_empty() && !s.starts_with('_') && !(s.starts_with('(') && s.ends_with(')')))
        .map(|s| {
            if s == "$" {
                (Seg::OptSplat, false)
            } else if s.starts_with("{-$") {
                (Seg::Param, true)
            } else if s.contains('$') {
                (Seg::Param, false)
            } else {
                (Seg::Lit(s.to_string()), false)
            }
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Fw {
    Next,
    Svelte,
    Nuxt,
    Astro,
}

/// One folder or file name of a bracket-routed framework.
fn bracket_seg(s: &str, fw: Fw) -> (Seg, bool) {
    if s.starts_with("[[...") {
        (Seg::OptSplat, false)
    } else if s.starts_with("[...") {
        (if fw == Fw::Next { Seg::Splat } else { Seg::OptSplat }, false)
    } else if s.starts_with("[[") {
        (Seg::Param, true)
    } else if s.contains('[') {
        (Seg::Param, false)
    } else {
        (Seg::Lit(s.to_string()), false)
    }
}

/// Folders that never become a URL segment: route groups, parallel slots.
fn bracket_dirs(dirs: &[&str], fw: Fw) -> Option<Raw> {
    let mut raw = Raw::new();
    for d in dirs {
        if d.starts_with('(') && d.ends_with(')') && !d.starts_with("(.") {
            continue;
        }
        // An intercepting route shows an existing route in place: it adds no URL. A private folder is not routed.
        if d.starts_with("(.") || (fw == Fw::Next && d.starts_with('_')) {
            return None;
        }
        if fw == Fw::Next && d.starts_with('@') {
            continue;
        }
        raw.push(bracket_seg(d, fw));
    }
    Some(raw)
}

fn expand(raw: &Raw) -> Vec<Vec<Seg>> {
    let mut out: Vec<Vec<Seg>> = vec![vec![]];
    for (seg, optional) in raw {
        let mut next = Vec::new();
        for path in &out {
            let mut with = path.clone();
            with.push(seg.clone());
            next.push(with);
            if *optional {
                next.push(path.clone());
            }
        }
        out = next;
        out.truncate(64);
    }
    out
}

fn matches(route: &[Seg], path: &[USeg]) -> bool {
    let Some((first, rest)) = route.split_first() else { return path.is_empty() };
    // A trailing `${…}` may hold several segments (`/files/${path}`).
    if path.len() == 1 && path[0] == USeg::Dyn && !matches!(first, Seg::OptSplat) {
        return true;
    }
    match first {
        Seg::Lit(s) => match path.first() {
            Some(USeg::Lit(t)) if t == s => matches(rest, &path[1..]),
            Some(USeg::Dyn) => matches(rest, &path[1..]),
            _ => false,
        },
        Seg::Param => !path.is_empty() && matches(rest, &path[1..]),
        Seg::Splat => (1..=path.len()).any(|k| matches(rest, &path[k..])),
        Seg::OptSplat => (0..=path.len()).any(|k| matches(rest, &path[k..])),
    }
}

fn under(prefix: &[Seg], path: &[USeg]) -> bool {
    let mut p = prefix.to_vec();
    p.push(Seg::OptSplat);
    matches(&p, path)
}

struct Collector<'s> {
    src: &'s str,
    lines: Lines,
    facts: Facts,
    /// React Router `<Route>` nesting: the joined path, None once a level cannot be read.
    rr: Vec<Option<String>>,
    /// Route-object arrays already read as children of an outer one.
    seen_arrays: HashSet<u32>,
    /// Receivers created here by a server maker, and the name a chained `new Hono().get(…)` is bound to.
    created: HashSet<String>,
    declarator: Option<String>,
    is_config: bool,
    is_next_config: bool,
    /// Inside next.config's rewrites or redirects (1) or headers (2).
    routing: u8,
    is_middleware: bool,
    is_vite_config: bool,
}

fn join(base: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", base.trim_end_matches('/'), path)
    }
}

impl<'s> Collector<'s> {
    fn line(&self, span: oxc_span::Span) -> u32 {
        self.lines.line(span.start as usize)
    }

    fn add_use(&mut self, span: oxc_span::Span, kind: UseKind, method: Option<String>, e: &Expression) {
        if let Some((path, shown)) = use_path(e) {
            let line = self.line(span);
            self.facts.uses.push(Use { line, kind, method, path, shown });
        }
    }

    /// The receiver at the bottom of a call chain (`app.get(…).post(…)` is `app`), or the variable a chain on a
    /// fresh server (`const users = new Hono().get(…)`) is bound to.
    fn receiver(&self, e: &Expression) -> Option<String> {
        match unwrap(e) {
            Expression::Identifier(i) => Some(i.name.to_string()),
            Expression::ThisExpression(_) => None,
            Expression::CallExpression(c) => match unwrap(&c.callee) {
                Expression::StaticMemberExpression(m) => self.receiver(&m.object),
                Expression::Identifier(i) if SERVER_MAKERS.contains(&i.name.as_str()) => self.declarator.clone(),
                _ => None,
            },
            Expression::NewExpression(n) => match unwrap(&n.callee) {
                Expression::Identifier(i) if SERVER_MAKERS.contains(&i.name.as_str()) => self.declarator.clone(),
                _ => None,
            },
            _ => None,
        }
    }

    /// React Router route objects: `[{ path, element, children: [...] }]`, joined under `base`.
    fn route_objects(&mut self, arr: &ArrayExpression, base: Option<String>) {
        self.seen_arrays.insert(arr.span.start);
        for el in &arr.elements {
            let Some(Expression::ObjectExpression(obj)) = el.as_expression().map(unwrap) else {
                // A spread or a name: routes from elsewhere, under this base.
                if !matches!(el, ArrayExpressionElement::Elision(_)) {
                    self.declared_unknown(base.as_deref());
                }
                continue;
            };
            let mut path: Option<Option<String>> = None;
            let mut index = false;
            let mut children = None;
            let mut children_unknown = false;
            for p in &obj.properties {
                let ObjectPropertyKind::ObjectProperty(p) = p else { continue };
                match p.key.static_name().as_deref() {
                    Some("path") => path = Some(string(&p.value)),
                    Some("index") => index = matches!(unwrap(&p.value), Expression::BooleanLiteral(b) if b.value),
                    Some("children") => match unwrap(&p.value) {
                        Expression::ArrayExpression(a) => children = Some(a),
                        _ => children_unknown = true,
                    },
                    _ => {}
                }
            }
            let here = match (&base, path) {
                (None, _) | (_, Some(None)) => None,
                (Some(b), Some(Some(p))) => Some(join(b, &p)),
                (Some(b), None) => Some(b.clone()),
            };
            if let Some(h) = &here {
                if index || children.is_none() || obj.properties.iter().any(|p| matches!(p, ObjectPropertyKind::ObjectProperty(p) if matches!(p.key.static_name().as_deref(), Some("element" | "Component" | "lazy" | "loader"))))
                {
                    self.facts.declared.push(colon_path(h));
                }
            } else {
                self.declared_unknown(base.as_deref());
            }
            if children_unknown {
                self.declared_unknown(here.as_deref());
            }
            if let Some(c) = children {
                self.route_objects(c, here);
            }
        }
    }

    fn declared_unknown(&mut self, base: Option<&str>) {
        // Routes under an unknown base could be anywhere.
        self.facts.declared_unknown.push(base.map(colon_path).unwrap_or_default());
    }

    /// `app/routes.ts`: `route(path, file, children?)`, `index(file)`, `layout(file, children)`, `...prefix(p, children)`,
    /// `...await flatRoutes()`.
    fn config_routes(&mut self, arr: &ArrayExpression, base: &str) {
        for el in &arr.elements {
            let (spread, e) = match el {
                ArrayExpressionElement::SpreadElement(s) => (true, &s.argument),
                ArrayExpressionElement::Elision(_) => continue,
                other => match other.as_expression() {
                    Some(e) => (false, e),
                    None => continue,
                },
            };
            let Expression::CallExpression(c) = unwrap(e) else {
                self.facts.config_unknown.push(colon_path(base));
                continue;
            };
            let callee = match unwrap(&c.callee) {
                Expression::Identifier(i) => i.name.to_string(),
                _ => String::new(),
            };
            let args: Vec<&Expression> = c.arguments.iter().filter_map(|a| a.as_expression()).collect();
            let children = |i: usize| args.get(i).and_then(|a| if let Expression::ArrayExpression(a) = unwrap(a) { Some(a) } else { None });
            match (callee.as_str(), spread) {
                ("index", false) => self.facts.config.push(colon_path(base)),
                ("route", false) => match args.first().and_then(|a| string(a)) {
                    Some(p) => {
                        let here = join(base, &p);
                        self.facts.config.push(colon_path(&here));
                        if let Some(ch) = children(2) {
                            self.config_routes(ch, &here);
                        }
                    }
                    None => self.facts.config_unknown.push(colon_path(base)),
                },
                ("layout", false) => {
                    if let Some(ch) = children(1) {
                        self.config_routes(ch, base);
                    }
                }
                ("prefix", true) => match (args.first().and_then(|a| string(a)), children(1)) {
                    (Some(p), Some(ch)) => self.config_routes(ch, &join(base, &p)),
                    _ => self.facts.config_unknown.push(colon_path(base)),
                },
                ("flatRoutes", true) if c.arguments.is_empty() && base.is_empty() => self.facts.flat_routes = true,
                _ => self.facts.config_unknown.push(colon_path(base)),
            }
        }
    }
}

impl<'a> Visit<'a> for Collector<'_> {
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        for s in it.specifiers.iter().flatten() {
            let (local, imported) = match s {
                ImportDeclarationSpecifier::ImportSpecifier(s) => (s.local.name.to_string(), export_name(&s.imported)),
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => (s.local.name.to_string(), "default".to_string()),
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => (s.local.name.to_string(), "*".to_string()),
            };
            self.facts.imports.insert(local, (it.source.value.to_string(), imported));
        }
    }

    fn visit_export_named_declaration(&mut self, it: &ExportNamedDeclaration<'a>) {
        if let Some(d) = &it.declaration {
            match d {
                Declaration::FunctionDeclaration(f) => {
                    if let Some(id) = &f.id {
                        self.facts.exports.push(id.name.to_string());
                    }
                }
                Declaration::VariableDeclaration(v) => {
                    for d in &v.declarations {
                        match d.id.get_binding_identifier() {
                            Some(id) => {
                                self.facts.exports.push(id.name.to_string());
                                self.facts.export_locals.insert(id.name.to_string(), id.name.to_string());
                            }
                            None => self.facts.export_star = true,
                        }
                    }
                }
                Declaration::ClassDeclaration(c) => {
                    if let Some(id) = &c.id {
                        self.facts.exports.push(id.name.to_string());
                    }
                }
                _ => {}
            }
        }
        for s in &it.specifiers {
            let exported = export_name(&s.exported);
            self.facts.export_locals.insert(exported.clone(), export_name(&s.local));
            self.facts.exports.push(exported);
        }
        if it.source.is_some() && it.specifiers.is_empty() && it.declaration.is_none() {
            self.facts.export_star = true;
        }
        walk::walk_export_named_declaration(self, it);
    }

    fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
        self.facts.export_star = true;
        walk::walk_export_all_declaration(self, it);
    }

    fn visit_export_default_declaration(&mut self, it: &ExportDefaultDeclaration<'a>) {
        match &it.declaration {
            ExportDefaultDeclarationKind::Identifier(i) => self.facts.default_export = Some(i.name.to_string()),
            other => {
                if let Some(e) = other.as_expression() {
                    if let Expression::ArrayExpression(a) = unwrap(e) {
                        if self.is_config {
                            self.config_routes(a, "");
                            return;
                        }
                    }
                    if let Some(r) = self.receiver(e) {
                        self.facts.default_export = Some(r);
                    }
                }
            }
        }
        walk::walk_export_default_declaration(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let saved = self.declarator.take();
        self.declarator = it.id.get_binding_identifier().map(|b| b.name.to_string());
        if let (Some(name), Some(init)) = (&self.declarator, &it.init) {
            let made = match unwrap(init) {
                Expression::CallExpression(c) => {
                    let callee = &self.src[c.callee.span().start as usize..c.callee.span().end as usize];
                    SERVER_MAKERS.iter().any(|m| callee == *m || callee.ends_with(&format!(".{m}"))) || self.receiver(init).as_deref() == Some(name)
                }
                Expression::NewExpression(n) => matches!(unwrap(&n.callee), Expression::Identifier(i) if SERVER_MAKERS.contains(&i.name.as_str())),
                _ => false,
            };
            if made {
                self.created.insert(name.clone());
            }
            if self.is_config {
                if let Expression::ArrayExpression(a) = unwrap(init) {
                    self.config_routes(a, "");
                }
            }
        }
        walk::walk_variable_declarator(self, it);
        self.declarator = saved;
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        let key = it.key.static_name();
        match key.as_deref() {
            // Navigation menus: `{ href: "/settings", label }`. How the item is rendered (a link, or a form that POSTs
            // to it) is not known here, so only the path is checked.
            Some("href") => self.add_use(it.value.span(), UseKind::Nav, None, &it.value),
            // Any `{ source: "/x" }`: next.config's own, or a list it imports from another file.
            Some("source") => match string(&it.value) {
                Some(s) if s.starts_with('/') && !(self.is_next_config && self.routing != 1) => self.facts.source_props.push(s),
                Some(_) => {}
                None if self.routing == 1 => self.facts.computed_source = true,
                None => {}
            },
            Some("basePath" | "i18n" | "pageExtensions") if self.is_next_config => self.facts.pages_off = true,
            Some(k @ ("rewrites" | "redirects" | "headers")) if self.is_next_config => {
                let saved = self.routing;
                self.routing = if k == "headers" { 2 } else { 1 };
                walk::walk_object_property(self, it);
                self.routing = saved;
                return;
            }
            Some("proxy") if self.is_vite_config => {
                if let Expression::ObjectExpression(o) = unwrap(&it.value) {
                    for p in &o.properties {
                        if let ObjectPropertyKind::ObjectProperty(p) = p {
                            if let Some(k) = p.key.static_name() {
                                self.facts.proxies.push(k.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        walk::walk_object_property(self, it);
    }

    fn visit_method_definition(&mut self, it: &MethodDefinition<'a>) {
        // NestJS controllers declare routes in decorators this check does not read.
        if it.decorators.iter().any(|d| matches!(&d.expression, Expression::CallExpression(c) if matches!(unwrap(&c.callee), Expression::Identifier(i) if matches!(i.name.as_str(), "Get" | "Post" | "Put" | "Patch" | "Delete")))) {
            self.facts.opaque = true;
        }
        walk::walk_method_definition(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        if self.routing == 1 {
            self.facts.routing_refs.push(it.name.to_string());
        }
    }

    fn visit_array_expression(&mut self, it: &ArrayExpression<'a>) {
        if self.routing == 1 && it.elements.len() >= 2 {
            let strings: Vec<Option<String>> = it.elements.iter().map(|e| e.as_expression().and_then(string)).collect();
            if let (true, Some(Some(first))) = (strings.iter().all(|s| s.is_some()), strings.first()) {
                if first.starts_with('/') {
                    self.facts.source_props.push(first.clone());
                }
            }
        }
        if !self.seen_arrays.contains(&it.span.start) && !self.is_config {
            let route_like = it.elements.iter().any(|el| {
                matches!(el.as_expression().map(unwrap), Some(Expression::ObjectExpression(o)) if o.properties.iter().any(|p| matches!(p, ObjectPropertyKind::ObjectProperty(p) if p.key.static_name().as_deref() == Some("path")))
                    && o.properties.iter().any(|p| matches!(p, ObjectPropertyKind::ObjectProperty(p) if matches!(p.key.static_name().as_deref(), Some("element" | "Component" | "lazy" | "children" | "loader" | "errorElement")))))
            });
            if route_like {
                self.route_objects(it, Some(String::new()));
            }
        }
        walk::walk_array_expression(self, it);
    }

    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        let o = &it.opening_element;
        let tag = &self.src[o.name.span().start as usize..o.name.span().end as usize];
        let attr = |name: &str| {
            o.attributes.iter().find_map(|a| match a {
                JSXAttributeItem::Attribute(a) if matches!(&a.name, JSXAttributeName::Identifier(i) if i.name == name) => Some(a),
                _ => None,
            })
        };
        let base = self.rr.last().cloned().unwrap_or(Some(String::new()));
        let mut pushed = false;
        if tag == "Route" {
            let here = match (attr("path").map(|a| &a.value), &base) {
                (_, None) => None,
                (Some(Some(JSXAttributeValue::StringLiteral(s))), Some(b)) => Some(join(b, &s.value)),
                (Some(Some(JSXAttributeValue::ExpressionContainer(c))), Some(b)) => c.expression.as_expression().and_then(string).map(|p| join(b, &p)),
                (Some(_), _) => None,
                (None, Some(b)) => Some(b.clone()),
            };
            match &here {
                Some(h) => self.facts.declared.push(colon_path(h)),
                None => self.declared_unknown(base.as_deref()),
            }
            self.rr.push(here);
            pushed = true;
        }
        for a in &o.attributes {
            let JSXAttributeItem::Attribute(a) = a else { continue };
            let JSXAttributeName::Identifier(name) = &a.name else { continue };
            let navigates = name.name == "href" || (name.name == "to" && matches!(tag, "Link" | "NavLink" | "Navigate" | "Redirect"));
            if !navigates {
                continue;
            }
            match &a.value {
                Some(JSXAttributeValue::StringLiteral(s)) => {
                    if let Some((path, shown)) = path_from(s.value.to_string()) {
                        let line = self.line(a.span);
                        self.facts.uses.push(Use { line, kind: UseKind::Nav, method: Some("GET".into()), path, shown });
                    }
                }
                Some(JSXAttributeValue::ExpressionContainer(c)) => {
                    if let Some(e) = c.expression.as_expression() {
                        self.add_use(a.span, UseKind::Nav, Some("GET".into()), e);
                    }
                }
                _ => {}
            }
        }
        walk::walk_jsx_element(self, it);
        if pushed {
            self.rr.pop();
        }
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let args: Vec<Option<&Expression>> = it.arguments.iter().map(|a| a.as_expression()).collect();
        let first = args.first().copied().flatten();
        let callee = unwrap(&it.callee);
        match callee {
            Expression::Identifier(i) => match i.name.as_str() {
                "fetch" | "$fetch" | "ofetch" | "useFetch" | "ky" => {
                    if let Some(url) = first {
                        let method = match args.get(1).copied().flatten().map(unwrap) {
                            None => Some("GET".to_string()),
                            Some(Expression::ObjectExpression(o)) => {
                                let m = o.properties.iter().find_map(|p| match p {
                                    ObjectPropertyKind::ObjectProperty(p) if p.key.static_name().as_deref() == Some("method") => Some(string(&p.value)),
                                    ObjectPropertyKind::SpreadProperty(_) => Some(None),
                                    _ => None,
                                });
                                match m {
                                    None => Some("GET".to_string()),
                                    Some(m) => m.map(|m| m.to_ascii_uppercase()),
                                }
                            }
                            _ => None,
                        };
                        self.add_use(it.span, UseKind::Api, method, url);
                    }
                }
                "useSWR" | "useSWRImmutable" => {
                    if let Some(url) = first {
                        self.add_use(it.span, UseKind::Api, Some("GET".into()), url);
                    }
                }
                "redirect" | "permanentRedirect" | "navigate" | "goto" | "navigateTo" => {
                    // SvelteKit's `redirect(303, "/x")` puts the status first.
                    let url = match first.map(unwrap) {
                        Some(Expression::NumericLiteral(_)) => args.get(1).copied().flatten(),
                        _ => first,
                    };
                    if let Some(url) = url {
                        self.add_use(it.span, UseKind::Nav, Some("GET".into()), url);
                    }
                }
                "createFileRoute" | "createLazyFileRoute" => {
                    if let Some(p) = first.and_then(string) {
                        if !p.contains("__root") {
                            self.facts.declared.push(tanstack_path(&p));
                        }
                    }
                }
                "createRoute" | "createRootRouteWithContext" if self.src.contains("@tanstack/") => {
                    if i.name == "createRoute" {
                        self.facts.opaque = true;
                    }
                }
                _ => {}
            },
            Expression::StaticMemberExpression(m) => {
                let prop = m.property.name.as_str();
                let object = unwrap(&m.object);
                let object_name = match object {
                    Expression::Identifier(o) => o.name.as_str(),
                    _ => "",
                };
                if (object_name == "axios" || object_name == "ky") && AXIOS_VERBS.contains(&prop) {
                    if let Some(url) = first {
                        self.add_use(it.span, UseKind::Api, Some(prop.to_ascii_uppercase()), url);
                    }
                } else if matches!(prop, "push" | "replace" | "prefetch") && object_name.to_ascii_lowercase().contains("router") {
                    if let Some(url) = first {
                        self.add_use(it.span, UseKind::Nav, Some("GET".into()), url);
                    }
                } else if self.is_middleware && prop == "rewrite" {
                    self.facts.pages_off = true;
                } else if VERBS.contains(&prop) || prop == "route" || prop == "use" || prop == "group" || prop == "register" {
                    self.server_call(it, prop, object, &args);
                }
            }
            Expression::ComputedMemberExpression(m) => {
                if let Some(Expression::Identifier(o)) = Some(unwrap(&m.object)) {
                    if (self.created.contains(o.name.as_str()) || router_name(&o.name)) && string(&m.expression).is_none() && first.and_then(string).is_some_and(|p| p.starts_with('/')) {
                        self.facts.opaque = true;
                    }
                }
            }
            _ => {}
        }
        walk::walk_call_expression(self, it);
    }
}

impl Collector<'_> {
    /// `app.get('/x', h)`, `router.route('/x')`, `app.use('/p', router)`, `app.route('/p', sub)`, `fastify.register(p, { prefix })`.
    fn server_call(&mut self, it: &CallExpression, prop: &str, object: &Expression, args: &[Option<&Expression>]) {
        let Some(receiver) = self.receiver(object) else { return };
        let is_server = self.created.contains(&receiver) || router_name(&receiver);
        if !is_server {
            return;
        }
        let first = args.first().copied().flatten();
        let path = first.and_then(string);
        match prop {
            "use" | "route" | "group" if args.len() >= 2 => match path {
                Some(prefix) if prefix.starts_with('/') => {
                    let mounted = args[1..].iter().map(|a| a.and_then(|a| if let Expression::Identifier(i) = unwrap(a) { Some(i.name.to_string()) } else { None })).collect();
                    self.facts.mounts.push(Mount { prefix, args: mounted });
                }
                Some(_) => {}
                None => {
                    // `app.use(cors(), router)`: middleware first, maybe a router, no prefix.
                    let mounted: Vec<Option<String>> = args.iter().map(|a| a.and_then(|a| if let Expression::Identifier(i) = unwrap(a) { Some(i.name.to_string()) } else { None })).collect();
                    if mounted.iter().any(|m| m.is_some()) {
                        self.facts.mounts.push(Mount { prefix: "/".into(), args: mounted });
                    }
                }
            },
            "use" if args.len() == 1 => {
                if let Some(Expression::Identifier(i)) = first.map(unwrap) {
                    self.facts.mounts.push(Mount { prefix: "/".into(), args: vec![Some(i.name.to_string())] });
                }
            }
            "route" if args.len() == 1 => {
                if let Some(p) = path.filter(|p| p.starts_with('/')) {
                    self.facts.handlers.push(Handler { receiver, path: p, method: None });
                }
            }
            "register" => {
                if let Some(Expression::ObjectExpression(o)) = args.get(1).copied().flatten().map(unwrap) {
                    for p in &o.properties {
                        if let ObjectPropertyKind::ObjectProperty(p) = p {
                            if p.key.static_name().as_deref() == Some("prefix") {
                                let prefix = string(&p.value).unwrap_or_else(|| "/".into());
                                self.facts.mounts.push(Mount { prefix, args: vec![None] });
                            }
                        }
                    }
                }
            }
            verb if VERBS.contains(&verb) => {
                let handler_last = args.last().copied().flatten().is_some_and(|a| matches!(unwrap(a), Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) | Expression::Identifier(_) | Expression::CallExpression(_) | Expression::StaticMemberExpression(_)));
                if args.len() < 2 || !handler_last {
                    return;
                }
                match path {
                    Some(p) if p.starts_with('/') || p == "*" => {
                        let method = (verb != "all").then(|| verb.to_ascii_uppercase());
                        self.facts.handlers.push(Handler { receiver, path: p, method });
                    }
                    Some(_) => {}
                    None => self.facts.opaque = true,
                }
            }
            _ => {}
        }
        let _ = it;
    }
}

fn collect(path: &str, src: &str) -> Option<Facts> {
    let name = path.rsplit('/').next().unwrap_or(path);
    crate::js::parse(path, src, |program| {
        let mut c = Collector {
            src,
            lines: Lines::new(src),
            facts: Facts::default(),
            rr: vec![],
            seen_arrays: HashSet::new(),
            created: HashSet::new(),
            declarator: None,
            is_config: path.ends_with("app/routes.ts") || path.ends_with("app/routes.js"),
            is_next_config: name.starts_with("next.config."),
            routing: 0,
            is_middleware: name.starts_with("middleware.") || name.starts_with("proxy."),
            is_vite_config: name.starts_with("vite.config."),
        };
        c.visit_program(program);
        // Handlers on receivers made in this file are known to be servers even when declared before use.
        c.facts
    })
}

fn deps(root: &str, pkg: &str) -> HashSet<String> {
    let path = if pkg.is_empty() { "package.json".to_string() } else { format!("{pkg}/package.json") };
    let Some(text) = text::read(root, &path) else { return HashSet::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return HashSet::new() };
    ["dependencies", "devDependencies", "peerDependencies"].iter().filter_map(|k| json.get(*k).and_then(|d| d.as_object())).flat_map(|d| d.keys().cloned()).collect()
}

const SERVER_DEPS: [&str; 8] = ["express", "hono", "fastify", "elysia", "koa", "@koa/router", "koa-router", "@hono/zod-openapi"];

#[derive(Default)]
struct Table {
    routes: Vec<Route>,
    unknown: Vec<Vec<Seg>>,
    pages: bool,
    api: bool,
    public: HashSet<String>,
}

impl Table {
    fn add(&mut self, raw: &Raw, methods: Option<BTreeSet<String>>, api: bool) {
        for segs in expand(raw) {
            self.routes.push(Route { segs, methods: methods.clone(), api });
        }
    }

    fn unknown(&mut self, raw: &Raw) {
        self.unknown.extend(expand(raw));
    }
}

fn set(methods: &[&str]) -> Option<BTreeSet<String>> {
    Some(methods.iter().map(|m| m.to_string()).collect())
}

fn exported_methods(f: Option<&Facts>) -> Option<BTreeSet<String>> {
    let f = f?;
    if f.export_star {
        return None;
    }
    let m: BTreeSet<String> = f.exports.iter().filter(|e| METHODS.contains(&e.as_str())).cloned().collect();
    if f.exports.iter().any(|e| e == "ALL" || e == "fallback") {
        return None;
    }
    Some(m)
}

const PAGE_EXT: [&str; 6] = ["tsx", "jsx", "ts", "js", "mdx", "md"];
const CODE_EXT: [&str; 4] = ["ts", "js", "tsx", "jsx"];

fn split_ext(name: &str) -> (&str, &str) {
    name.rsplit_once('.').unwrap_or((name, ""))
}

/// Remix and React Router flat-route file names: `concerts.$city.tsx`, `_auth.login.tsx`, `concerts_.mine.tsx`, `$.tsx`.
fn flat_route(name: &str) -> Raw {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut bracket = false;
    for ch in name.chars() {
        match ch {
            '[' => bracket = true,
            ']' => bracket = false,
            '.' if !bracket => parts.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    parts.push(cur);
    let mut raw = Raw::new();
    for p in parts {
        if p == "_index" || p == "route" || p.is_empty() {
            continue;
        }
        if p.starts_with('_') {
            continue;
        }
        let p = p.strip_suffix('_').unwrap_or(&p).to_string();
        let (p, optional) = match p.strip_prefix('(').and_then(|q| q.strip_suffix(')')) {
            Some(inner) => (inner.to_string(), true),
            None => (p, false),
        };
        if p == "$" {
            raw.push((Seg::OptSplat, false));
        } else if p.starts_with('$') {
            raw.push((Seg::Param, optional));
        } else {
            raw.push((Seg::Lit(p), optional));
        }
    }
    raw
}

/// One package's routes, from its files and the facts of its code.
fn table(root: &str, pkg: &str, files: &[&String], facts: &HashMap<&str, Facts>, product: &HashSet<String>, other_backend: bool) -> (Table, bool) {
    let d = deps(root, pkg);
    let has = |n: &str| d.contains(n);
    let mut t = Table::default();
    let rel = |f: &str| if pkg.is_empty() { f.to_string() } else { f[pkg.len() + 1..].to_string() };
    let mut page_source = false;
    let mut pages_off = false;
    let next = has("next");
    let remix = has("@remix-run/react") || has("@remix-run/dev") || has("@react-router/dev");
    let svelte = has("@sveltejs/kit");
    let nuxt = has("nuxt");
    let astro = has("astro");
    let rr_config = files.iter().find(|f| { let r = rel(f); r == "app/routes.ts" || r == "app/routes.js" });

    for f in files {
        let r = rel(f);
        let parts: Vec<&str> = r.split('/').collect();
        let name = *parts.last().unwrap_or(&"");
        let (stem, ext) = split_ext(name);
        if r.starts_with("public/") || r.starts_with("static/") {
            let url = format!("/{}", r.split_once('/').map_or("", |x| x.1));
            if let Some(dir) = url.strip_suffix("/index.html") {
                t.public.insert(if dir.is_empty() { "/".into() } else { dir.to_string() });
            }
            t.public.insert(url);
            continue;
        }
        if next {
            for base in ["app/", "src/app/"] {
                if let Some(inside) = r.strip_prefix(base) {
                    let dirs: Vec<&str> = inside.split('/').collect();
                    let (dirs, file) = dirs.split_at(dirs.len() - 1);
                    let (fstem, fext) = split_ext(file[0]);
                    let Some(raw) = bracket_dirs(dirs, Fw::Next) else { continue };
                    if fstem == "page" && PAGE_EXT.contains(&fext) {
                        t.add(&raw, set(&["GET"]), false);
                        page_source = true;
                    } else if fstem == "route" && CODE_EXT.contains(&fext) {
                        t.add(&raw, exported_methods(facts.get(f.as_str())), true);
                    }
                }
            }
            for base in ["pages/", "src/pages/"] {
                if let Some(inside) = r.strip_prefix(base) {
                    if !PAGE_EXT.contains(&ext) || inside.contains(".test.") || inside.contains(".spec.") || inside.split('/').any(|p| p.starts_with('_')) {
                        continue;
                    }
                    let dirs: Vec<&str> = inside.split('/').collect();
                    let mut raw: Raw = dirs[..dirs.len() - 1].iter().map(|d| bracket_seg(d, Fw::Next)).collect();
                    if stem != "index" {
                        raw.push(bracket_seg(stem, Fw::Next));
                    }
                    let api = inside.starts_with("api/");
                    t.add(&raw, if api { None } else { set(&["GET"]) }, api);
                    page_source |= !api;
                }
            }
        }
        if remix && CODE_EXT.contains(&ext) && (rr_config.is_none() || facts.get(rr_config.unwrap().as_str()).is_some_and(|c| c.flat_routes)) {
            if let Some(inside) = r.strip_prefix("app/routes/") {
                let route_name = match inside.split_once('/') {
                    None => Some(stem),
                    Some((folder, rest)) if split_ext(rest).0 == "route" && !rest.contains('/') => Some(folder),
                    _ => None,
                };
                if let Some(n) = route_name {
                    t.add(&flat_route(n), None, true);
                    page_source = true;
                }
            }
        }
        if svelte {
            if let Some(inside) = r.strip_prefix("src/routes/") {
                let dirs: Vec<&str> = inside.split('/').collect();
                let (dirs, file) = dirs.split_at(dirs.len() - 1);
                if let Some(raw) = bracket_dirs(dirs, Fw::Svelte) {
                    if file[0] == "+page.svelte" {
                        let actions = files.iter().any(|g| rel(g).strip_prefix("src/routes/").is_some_and(|i| i == inside.replace("+page.svelte", "+page.server.ts") || i == inside.replace("+page.svelte", "+page.server.js")));
                        t.add(&raw, if actions { set(&["GET", "POST"]) } else { set(&["GET"]) }, false);
                        page_source = true;
                    } else if stem == "+server" && CODE_EXT.contains(&ext) {
                        t.add(&raw, exported_methods(facts.get(f.as_str())), true);
                    }
                }
            }
        }
        if nuxt {
            for (base, prefix, api) in [("pages/", "", false), ("app/pages/", "", false), ("server/api/", "api", true), ("server/routes/", "", true)] {
                if let Some(inside) = r.strip_prefix(base) {
                    let ok = if api { CODE_EXT.contains(&ext) } else { ext == "vue" };
                    if !ok {
                        continue;
                    }
                    let dirs: Vec<&str> = inside.split('/').collect();
                    let Some(mut raw) = bracket_dirs(&dirs[..dirs.len() - 1], Fw::Nuxt) else { continue };
                    if !prefix.is_empty() {
                        raw.insert(0, (Seg::Lit(prefix.into()), false));
                    }
                    let (mut s, mut method) = (stem, None);
                    if api {
                        if let Some((a, m)) = stem.rsplit_once('.') {
                            if METHODS.contains(&m.to_ascii_uppercase().as_str()) {
                                s = a;
                                method = set(&[&m.to_ascii_uppercase()]);
                            }
                        }
                    }
                    if s != "index" {
                        raw.push(bracket_seg(s, Fw::Nuxt));
                    }
                    t.add(&raw, if api { method } else { set(&["GET"]) }, api);
                    page_source |= !api;
                }
            }
        }
        if astro {
            if let Some(inside) = r.strip_prefix("src/pages/") {
                if inside.split('/').any(|p| p.starts_with('_')) {
                    continue;
                }
                let dirs: Vec<&str> = inside.split('/').collect();
                let mut raw: Raw = dirs[..dirs.len() - 1].iter().map(|d| bracket_seg(d, Fw::Astro)).collect();
                let page = matches!(ext, "astro" | "md" | "mdx" | "html");
                let endpoint = CODE_EXT.contains(&ext);
                if !page && !endpoint {
                    continue;
                }
                if stem != "index" {
                    raw.push(bracket_seg(stem, Fw::Astro));
                }
                if page {
                    t.add(&raw, if ext == "astro" { None } else { set(&["GET"]) }, false);
                    page_source = true;
                } else {
                    t.add(&raw, exported_methods(facts.get(f.as_str())), true);
                }
            }
        }
    }

    // Routes declared in code, and what in the package's config files changes the picture.
    let mut handlers: Vec<(&str, &Handler)> = Vec::new();
    let mut opaque = false;
    for f in files {
        let Some(fx) = facts.get(f.as_str()) else { continue };
        // Routes declared in tests (a `<Route path={route}>` around the page under test) are not the app's.
        let code = product.contains(f.as_str());
        if code {
            // A client router's root `*` route is its not-found page, not a page at every path.
            for raw in fx.declared.iter().filter(|r| !matches!(r.as_slice(), [(Seg::OptSplat, _)])) {
                t.add(raw, set(&["GET"]), false);
                page_source = true;
            }
            for raw in &fx.declared_unknown {
                t.unknown(raw);
            }
        }
        let name = f.rsplit('/').next().unwrap_or(f);
        if name.starts_with("next.config.") {
            let file_set: HashSet<&str> = files.iter().map(|f| f.as_str()).collect();
            let mut sources = fx.source_props.clone();
            let mut readable = !fx.computed_source || !sources.is_empty();
            for r in &fx.routing_refs {
                let Some((spec, _)) = fx.imports.get(r) else { continue };
                match resolve(&file_set, f, spec).and_then(|t| facts.get(t.as_str())) {
                    Some(other) => sources.extend(other.source_props.iter().cloned()),
                    None => readable = false,
                }
            }
            for s in &sources {
                t.add(&colon_path(s), None, true);
            }
            if !readable {
                t.unknown(&Raw::new());
            }
        }
        pages_off |= fx.pages_off;
        for p in &fx.proxies {
            t.unknown(&colon_path(p.trim_start_matches('^')));
        }
        if let Some(c) = rr_config.filter(|c| c.as_str() == f.as_str()) {
            let _ = c;
            for raw in &fx.config {
                t.add(raw, None, true);
                page_source = true;
            }
            for raw in &fx.config_unknown {
                t.unknown(raw);
            }
        }
        opaque |= code && fx.opaque;
        if code && SERVER_DEPS.iter().any(|s| has(s)) {
            handlers.extend(fx.handlers.iter().map(|h| (f.as_str(), h)));
        }
    }
    if remix && rr_config.is_none() && has("@react-router/dev") {
        pages_off = true;
    }
    if has("remix-flat-routes") {
        pages_off = true;
    }
    if let Some(v) = files.iter().find(|f| rel(f) == "vercel.json").and_then(|f| text::read(root, f)) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&v) {
            for key in ["rewrites", "redirects", "routes"] {
                for r in json.get(key).and_then(|x| x.as_array()).into_iter().flatten() {
                    if let Some(s) = r.get("source").or_else(|| r.get("src")).and_then(|s| s.as_str()) {
                        t.add(&colon_path(s), None, true);
                    }
                }
            }
        }
    }

    // Server handlers, placed under the prefixes their routers are mounted at.
    if !handlers.is_empty() {
        let code: Vec<&String> = files.iter().filter(|f| product.contains(f.as_str())).copied().collect();
        place_handlers(&code, facts, &handlers, &mut t);
    }
    if opaque {
        t.unknown(&Raw::new());
    }
    // A locale segment (`app/[locale]/about`) is usually added by the i18n library's Link and middleware.
    let localized: Vec<Route> = t.routes.iter().filter(|r| !r.api && matches!(r.segs.first(), Some(Seg::Param))).map(|r| Route { segs: r.segs[1..].to_vec(), methods: r.methods.clone(), api: false }).collect();
    let locale_folder = files.iter().any(|f| { let r = rel(f); ["app/[locale]/", "app/[lang]/", "src/app/[locale]/", "src/app/[lang]/", "app/[lng]/", "src/app/[lng]/"].iter().any(|p| r.starts_with(p)) });
    if locale_folder {
        t.routes.extend(localized);
    }
    t.pages = page_source && !pages_off;
    t.api = t.routes.iter().any(|r| r.api);
    (t, other_backend)
}

/// Adds Express-style handlers to the table: a router mounted with `app.use('/p', router)` (in its own file, or imported
/// from one this check can follow) gets the prefix; a mount that cannot be followed makes its prefix unknown.
fn place_handlers(files: &[&String], facts: &HashMap<&str, Facts>, handlers: &[(&str, &Handler)], t: &mut Table) {
    let file_set: HashSet<&str> = files.iter().map(|f| f.as_str()).collect();
    let resolve = |from: &str, spec: &str| resolve(&file_set, from, spec);
    // Each (file, receiver) a mount points at, with the prefixes it is mounted under.
    let mut mounters: HashMap<(String, String), Vec<(String, String, String)>> = HashMap::new();
    for f in files {
        let Some(fx) = facts.get(f.as_str()) else { continue };
        for m in &fx.mounts {
            let mut followed = false;
            for a in m.args.iter().flatten() {
                // A router in the same file.
                if fx.handlers.iter().any(|h| &h.receiver == a) {
                    mounters.entry((f.to_string(), a.clone())).or_default().push((f.to_string(), String::new(), m.prefix.clone()));
                    followed = true;
                    continue;
                }
                // An imported router: the receiver the other file exports under that name.
                if let Some((spec, imported)) = fx.imports.get(a) {
                    if let Some(target) = resolve(f, spec) {
                        if let Some(tf) = facts.get(target.as_str()) {
                            let local = if imported == "default" { tf.default_export.clone() } else { tf.export_locals.get(imported).cloned() };
                            if let Some(local) = local {
                                mounters.entry((target.clone(), local)).or_default().push((f.to_string(), String::new(), m.prefix.clone()));
                                followed = true;
                                continue;
                            }
                        }
                    }
                }
            }
            if !followed && (m.prefix != "/" || m.args.iter().all(|a| a.is_none())) {
                t.unknown(&colon_path(&m.prefix));
            }
        }
    }
    // Prefixes compose: a router mounted under /api that mounts users under /users serves /api/users.
    fn prefixes(key: &(String, String), mounters: &HashMap<(String, String), Vec<(String, String, String)>>, facts: &HashMap<&str, Facts>, depth: usize) -> Vec<String> {
        let Some(list) = mounters.get(key) else { return vec![String::new()] };
        if depth > 6 {
            return vec![];
        }
        let mut out = Vec::new();
        for (from_file, _, prefix) in list {
            // The receiver in `from_file` that did the mounting: any router there; its own prefixes apply.
            let parents: Vec<String> = facts.get(from_file.as_str()).map(|fx| {
                let mut names: BTreeSet<String> = fx.handlers.iter().map(|h| h.receiver.clone()).collect();
                names.extend(fx.default_export.clone());
                names.into_iter().filter(|n| mounters.contains_key(&(from_file.clone(), n.clone()))).collect()
            }).unwrap_or_default();
            let parent_prefixes = if parents.is_empty() { vec![String::new()] } else { parents.iter().flat_map(|p| prefixes(&(from_file.clone(), p.clone()), mounters, facts, depth + 1)).collect() };
            for pp in parent_prefixes {
                out.push(format!("{}{}", pp.trim_end_matches('/'), if prefix == "/" { "" } else { prefix.as_str() }));
            }
        }
        out
    }
    for (f, h) in handlers {
        let key = (f.to_string(), h.receiver.clone());
        for p in prefixes(&key, &mounters, facts, 0) {
            let full = format!("{}{}", p.trim_end_matches('/'), if h.path == "/" && !p.is_empty() { "" } else { h.path.as_str() });
            t.add(&colon_path(&full), h.method.as_ref().map(|m| [m.clone()].into_iter().collect()), true);
        }
    }
}

/// A relative import's file among `files`, trying the usual extensions and index files.
fn resolve(files: &HashSet<&str>, from: &str, spec: &str) -> Option<String> {
    if !spec.starts_with('.') {
        return None;
    }
    let dir = from.rsplit_once('/').map_or("", |d| d.0);
    let joined = crate::unused::normalize(&if dir.is_empty() { spec.to_string() } else { format!("{dir}/{spec}") });
    let stem = joined.trim_end_matches(".js").trim_end_matches(".mjs");
    [joined.clone(), format!("{stem}.ts"), format!("{stem}.js"), format!("{stem}.mts"), format!("{stem}.mjs"), format!("{stem}/index.ts"), format!("{stem}/index.js")].into_iter().find(|c| files.contains(c.as_str()))
}

fn is_code(f: &str) -> bool {
    matches!(split_ext(f).1, "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts")
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let product: HashSet<String> = request.options.get("product").and_then(|p| p.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();
    // Read: product code (uses and declared routes), route files whose exports name their methods, config files.
    let wanted: Vec<&String> = request
        .files
        .iter()
        .filter(|f| {
            if !is_code(f) {
                return false;
            }
            let name = f.rsplit('/').next().unwrap_or(f);
            product.contains(*f) || name.starts_with("next.config.") || name.starts_with("vite.config.") || name.starts_with("middleware.") || f.ends_with("app/routes.ts") || f.ends_with("app/routes.js") || split_ext(name).0 == "route" || split_ext(name).0 == "+server" 
        })
        .collect();
    let facts: HashMap<&str, Facts> = wanted.par_iter().filter_map(|f| Some((f.as_str(), collect(f, &text::read(&request.root, f)?)?))).collect();

    let mut cache = HashMap::new();
    let mut by_pkg: BTreeMap<String, Vec<&String>> = BTreeMap::new();
    for f in &request.files {
        by_pkg.entry(crate::decisions::package_of(&request.root, f, &mut cache)).or_default().push(f);
    }
    // Another server in the repository (a backend package, a Python or Go service) may answer API paths this package
    // does not, so a missing API route is only reported when this package is the only server.
    let servers: BTreeSet<&String> = by_pkg.keys().filter(|p| { let d = deps(&request.root, p); SERVER_DEPS.iter().any(|s| d.contains(*s)) || d.contains("@nestjs/core") }).collect();
    let foreign = request.files.iter().any(|f| { let n = f.rsplit('/').next().unwrap_or(f); matches!(n, "requirements.txt" | "pyproject.toml" | "go.mod" | "Gemfile" | "pom.xml" | "composer.json" | "build.gradle" | "mix.exs") });

    let mut findings: BTreeMap<String, (Finding, usize)> = BTreeMap::new();
    let mut checked = 0;
    for (pkg, files) in &by_pkg {
        let uses: Vec<(&str, &Use)> = files.iter().filter(|f| product.contains(f.as_str())).filter_map(|f| facts.get(f.as_str()).map(|fx| (f.as_str(), fx))).flat_map(|(f, fx)| fx.uses.iter().filter(move |u| request.changed(f, u.line)).map(move |u| (f, u))).collect();
        if uses.is_empty() {
            continue;
        }
        let other_backend = foreign || servers.iter().any(|s| *s != pkg);
        let (t, other_backend) = table(&request.root, pkg, files, &facts, &product, other_backend);
        for (file, u) in uses {
            if t.unknown.iter().any(|p| under(p, &u.path)) || t.public.contains(&u.shown) {
                continue;
            }
            let matched: Vec<&Route> = t.routes.iter().filter(|r| matches(&r.segs, &u.path)).collect();
            let finding = match u.kind {
                UseKind::Nav if !t.pages => None,
                UseKind::Nav if matched.is_empty() => Some((format!("routes:{}", u.shown), format!("no page at {}: link to an existing route or add the page", u.shown))),
                UseKind::Api if matched.is_empty() => {
                    let prefix_served = t.api && t.routes.iter().any(|r| r.api && r.segs.first() == u.path.first().map(|s| match s { USeg::Lit(l) => Seg::Lit(l.clone()), USeg::Dyn => Seg::Param }).as_ref());
                    (prefix_served && !other_backend).then(|| (format!("routes:{}", u.shown), format!("no route handles {}: call an existing route or add the handler", u.shown)))
                }
                _ => {
                    let method = u.method.as_deref().map(|m| if m == "HEAD" { "GET" } else { m });
                    match method {
                        Some(m) if m != "OPTIONS" && matched.iter().all(|r| r.methods.as_ref().is_some_and(|ms| !ms.contains(m))) => {
                            let mut handled: BTreeSet<&str> = matched.iter().flat_map(|r| r.methods.iter().flatten()).map(|s| s.as_str()).collect();
                            handled.remove("HEAD");
                            let list: Vec<&str> = handled.into_iter().collect();
                            let what = if u.kind == UseKind::Nav { format!("a link opens {} with GET", u.shown) } else { format!("{m} {}", u.shown) };
                            Some((format!("routes:{m} {}", u.shown), format!("{what}: the route handles only {}", if list.is_empty() { "no method".to_string() } else { list.join(", ") })))
                        }
                        _ => None,
                    }
                }
            };
            checked += 1;
            if let Some((target, message)) = finding {
                findings.entry(target.clone()).and_modify(|e| e.1 += 1).or_insert((Finding { file: file.to_string(), line: u.line, target, message: format!("{file}:{} {message}", u.line) }, 0));
            }
        }
    }
    let mut findings: Vec<Finding> = findings
        .into_values()
        .map(|(mut f, more)| {
            if more > 0 {
                f.message = f.message.replacen(": ", &format!(" (and {more} more place{}): ", if more == 1 { "" } else { "s" }), 1);
            }
            f
        })
        .collect();
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    Ok(Answer { findings, summary: format!("{checked} links, navigations and API calls checked against the routes of {} packages", by_pkg.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Vec<USeg> {
        let alloc = oxc_allocator::Allocator::default();
        let src = format!("x({s})");
        let parsed = oxc_parser::Parser::new(&alloc, &src, oxc_span::SourceType::ts()).parse();
        let Statement::ExpressionStatement(e) = &parsed.program.body[0] else { panic!() };
        let Expression::CallExpression(c) = &e.expression else { panic!() };
        use_path(c.arguments[0].as_expression().unwrap()).unwrap().0
    }

    fn route(raw: Raw) -> Vec<Seg> {
        expand(&raw).remove(0)
    }

    #[test]
    fn matches_paths_against_routes() {
        let user = route(vec![(Seg::Lit("users".into()), false), (Seg::Param, false)]);
        assert!(matches(&user, &p("'/users/42'")));
        assert!(matches(&user, &p("`/users/${id}`")));
        assert!(!matches(&user, &p("'/users'")));
        assert!(!matches(&user, &p("'/user/42'")));
        assert!(matches(&user, &p("'/users/42?tab=1#x'")));
        let docs = route(vec![(Seg::Lit("docs".into()), false), (Seg::OptSplat, false)]);
        assert!(matches(&docs, &p("'/docs'")) && matches(&docs, &p("'/docs/a/b'")));
        let splat = route(vec![(Seg::Lit("docs".into()), false), (Seg::Splat, false)]);
        assert!(!matches(&splat, &p("'/docs'")));
        assert!(matches(&route(vec![(Seg::Lit("files".into()), false), (Seg::Lit("a".into()), false), (Seg::Lit("b".into()), false)]), &p("`/files/${path}`")));
    }

    #[test]
    fn reads_flat_routes_and_colon_paths() {
        assert_eq!(expand(&flat_route("concerts.$city")), vec![vec![Seg::Lit("concerts".into()), Seg::Param]]);
        assert_eq!(expand(&flat_route("_auth.login")), vec![vec![Seg::Lit("login".into())]]);
        assert_eq!(expand(&flat_route("concerts_.mine")), vec![vec![Seg::Lit("concerts".into()), Seg::Lit("mine".into())]]);
        assert_eq!(expand(&flat_route("_index")), vec![Vec::<Seg>::new()]);
        assert_eq!(expand(&flat_route("($lang).about")).len(), 2);
        assert_eq!(expand(&colon_path("/users/:id?")).len(), 2);
        assert_eq!(colon_path("/api/:path*"), vec![(Seg::Lit("api".into()), false), (Seg::OptSplat, false)]);
    }

    #[test]
    fn collects_uses_declared_routes_and_handlers() {
        let src = r#"
import users from "./users";
const app = express();
app.use("/api/users", users);
app.get("/health", (req, res) => res.send("ok"));
export function Nav() {
  const router = useRouter();
  return <Routes><Route path="/settings" element={<S />}><Route path="billing" element={<B />} /></Route></Routes>;
}
fetch("/api/orders", { method: "POST" });
router.push(`/projects/${id}/edit`);
const items = [{ href: "/team", label: "Team" }];
"#;
        let f = collect("a.tsx", src).unwrap();
        let uses: Vec<(String, UseKind, Option<String>)> = f.uses.iter().map(|u| (u.shown.clone(), u.kind, u.method.clone())).collect();
        assert_eq!(uses, vec![("/api/orders".into(), UseKind::Api, Some("POST".into())), ("/projects/${…}/edit".into(), UseKind::Nav, Some("GET".into())), ("/team".into(), UseKind::Nav, None)]);
        assert_eq!(f.declared.len(), 2);
        assert_eq!(expand(&f.declared[1]), vec![vec![Seg::Lit("settings".into()), Seg::Lit("billing".into())]]);
        assert_eq!(f.handlers.len(), 1);
        assert_eq!(f.mounts.len(), 1);
    }
}
