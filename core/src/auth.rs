//! The auth check: an endpoint the change adds or edits that never asks who is calling, in a project whose other
//! endpoints of the same kind do. The convention is the project's own: when at least three endpoints of a kind exist in
//! a package and at least 70% check identity (a call such as `getUser()`, a guarding middleware or wrapper, a protected
//! tRPC procedure, a Next.js middleware covering the path, or a secret or signature comparison), an unguarded one that
//! is not public by its path is an endpoint someone forgot to protect.
//!
//! Endpoints: Next.js route handlers and pages/api routes, server actions and TanStack server functions, SvelteKit
//! `+server` handlers and form actions, Remix/React Router `action`/`loader` exports, Express/Hono/Fastify route
//! registrations, tRPC procedures and Convex functions.

use fancy_regex::Regex as Fancy;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::{GetSpan, Span};
use oxc_syntax::operator::BinaryOperator;
use oxc_syntax::scope::ScopeFlags;
use rayon::prelude::*;
use regex::Regex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use crate::text::{self, Lines};
use crate::{js, Answer, Finding, Request};

/// Calls that establish who is calling, by name (lint's `no-unguarded-server-action` idea, widened to middleware).
static IDENTITY: LazyLock<Regex> = LazyLock::new(|| {
    // "user" alone is too common (`getUserFriendlyMessage`, `getUsers`): only the forms that fetch the caller count.
    Regex::new(r"(?i)auth|session|viewer|current|require|protect|guard|role|permission|admin|signed|login|claims|verif\w*(?:pin|pass|otp|code|token|cred|sign|session|jwt|key|hmac|hook|identity)|owner|member|access|clerk|jwt|bearer|passport|identity|apikey|api_key|signature|timingSafeEqual|constructEvent|user(?:id|orthrow|orredirect|fromrequest|session|context)?$").unwrap()
});
/// Names that match IDENTITY but do something else: data operations on users or sessions, database clients (a
/// service-role or admin client skips row-level security, the opposite of a check), and validation schemas.
static NOT_IDENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:create|update|delete|remove|list|insert|upsert|add|save|count|search|send|invite|seed|start|complete|end|finish|track|log|record|format|render|build)[A-Z_]|(?:Schema|Validator|Input|Dto|Props|Type)$|(?i:client$|admin\w*client|service)").unwrap()
});
static CLIENT_FACTORY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)client$|admin\w*client|service").unwrap());
/// Clients whose queries run as the signed-in user, so row-level security is the check.
const SESSION_CLIENTS: [&str; 5] =
    ["createServerClient", "createRouteHandlerClient", "createServerComponentClient", "createServerActionClient", "createMiddlewareClient"];
/// Names too generic to inherit identity from what they call.
const GENERIC: [&str; 20] = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "default",
    "handler",
    "main",
    "run",
    "execute",
    "middleware",
    "action",
    "loader",
    "load",
    "handle",
    "fn",
    "callback",
    "next",
];
/// Request properties that hold the caller once a middleware has checked them.
const CALLER_PROPS: [&str; 18] = [
    "user",
    "session",
    "auth",
    "userId",
    "currentUser",
    "viewer",
    "claims",
    "identity",
    "isAuthenticated",
    "isLoggedIn",
    "jwtPayload",
    "customer",
    "staff",
    "member",
    "tenant",
    "principal",
    "actor",
    "account",
];
static CALLER_OBJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:req|request|ctx|context|locals|event|c|ev|e|res\.locals)$|\.locals$").unwrap());
/// Comparing against these is a secret or signature check (cron jobs, webhooks, API keys).
static SECRET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)secret|signature|api_?key|authorization|bearer").unwrap());
static SECRET_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:authorization|x-api-key|x-[\w-]*(?:secret|token|signature|key))$").unwrap());
/// Writes lint's `no-unguarded-server-action` reports in a server action that asks for no identity (not repeated here).
static CHANGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:update|updateMany|upsert|delete|deleteMany|destroy|remove|updateOne|deleteOne|findByIdAndUpdate|findOneAndUpdate|findByIdAndDelete|findOneAndDelete)$").unwrap()
});
static DATABASE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:db|database|prisma|supabase|sb|admin|tx|trx|transaction|knex|drizzle|sql|client|orm|em|repo|repository|collection|[A-Z]\w*)$",
    )
    .unwrap()
});
static LINT_IDENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)auth|session|user|viewer|current|require|protect|guard|role|permission|admin|signed|login|claims|verif|owner|member|access|clerk").unwrap()
});
/// Endpoints whose path says they are public by design: sign-in flows, webhooks, health, crawlers, invitations.
static PUBLIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[/._\-\[(:\s])(?:auth|authenticate|login|logout|signin|sign-in|signout|sign-out|signup|sign-up|register|registration|callback|oauth|sso|saml|webhooks?|hooks?|public|health|healthz|healthcheck|status|ping|og|opengraph|robots|sitemap|manifest|\.well-known|unsubscribe|invites?|invitation|verify|verification|confirm|reset|forgot|password|magic|otp|cron|crons|stripe|inngest|trigger|qstash|svix|feed|rss|favicon|version|metrics|ready|readiness|live|liveness|contact|newsletter|subscribe|waitlist|share|embed|preview|refresh|csrf)s?(?:$|[/._\-\])\s])").unwrap()
});
static NEXT_ROUTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)app/(?:.+/)?route\.[cm]?[jt]sx?$").unwrap());
static PAGES_API: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)pages/api/.+\.[cm]?[jt]sx?$").unwrap());
static MIDDLEWARE_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)(?:middleware|proxy)\.[cm]?[jt]s$").unwrap());
static PUBLIC_MATCHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)public|ignored|unprotected|open").unwrap());
static ROUTER_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:app|router|routes?|server|hono|fastify|[a-z]\w*Router|[a-z]\w*App|[a-z]\w*Routes)$").unwrap());
static ROUTER_MAKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:Router|Hono|OpenAPIHono|express|fastify|Fastify|Elysia|createRouter|Koa)$").unwrap());
static CLIENT_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:axios|ky|http|https|fetch|request|got|superagent|supertest|client|apiclient|instance|agent|cy|page|map|cache|params|searchparams|headers|cookies|formdata|url|store|storage|redis|kv|this|rest|graphql)$").unwrap()
});
static IO_ROOT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:db|database|prisma|supabase|sb|tx|trx|knex|drizzle|sql|pool|client|redis|kv|ctx|axios|ky|stripe|resend|s3|storage)$")
        .unwrap()
});
static SAID_PUBLIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bpublic|public\b|(?-i:[a-z]Public[A-Z])|\bunauthenticated\b|\banonymous\b|\bunauthed\b|\bno auth\b|\bwithout auth|\btoken-gated\b|\bno login\b").unwrap()
});
static DEV_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"NODE_ENV\s*===?\s*["'](?:development|test)["']|["'](?:development|test)["']\s*===?\s*\S*NODE_ENV|\bisDev(?:elopment)?\b|import\.meta\.env\.DEV\b"#).unwrap()
});
static BARE_PROCEDURE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:public\w*|base\w*)procedure$|^procedure$").unwrap());
const METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const VERBS: [&str; 9] = ["get", "post", "put", "patch", "delete", "del", "all", "options", "head"];
/// Fewer endpoints of a kind than this is no convention.
const MIN_ENDPOINTS: usize = 3;
const MIN_SHARE: f64 = 0.7;

/// What a function body does that bears on identity.
#[derive(Default, Clone, Debug)]
struct Facts {
    callees: Vec<String>,
    caller_read: bool,
    secret: bool,
    change: bool,
    lint_identity: bool,
    /// Reaches outside the process (awaits, a database or fetch call): a handler that only sets a cookie or returns a
    /// constant has nothing to protect.
    io: bool,
}

impl Facts {
    fn merge(&mut self, other: &Facts) {
        self.callees.extend(other.callees.iter().cloned());
        self.caller_read |= other.caller_read;
        self.secret |= other.secret;
        self.change |= other.change;
        self.lint_identity |= other.lint_identity;
        self.io |= other.io;
    }
}

/// Every name along a callee: `authActionClient.schema(x).action` gives action, schema, authActionClient.
fn chain_names(e: &Expression, out: &mut Vec<String>) {
    match e.get_inner_expression() {
        Expression::Identifier(id) => out.push(id.name.to_string()),
        Expression::StaticMemberExpression(m) => {
            out.push(m.property.name.to_string());
            chain_names(&m.object, out);
        }
        Expression::CallExpression(c) => chain_names(&c.callee, out),
        Expression::AwaitExpression(a) => chain_names(&a.argument, out),
        Expression::ChainExpression(c) => match &c.expression {
            ChainElement::StaticMemberExpression(m) => {
                out.push(m.property.name.to_string());
                chain_names(&m.object, out);
            }
            ChainElement::CallExpression(c) => chain_names(&c.callee, out),
            _ => {}
        },
        _ => {}
    }
}

/// The identifier a member or call chain hangs off: `app` in `app.use(x).get`.
fn chain_root<'b>(e: &'b Expression<'b>) -> Option<&'b str> {
    match e.get_inner_expression() {
        Expression::Identifier(id) => Some(id.name.as_str()),
        Expression::StaticMemberExpression(m) => chain_root(&m.object),
        Expression::CallExpression(c) => chain_root(&c.callee),
        _ => None,
    }
}

fn last_name(e: &Expression) -> String {
    match e.get_inner_expression() {
        Expression::Identifier(id) => id.name.to_string(),
        Expression::StaticMemberExpression(m) => m.property.name.to_string(),
        _ => String::new(),
    }
}

fn string_value(e: &Expression) -> Option<String> {
    js::string(e.get_inner_expression(), true).map(str::to_string)
}

/// The strings in a string or an array of strings.
fn strings(e: &Expression) -> Vec<String> {
    match e.get_inner_expression() {
        Expression::ArrayExpression(a) => a.elements.iter().filter_map(|el| el.as_expression().and_then(string_value)).collect(),
        other => string_value(other).into_iter().collect(),
    }
}

struct BodyWalk<'s> {
    src: &'s str,
    facts: Facts,
}

impl<'a> Visit<'a> for BodyWalk<'_> {
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        // The function called and the properties on the way (`supabase.auth.getUser`), not the variable it hangs off:
        // `currentDate.setDate()` checks nobody.
        let mut names = Vec::new();
        chain_names(&it.callee, &mut names);
        if names.len() > 1 && matches!(chain_root(&it.callee), Some(r) if names.last().is_some_and(|n| n == r)) {
            names.pop();
        }
        self.facts.callees.extend(names);
        let last = last_name(&it.callee);
        if last == "then" || last == "fetch" || chain_root(&it.callee).is_some_and(|r| IO_ROOT.is_match(r)) {
            self.facts.io = true;
        }
        if LINT_IDENTITY.is_match(&last) {
            self.facts.lint_identity = true;
        }
        if let Expression::StaticMemberExpression(m) = it.callee.get_inner_expression() {
            if CHANGE.is_match(&m.property.name) {
                let call_based = matches!(m.object.get_inner_expression(), Expression::CallExpression(_) | Expression::AwaitExpression(_));
                if call_based || chain_root(&m.object).is_some_and(|b| DATABASE.is_match(b)) {
                    self.facts.change = true;
                }
            }
            // Hono's `c.get("user")`, and header reads of `authorization` or `x-api-key`.
            if let Some(arg) = it.arguments.first().and_then(|a| a.as_expression()).and_then(string_value) {
                if SECRET_HEADER.is_match(&arg) {
                    self.facts.secret = true;
                } else if m.property.name == "get" && CALLER_PROPS.contains(&arg.as_str()) {
                    self.facts.caller_read = true;
                }
            }
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if CALLER_PROPS.contains(&it.property.name.as_str()) {
            let span = it.object.span();
            if CALLER_OBJECT.is_match(&self.src[span.start as usize..span.end as usize]) {
                self.facts.caller_read = true;
            }
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        if string_value(&it.expression).is_some_and(|s| SECRET_HEADER.is_match(&s)) {
            self.facts.secret = true;
        }
        walk::walk_computed_member_expression(self, it);
    }

    fn visit_await_expression(&mut self, it: &AwaitExpression<'a>) {
        self.facts.io = true;
        walk::walk_await_expression(self, it);
    }

    fn visit_binary_expression(&mut self, it: &BinaryExpression<'a>) {
        if matches!(
            it.operator,
            BinaryOperator::StrictEquality | BinaryOperator::StrictInequality | BinaryOperator::Equality | BinaryOperator::Inequality
        ) && SECRET.is_match(&self.src[it.span.start as usize..it.span.end as usize])
        {
            self.facts.secret = true;
        }
        walk::walk_binary_expression(self, it);
    }
}

fn facts_of(src: &str, visit: impl FnOnce(&mut BodyWalk)) -> Facts {
    let mut w = BodyWalk { src, facts: Facts::default() };
    visit(&mut w);
    w.facts
}

/// One endpoint: its kind (the convention is per kind and package), what it is called, and what it does.
#[derive(Clone, Debug)]
struct Endpoint {
    kind: &'static str,
    label: String,
    key: String,
    path: String,
    span: Span,
    facts: Facts,
    /// Local names the handler is made of (`export const GET = handler`), resolved against the file's functions.
    refs: Vec<String>,
    /// Receiver and position of a route registration, for router-level `.use(auth)` before it.
    registration: Option<(String, u32)>,
    /// A server action or function lint already reports (a write with no identity call).
    lint_reports: bool,
    /// Said to be public where it is declared: a comment above it, or route options naming it public.
    said_public: bool,
}

/// A `.use(...)` or `.addHook(...)`: the middleware it installs for routes registered after it on that receiver.
struct UseGuard {
    receiver: String,
    prefix: String,
    callees: Vec<String>,
    at: u32,
}

/// A router mounted with `.use(prefix, ..., name)` or `.route(prefix, name)`: guarded when a middleware passed with it,
/// or installed before it on the same receiver, checks identity.
struct Mount {
    receiver: String,
    prefix: String,
    name: String,
    callees: Vec<String>,
    at: u32,
}

/// A Next.js middleware: the names it calls, its matcher, and Clerk route matchers (public or not).
#[derive(Default)]
struct Middleware {
    callees: Vec<String>,
    matcher: Vec<String>,
    matchers: Vec<(bool, Vec<String>)>,
}

#[derive(Default)]
struct FileFacts {
    file: String,
    endpoints: Vec<(Endpoint, u32, u32)>,
    funcs: Vec<(String, Facts)>,
    /// Routers this file mounts, with the import source of each.
    mounts: Vec<(Mount, Option<String>)>,
    use_guards: Vec<UseGuard>,
    middleware: Option<Middleware>,
    /// A `createClient` imported from a Supabase server module makes a session client.
    session_create_client: bool,
    /// Imported names and where from (`import` and `require`).
    imports: HashMap<String, String>,
}

struct Walker<'s> {
    src: &'s str,
    file: &'s str,
    lines: Lines,
    use_server_file: bool,
    imports: HashMap<String, String>,
    out: FileFacts,
    mounts: Vec<Mount>,
    matchers: Vec<(bool, Vec<String>)>,
    /// Names bound to a router (`const r = express.Router()`), so named handlers on them are registrations.
    routers: HashSet<String>,
    /// The variable being declared, which names a server function.
    binding: Option<String>,
    /// Other names for the same app (`typedApp` for `app`).
    aliases: HashMap<String, String>,
    /// Inside a development-only branch: registrations there never ship.
    dev_only: u32,
}

/// The URL a file-routed endpoint answers: `app/api/invoices/[id]/route.ts` is `/api/invoices/[id]`.
fn route_path(file: &str, marker: &str) -> String {
    let inner = format!("/{marker}/");
    let at = file.rfind(&inner).map(|i| i + inner.len()).or_else(|| file.starts_with(&inner[1..]).then_some(inner.len() - 1)).unwrap_or(0);
    let dir = file[at..].rsplit_once('/').map_or("", |(d, _)| d);
    let parts: Vec<&str> =
        dir.split('/').filter(|p| !(p.is_empty() || p.starts_with('@') || (p.starts_with('(') && p.ends_with(')')))).collect();
    format!("/{}", parts.join("/"))
}

/// A Remix / React Router route file's URL: `app/routes/api.invoices.$id.tsx` is `/api/invoices/$id`.
fn remix_path(file: &str) -> String {
    let name = file.rsplit('/').next().unwrap_or(file);
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    let stem = if stem == "route" { file.rsplit('/').nth(1).unwrap_or("") } else { stem };
    format!("/{}", stem.split('.').filter(|p| !p.starts_with('_')).collect::<Vec<_>>().join("/"))
}

/// What sort of endpoints a file's exports make.
struct FileKind {
    route: bool,
    svelte_page: bool,
    pages_api: bool,
    remix: bool,
    convex: bool,
    middleware: bool,
    path: String,
}

fn file_kind(file: &str) -> FileKind {
    let name = file.rsplit('/').next().unwrap_or(file);
    let next_route = NEXT_ROUTE.is_match(file);
    let svelte_server = name.starts_with("+server.");
    let svelte_page = name.starts_with("+page.server.");
    let pages_api = PAGES_API.is_match(file);
    let remix = !next_route && !svelte_server && !svelte_page && (file.contains("/routes/") || file.starts_with("routes/"));
    let path = if svelte_server || svelte_page {
        route_path(file, "routes")
    } else if pages_api {
        let p = file.rsplit_once("pages/").map_or(file, |(_, r)| r);
        let p = p.rsplit_once('.').map_or(p, |(s, _)| s);
        format!("/{}", p.trim_end_matches("/index"))
    } else if remix {
        remix_path(file)
    } else {
        route_path(file, "app")
    };
    FileKind {
        route: next_route || svelte_server,
        svelte_page,
        pages_api,
        remix,
        convex: file.starts_with("convex/") || file.contains("/convex/"),
        middleware: MIDDLEWARE_FILE.is_match(file) && !file.contains("/app/") && !file.contains("/lib/"),
        path,
    }
}

impl<'s> Walker<'s> {
    fn line(&self, offset: u32) -> u32 {
        self.lines.line(offset as usize)
    }

    fn push(&mut self, e: Endpoint) {
        if self.dev_only > 0 {
            return;
        }
        let (start, end) = (self.line(e.span.start), self.line(e.span.end));
        self.out.endpoints.push((e, start, end));
    }

    /// The facts of a handler expression: a function's body, a wrapper call's names and arguments, a local name.
    fn handler(&self, e: &Expression, facts: &mut Facts, refs: &mut Vec<String>) {
        match e.get_inner_expression() {
            Expression::ArrowFunctionExpression(f) => facts.merge(&facts_of(self.src, |w| w.visit_function_body(&f.body))),
            Expression::FunctionExpression(f) => {
                if let Some(body) = &f.body {
                    facts.merge(&facts_of(self.src, |w| w.visit_function_body(body)));
                }
            }
            Expression::Identifier(id) => {
                refs.push(id.name.to_string());
                facts.callees.push(id.name.to_string());
            }
            Expression::CallExpression(c) => self.handler_call(c, facts, refs),
            Expression::ArrayExpression(a) => {
                for el in &a.elements {
                    if let Some(x) = el.as_expression() {
                        self.handler(x, facts, refs);
                    }
                }
            }
            Expression::ObjectExpression(o) => {
                for p in &o.properties {
                    let ObjectPropertyKind::ObjectProperty(p) = p else { continue };
                    let key = p.key.static_name().map(|k| k.to_string()).unwrap_or_default();
                    // An OpenAPI schema documents auth (`security: [{ bearerAuth: [] }]`); it enforces nothing.
                    if matches!(key.as_str(), "schema" | "security" | "response" | "body" | "querystring" | "params") {
                        continue;
                    }
                    // Route options a framework enforces: `config: { permission: "x" }`, `preHandler`, `auth: "jwt"`.
                    let off = matches!(p.value.get_inner_expression(), Expression::BooleanLiteral(b) if !b.value)
                        || matches!(p.value.get_inner_expression(), Expression::NullLiteral(_));
                    if IDENTITY.is_match(&key) && !NOT_IDENTITY.is_match(&key) && !off {
                        facts.callees.push(format!("@{key}"));
                    }
                    self.handler(&p.value, facts, refs);
                }
            }
            Expression::StaticMemberExpression(_) => chain_names(e, &mut facts.callees),
            _ => {}
        }
    }

    /// A wrapper call's names and arguments, with the earlier calls of its chain: `.use(isAuthed)`, `.middleware([a])`.
    fn handler_call(&self, c: &CallExpression, facts: &mut Facts, refs: &mut Vec<String>) {
        chain_names(&c.callee, &mut facts.callees);
        for arg in &c.arguments {
            if let Some(a) = arg.as_expression() {
                self.handler(a, facts, refs);
            }
        }
        let mut callee = c.callee.get_inner_expression();
        while let Expression::StaticMemberExpression(m) = callee {
            let Expression::CallExpression(inner) = m.object.get_inner_expression() else { break };
            for arg in &inner.arguments {
                if let Some(a) = arg.as_expression() {
                    self.handler(a, facts, refs);
                }
            }
            callee = inner.callee.get_inner_expression();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn endpoint(
        &self,
        kind: &'static str,
        label: String,
        key: String,
        path: String,
        span: Span,
        e: Option<&Expression>,
        f: Option<&Function>,
    ) -> Endpoint {
        let (mut facts, mut refs) = (Facts::default(), Vec::new());
        if let Some(e) = e {
            self.handler(e, &mut facts, &mut refs);
        }
        if let Some(body) = f.and_then(|f| f.body.as_ref()) {
            facts.merge(&facts_of(self.src, |w| w.visit_function_body(body)));
        }
        // A comment in the three lines above: "Public endpoint", "Anonymous accept route", "no auth".
        let start = self.line(span.start) as usize;
        let said_public = self.src.lines().skip(start.saturating_sub(4)).take(start.saturating_sub(1).min(3)).any(|l| {
            let t = l.trim_start();
            (t.starts_with("//") || t.starts_with('*') || t.starts_with("/*")) && SAID_PUBLIC.is_match(t)
        });
        Endpoint { kind, label, key, path, span, facts, refs, registration: None, lint_reports: false, said_public }
    }

    /// The endpoints a file-routed module exports.
    fn exports(&mut self, program: &Program) {
        let k = file_kind(self.file);
        for stmt in &program.body {
            match stmt {
                Statement::ExportNamedDeclaration(ex) => {
                    match &ex.declaration {
                        Some(Declaration::FunctionDeclaration(f)) => {
                            let n = f.id.as_ref().map_or(String::new(), |i| i.name.to_string());
                            self.export_item(&k, &n, f.span, None, Some(f), f.r#async);
                        }
                        Some(Declaration::VariableDeclaration(v)) => {
                            for d in &v.declarations {
                                let (BindingPattern::BindingIdentifier(id), Some(init)) = (&d.id, &d.init) else { continue };
                                let n = id.name.to_string();
                                if k.svelte_page && n == "actions" {
                                    if let Expression::ObjectExpression(o) = init.get_inner_expression() {
                                        for p in &o.properties {
                                            let ObjectPropertyKind::ObjectProperty(p) = p else { continue };
                                            let key = p.key.static_name().map_or("default".to_string(), |k| k.to_string());
                                            let e = self.endpoint(
                                                "form action",
                                                format!("form action {key} of {}", k.path),
                                                format!("actions.{key}"),
                                                format!("{}/{key}", k.path),
                                                p.span,
                                                Some(&p.value),
                                                None,
                                            );
                                            self.push(e);
                                        }
                                    }
                                    continue;
                                }
                                let inner = init.get_inner_expression();
                                let is_async = matches!(inner, Expression::ArrowFunctionExpression(a) if a.r#async)
                                    || matches!(inner, Expression::FunctionExpression(f) if f.r#async)
                                    || matches!(inner, Expression::CallExpression(_));
                                self.export_item(&k, &n, d.span, Some(init), None, is_async);
                            }
                        }
                        _ => {}
                    }
                    // `export { handler as GET, handler as POST }`
                    if k.route && ex.source.is_none() {
                        for s in &ex.specifiers {
                            let exported = s.exported.name().to_string();
                            if METHODS.contains(&exported.as_str()) {
                                let local = s.local.name().to_string();
                                let mut e = self.endpoint(
                                    "route handler",
                                    format!("{exported} {}", k.path),
                                    exported.clone(),
                                    k.path.clone(),
                                    s.span,
                                    None,
                                    None,
                                );
                                e.refs.push(local.clone());
                                e.facts.callees.push(local);
                                self.push(e);
                            }
                        }
                    }
                }
                Statement::ExportDefaultDeclaration(ex) if k.pages_api => {
                    let e = match &ex.declaration {
                        ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                            self.endpoint("route handler", k.path.clone(), "default".into(), k.path.clone(), ex.span, None, Some(f))
                        }
                        kind => match kind.as_expression() {
                            Some(e) => {
                                self.endpoint("route handler", k.path.clone(), "default".into(), k.path.clone(), ex.span, Some(e), None)
                            }
                            None => continue,
                        },
                    };
                    self.push(e);
                }
                _ => {}
            }
        }
        if k.middleware {
            let mut m = Middleware { callees: facts_of(self.src, |w| w.visit_program(program)).callees, ..Default::default() };
            for stmt in &program.body {
                let Statement::ExportNamedDeclaration(ex) = stmt else { continue };
                let Some(Declaration::VariableDeclaration(v)) = &ex.declaration else { continue };
                for d in &v.declarations {
                    let (BindingPattern::BindingIdentifier(id), Some(Expression::ObjectExpression(o))) =
                        (&d.id, d.init.as_ref().map(|e| e.get_inner_expression()))
                    else {
                        continue;
                    };
                    if id.name != "config" {
                        continue;
                    }
                    for p in &o.properties {
                        let ObjectPropertyKind::ObjectProperty(p) = p else { continue };
                        if p.key.static_name().is_some_and(|k| k == "matcher") {
                            m.matcher = strings(&p.value);
                        }
                    }
                }
            }
            self.out.middleware = Some(m);
        }
    }

    /// An exported function or constant, as whatever endpoint its file makes it.
    fn export_item(&mut self, k: &FileKind, name: &str, span: Span, init: Option<&Expression>, f: Option<&Function>, is_async: bool) {
        if k.route && METHODS.contains(&name) {
            let e = self.endpoint("route handler", format!("{name} {}", k.path), name.to_string(), k.path.clone(), span, init, f);
            self.push(e);
        } else if k.remix && (name == "action" || name == "loader") {
            let e = self.endpoint(
                if name == "action" { "action" } else { "loader" },
                format!("{name} of {}", k.path),
                name.to_string(),
                k.path.clone(),
                span,
                init,
                f,
            );
            self.push(e);
        } else if k.convex && init.is_some() {
            let Some(Expression::CallExpression(c)) = init.map(|e| e.get_inner_expression()) else { return };
            let callee = last_name(&c.callee);
            let builder = |plain: &str, suffix: &str| callee == plain || (callee.ends_with(suffix) && !callee.starts_with("internal"));
            let kind = if builder("mutation", "Mutation") {
                "Convex mutation"
            } else if builder("query", "Query") {
                "Convex query"
            } else if builder("action", "Action") {
                "Convex action"
            } else {
                return;
            };
            let mut e = self.endpoint(
                kind,
                format!("{} {name}", kind.to_lowercase()),
                name.to_string(),
                format!("{}/{name}", self.file),
                span,
                init,
                None,
            );
            // A plain `mutation(...)` is the unguarded builder; a custom one (`authedMutation`) carries its own check.
            e.facts.callees.retain(|c| c != "mutation" && c != "query" && c != "action");
            self.push(e);
        } else if self.use_server_file && is_async && !name.is_empty() {
            let mut e = self.endpoint(
                "server action",
                format!("server action {name}"),
                name.to_string(),
                format!("{}/{name}", self.file),
                span,
                init,
                f,
            );
            e.lint_reports = e.facts.change && !e.facts.lint_identity;
            self.push(e);
        }
    }
}

impl<'a> Visit<'a> for Walker<'_> {
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        for s in it.specifiers.iter().flatten() {
            let local = s.local().name.to_string();
            if local == "createClient" && it.source.value.contains("supabase") && it.source.value.contains("server") {
                self.out.session_create_client = true;
            }
            self.imports.insert(local, it.source.value.to_string());
        }
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        // CommonJS: `const routes = require("./routes")`, `const { apiKeyAuth } = require("./auth")`.
        if let Some(Expression::CallExpression(c)) = it.init.as_ref().map(|e| e.get_inner_expression()) {
            let source = c.arguments.first().and_then(|a| a.as_expression()).and_then(string_value);
            if let (true, Some(source)) = (last_name(&c.callee) == "require", source) {
                match &it.id {
                    BindingPattern::BindingIdentifier(id) => {
                        self.imports.insert(id.name.to_string(), source);
                    }
                    BindingPattern::ObjectPattern(o) => {
                        for p in &o.properties {
                            if let BindingPattern::BindingIdentifier(id) = &p.value {
                                self.imports.insert(id.name.to_string(), source.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&it.id, &it.init) {
            let facts = facts_of(self.src, |w| w.visit_expression(init));
            match init.get_inner_expression() {
                Expression::CallExpression(c) => {
                    let mut names = Vec::new();
                    chain_names(&c.callee, &mut names);
                    // Clerk's `createRouteMatcher([...])`: which paths a middleware protects or leaves public.
                    if names.first().is_some_and(|n| n == "createRouteMatcher") {
                        let patterns = c.arguments.first().and_then(|a| a.as_expression()).map(strings).unwrap_or_default();
                        self.matchers.push((PUBLIC_MATCHER.is_match(&id.name), patterns));
                    }
                    if names.iter().any(|n| ROUTER_MAKER.is_match(n)) {
                        self.routers.insert(id.name.to_string());
                    }
                    // `const typedApp = app.withTypeProvider<Zod>()` is the same app: hooks on one guard routes on the other.
                    if names.first().is_some_and(|n| n == "withTypeProvider" || n == "basePath") {
                        if let Some(root) = chain_root(&c.callee) {
                            let root = self.aliases.get(root).cloned().unwrap_or_else(|| root.to_string());
                            self.aliases.insert(id.name.to_string(), root);
                            self.routers.insert(id.name.to_string());
                        }
                    }
                }
                Expression::NewExpression(n) if ROUTER_MAKER.is_match(&last_name(&n.callee)) => {
                    self.routers.insert(id.name.to_string());
                }
                _ => {}
            }
            // A function, or a builder of one (`t.procedure.use(isAuthed)`, `customMutation(mutation, ...)`), can carry
            // a check for whatever calls it; a value (`const all = await Promise.all(...)`) cannot.
            let builder = match init.get_inner_expression() {
                Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => true,
                Expression::CallExpression(c) => {
                    let mut names = Vec::new();
                    chain_names(&c.callee, &mut names);
                    names.iter().any(|n| n == "use" || n == "middleware")
                        || c.arguments.iter().any(|a| {
                            matches!(
                                a.as_expression().map(|e| e.get_inner_expression()),
                                Some(
                                    Expression::ArrowFunctionExpression(_)
                                        | Expression::FunctionExpression(_)
                                        | Expression::CallExpression(_)
                                        | Expression::ObjectExpression(_)
                                )
                            )
                        })
                }
                _ => false,
            };
            if builder {
                self.out.funcs.push((id.name.to_string(), facts));
            }
            let saved = self.binding.replace(id.name.to_string());
            walk::walk_variable_declarator(self, it);
            self.binding = saved;
            return;
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_if_statement(&mut self, it: &IfStatement<'a>) {
        // `if (process.env.NODE_ENV === "development") app.get("/debug", ...)`: a route that never ships.
        let test = &self.src[it.test.span().start as usize..it.test.span().end as usize];
        if DEV_ONLY.is_match(test) {
            self.visit_expression(&it.test);
            self.dev_only += 1;
            self.visit_statement(&it.consequent);
            self.dev_only -= 1;
            if let Some(alt) = &it.alternate {
                self.visit_statement(alt);
            }
            return;
        }
        walk::walk_if_statement(self, it);
    }

    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        if let (Some(id), Some(body)) = (&it.id, &it.body) {
            self.out.funcs.push((id.name.to_string(), facts_of(self.src, |w| w.visit_function_body(body))));
        }
        let inline = it.body.as_ref().is_some_and(|b| b.directives.iter().any(|d| d.directive == "use server"));
        if inline && !self.use_server_file {
            let name = it.id.as_ref().map_or("inline".to_string(), |i| i.name.to_string());
            let mut e = self.endpoint(
                "server action",
                format!("server action {name}"),
                name.clone(),
                format!("{}/{name}", self.file),
                it.span,
                None,
                Some(it),
            );
            e.lint_reports = e.facts.change && !e.facts.lint_identity;
            self.push(e);
        }
        walk::walk_function(self, it, flags);
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        // tRPC: `save: protectedProcedure.input(x).mutation(async ({ ctx }) => ...)`.
        if let Expression::CallExpression(c) = it.value.get_inner_expression() {
            if let Expression::StaticMemberExpression(m) = c.callee.get_inner_expression() {
                let op = m.property.name.as_str();
                let mut names = Vec::new();
                chain_names(&c.callee, &mut names);
                if (op == "mutation" || op == "query") && names.iter().any(|n| n.to_lowercase().ends_with("procedure")) {
                    let key = it.key.static_name().map_or(String::new(), |k| k.to_string());
                    let kind = if op == "mutation" { "tRPC mutation" } else { "tRPC query" };
                    let mut e = self.endpoint(
                        kind,
                        format!("{kind} {key}"),
                        key.clone(),
                        format!("{}/{key}", self.file),
                        it.span,
                        Some(&it.value),
                        None,
                    );
                    // `publicProcedure` and `t.procedure` are the unguarded bases; their names say nothing.
                    e.facts.callees.retain(|n| !BARE_PROCEDURE.is_match(n) && n != "t");
                    self.push(e);
                }
            }
        }
        walk::walk_object_property(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::StaticMemberExpression(m) = it.callee.get_inner_expression() {
            let verb = m.property.name.as_str();
            let receiver = chain_root(&m.object).unwrap_or("");
            let receiver = self.aliases.get(receiver).cloned().unwrap_or_else(|| receiver.to_string());
            let args: Vec<&Expression> = it.arguments.iter().filter_map(|a| a.as_expression()).collect();
            let first = args.first().and_then(|a| string_value(a));
            let msw = self.imports.values().any(|s| s == "msw" || s.starts_with("msw/"));
            // A route registration: a path, then handlers, the last one a function or (on a router) a named handler.
            if VERBS.contains(&verb)
                && args.len() >= 2
                && first.as_deref().is_some_and(|p| p.starts_with('/'))
                && !msw
                && !CLIENT_NAME.is_match(&receiver)
            {
                let last = args[args.len() - 1];
                let handler_like =
                    matches!(last.get_inner_expression(), Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_));
                let router = ROUTER_NAME.is_match(&receiver) || self.routers.contains(&receiver);
                let named = matches!(
                    last.get_inner_expression(),
                    Expression::Identifier(_) | Expression::CallExpression(_) | Expression::StaticMemberExpression(_)
                );
                if handler_like || (router && named) {
                    let path = first.clone().unwrap_or_default();
                    let method = if verb == "del" { "DELETE".to_string() } else { verb.to_uppercase() };
                    let mut e =
                        self.endpoint("route handler", format!("{method} {path}"), format!("{method} {path}"), path, it.span, None, None);
                    for a in &args[1..] {
                        self.handler(a, &mut e.facts, &mut e.refs);
                    }
                    e.registration = Some((receiver.clone(), it.span.start));
                    // Route options that say so: `description: "Unauthenticated, rate-limited by IP"`, `publicXSchema`.
                    if args.len() > 2 {
                        let (from, to) = (args[1].span().start as usize, args[args.len() - 2].span().end as usize);
                        e.said_public |= SAID_PUBLIC.is_match(&self.src[from..to]);
                    }
                    self.push(e);
                }
            }
            // A middleware for what follows on the receiver: `router.use(requireAuth)`, `app.use("/api/*", jwt(...))`,
            // and routers mounted with it: `app.use("/admin", requireAdmin, adminRouter)`, `app.route("/x", x)`.
            if verb == "use" || verb == "addHook" || verb == "route" || verb == "register" {
                let (mut facts, mut refs) = (Facts::default(), Vec::new());
                let mut names = Vec::new();
                for a in &args {
                    match a.get_inner_expression() {
                        Expression::Identifier(id)
                            if self.imports.contains_key(id.name.as_str()) || self.routers.contains(id.name.as_str()) =>
                        {
                            names.push(id.name.to_string())
                        }
                        _ if string_value(a).is_none() => self.handler(a, &mut facts, &mut refs),
                        _ => {}
                    }
                }
                // `addHook("onRequest", ...)` names an event, not a path.
                let prefix = first.clone().filter(|p| p.starts_with('/') || p.starts_with('*')).unwrap_or_default();
                // Each name may be the router mounted, the others its middleware (`app.use("/v1", authRouter, routes)`).
                for name in &names {
                    let callees = facts.callees.iter().chain(names.iter().filter(|n| *n != name)).cloned().collect();
                    self.mounts.push(Mount {
                        receiver: receiver.clone(),
                        prefix: prefix.clone(),
                        name: name.clone(),
                        callees,
                        at: it.span.start,
                    });
                }
                if verb == "use" || verb == "addHook" {
                    facts.callees.extend(names);
                    self.out.use_guards.push(UseGuard { receiver: receiver.clone(), prefix, callees: facts.callees, at: it.span.start });
                }
            }
            // TanStack Start: `createServerFn(...).middleware([...]).handler(fn)`.
            if verb == "handler" {
                let mut names = Vec::new();
                chain_names(&it.callee, &mut names);
                if names.iter().any(|n| n == "createServerFn") {
                    let name = self.binding.clone().unwrap_or_else(|| format!("at line {}", self.line(it.span.start)));
                    let mut e = self.endpoint(
                        "server function",
                        format!("server function {name}"),
                        name.clone(),
                        format!("{}/{name}", self.file),
                        it.span,
                        None,
                        None,
                    );
                    self.handler_call(it, &mut e.facts, &mut e.refs);
                    e.lint_reports = e.facts.change && !e.facts.lint_identity && !names.iter().any(|n| n == "middleware");
                    self.push(e);
                }
            }
        }
        walk::walk_call_expression(self, it);
    }
}

fn walk_file(file: &str, src: &str) -> Option<FileFacts> {
    crate::js::parse(file, src, |program| {
        let use_server_file = program.directives.iter().any(|d| d.directive == "use server");
        let mut w = Walker {
            src,
            file,
            lines: Lines::new(src),
            use_server_file,
            imports: HashMap::new(),
            out: FileFacts { file: file.to_string(), ..Default::default() },
            mounts: vec![],
            matchers: vec![],
            routers: HashSet::new(),
            binding: None,
            aliases: HashMap::new(),
            dev_only: 0,
        };
        // Imports first, so registrations know which names are mounted routers.
        for stmt in &program.body {
            if let Statement::ImportDeclaration(i) = stmt {
                w.visit_import_declaration(i);
            }
        }
        w.exports(program);
        w.visit_program(program);
        let matchers = std::mem::take(&mut w.matchers);
        if let Some(m) = w.out.middleware.as_mut() {
            m.matchers = matchers;
        }
        let mounts = std::mem::take(&mut w.mounts);
        w.out.mounts = mounts
            .into_iter()
            .map(|m| {
                let source = w.imports.get(&m.name).cloned();
                (m, source)
            })
            .collect();
        w.out.imports = std::mem::take(&mut w.imports);
        w.out
    })
}

/// A path-to-regexp pattern (`/dashboard/:path*`, `/((?!api|_next).*)`, `/admin(.*)`) as an anchored regex.
fn matcher_regex(pattern: &str) -> Option<Fancy> {
    let mut out = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && chars.get(i + 1) == Some(&':') {
            let mut j = i + 2;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            match chars.get(j) {
                Some('*') => {
                    out.push_str("(?:/.*)?");
                    j += 1;
                }
                Some('+') => {
                    out.push_str("/.+");
                    j += 1;
                }
                Some('?') => {
                    out.push_str("(?:/[^/]+)?");
                    j += 1;
                }
                _ => out.push_str("/[^/]+"),
            }
            i = j;
            continue;
        }
        if c == '.' && !(i > 0 && chars[i - 1] == '\\') && !pattern[..pattern.char_indices().nth(i).map_or(0, |(b, _)| b)].contains('(') {
            out.push_str("\\.");
        } else {
            out.push(c);
        }
        i += 1;
    }
    out.push_str("/?$");
    Fancy::new(&out).ok()
}

/// Whether a middleware's patterns cover a path; an unreadable pattern counts as covering (it may well).
fn covers(patterns: &[String], path: &str) -> bool {
    let probe = path.replace(['[', ']'], "");
    patterns.iter().any(|p| matcher_regex(p).is_none_or(|re| re.is_match(&probe).unwrap_or(true)))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// Every endpoint with what guards it, as `data`, for tuning the convention on a real project; the CLI never asks.
    #[serde(default)]
    explain: bool,
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let Options { explain } = request.options()?;
    let files: Vec<FileFacts> = request.files.par_iter().filter_map(|f| walk_file(f, &text::read(&request.root, f)?)).collect();

    // Names that check identity: by name, then whatever calls them (a project's own `requireOrgMember()`).
    let session_files: HashSet<&str> = files.iter().filter(|f| f.session_create_client).map(|f| f.file.as_str()).collect();
    let mut identity: HashSet<String> = files
        .iter()
        .flat_map(|f| f.funcs.iter().flat_map(|(n, facts)| std::iter::once(n.clone()).chain(facts.callees.iter().cloned())))
        .chain(files.iter().flat_map(|f| f.endpoints.iter().flat_map(|(e, _, _)| e.facts.callees.iter().cloned())))
        .chain(files.iter().flat_map(|f| f.use_guards.iter().flat_map(|g| g.callees.iter().cloned())))
        .chain(files.iter().flat_map(|f| f.mounts.iter().flat_map(|(m, _)| m.callees.iter().cloned())))
        .chain(files.iter().filter_map(|f| f.middleware.as_ref()).flat_map(|m| m.callees.iter().cloned()))
        .filter(|n| (IDENTITY.is_match(n) && !NOT_IDENTITY.is_match(n)) || SESSION_CLIENTS.contains(&n.as_str()))
        .collect();
    for _ in 0..3 {
        let grown: Vec<String> = files
            .iter()
            .flat_map(|f| &f.funcs)
            .filter(|(n, facts)| {
                // A client factory checks only when it makes a session client (`createSupabaseServerClient` over
                // `createServerClient`); an admin or service-role one bypasses checks, whatever else it calls.
                let checks = if CLIENT_FACTORY.is_match(n) {
                    facts.callees.iter().any(|c| SESSION_CLIENTS.contains(&c.as_str()))
                } else {
                    facts.caller_read || facts.callees.iter().any(|c| identity.contains(c))
                };
                !GENERIC.contains(&n.as_str()) && !identity.contains(n) && checks
            })
            .map(|(n, _)| n.clone())
            .collect();
        if grown.is_empty() {
            break;
        }
        identity.extend(grown);
    }
    // Modules that install a guarding middleware (`router.use(apiKeyAuth)`): mounting one guards what follows.
    let known: HashSet<&str> = files.iter().map(|f| f.file.as_str()).collect();
    let guarding_modules: HashSet<&str> = files
        .iter()
        .filter(|f| f.use_guards.iter().any(|g| g.callees.iter().any(|c| identity.contains(c))))
        .map(|f| f.file.as_str())
        .collect();
    let checks = |facts: &Facts, f: &FileFacts| -> Option<String> {
        // Named for what it does first (`getUser`), then a project helper that calls one (`loadDashboard`).
        let named = facts.callees.iter().find(|c| identity.contains(*c) && IDENTITY.is_match(c));
        if let Some(name) = named.or_else(|| {
            facts
                .callees
                .iter()
                .find(|c| identity.contains(*c) || (c.as_str() == "createClient" && session_files.contains(f.file.as_str())))
        }) {
            return Some(match name.strip_prefix('@') {
                Some(option) => format!("a `{option}` route option"),
                None => format!("{name}()"),
            });
        }
        let module = facts.callees.iter().find(|c| {
            f.imports
                .get(*c)
                .and_then(|s| crate::graph::resolve_relative(&known, &f.file, s))
                .is_some_and(|t| guarding_modules.contains(t.as_str()))
        });
        if let Some(name) = module {
            return Some(format!("the {name} middleware"));
        }
        (facts.caller_read || facts.secret).then(|| "a check on the caller".to_string())
    };

    // Routers mounted behind a guarding middleware: every registration in their file is guarded.
    let mut guarded_files: HashMap<String, String> = HashMap::new();
    for f in &files {
        for (m, source) in &f.mounts {
            let with = checks(&Facts { callees: m.callees.clone(), ..Default::default() }, f);
            let before = f
                .use_guards
                .iter()
                .filter(|g| g.receiver == m.receiver && g.at < m.at && m.prefix.starts_with(g.prefix.trim_end_matches(['*', '/'])))
                .find_map(|g| checks(&Facts { callees: g.callees.clone(), ..Default::default() }, f));
            if let (Some(how), Some(target)) =
                (with.or(before), source.as_deref().and_then(|s| crate::graph::resolve_relative(&known, &f.file, s)))
            {
                guarded_files.insert(target, how);
            }
        }
    }

    // Next.js middleware per package: the paths it guards.
    let mut packages = HashMap::new();
    let mut middleware: HashMap<String, &Middleware> = HashMap::new();
    for f in &files {
        if let Some(m) = &f.middleware {
            if checks(&Facts { callees: m.callees.clone(), ..Default::default() }, f).is_some() {
                middleware.insert(crate::graph::package_of(&request.root, &f.file, &mut packages), m);
            }
        }
    }

    struct Judged<'f> {
        file: &'f str,
        line: u32,
        endpoint: Endpoint,
        guard: Option<String>,
        changed: bool,
    }
    let mut groups: BTreeMap<(String, &'static str), Vec<Judged>> = BTreeMap::new();
    let mut total = 0;
    for f in &files {
        let local: HashMap<&str, &Facts> = f.funcs.iter().map(|(n, facts)| (n.as_str(), facts)).collect();
        let package = crate::graph::package_of(&request.root, &f.file, &mut packages);
        for (e, start, end) in &f.endpoints {
            total += 1;
            let mut e = e.clone();
            for r in e.refs.clone() {
                match local.get(r.as_str()) {
                    Some(facts) => e.facts.merge(facts),
                    // A handler from another module may do anything.
                    None => e.facts.io = true,
                }
            }
            let mut guard = checks(&e.facts, f);
            if guard.is_none() {
                if let Some((receiver, at)) = &e.registration {
                    guard = f
                        .use_guards
                        .iter()
                        .filter(|g| &g.receiver == receiver && g.at < *at && e.path.starts_with(g.prefix.trim_end_matches(['*', '/'])))
                        .find_map(|g| checks(&Facts { callees: g.callees.clone(), ..Default::default() }, f));
                    guard = guard.or_else(|| guarded_files.get(&f.file).cloned());
                }
            }
            if guard.is_none() && e.kind == "route handler" {
                if let Some(m) = middleware.get(&package) {
                    let by_matcher = m.matcher.is_empty() || covers(&m.matcher, &e.path);
                    let public = m.matchers.iter().any(|(public, p)| *public && covers(p, &e.path));
                    let protected = m.matchers.iter().filter(|(public, _)| !public).collect::<Vec<_>>();
                    let named = protected.is_empty() || protected.iter().any(|(_, p)| covers(p, &e.path));
                    if by_matcher && !public && named {
                        guard = Some("the middleware".to_string());
                    }
                }
            }
            let changed = (*start..=*end).any(|l| request.changed(&f.file, l));
            groups.entry((package.clone(), e.kind)).or_default().push(Judged { file: &f.file, line: *start, endpoint: e, guard, changed });
        }
    }

    let whole = request.added.is_none();
    // A router file none of whose routes checks identity is guarded where it is mounted, or public as a whole; the
    // mount may be out of sight (`app.use(prefix, service.middleware, service.routes)`), so its routes are not judged.
    let files_with_guards: HashSet<&str> = groups.values().flatten().filter(|j| j.guard.is_some()).map(|j| j.file).collect();
    let mut findings = Vec::new();
    for ((_, kind), list) in &groups {
        // Public by design, or nothing to protect (it reads and writes nothing outside the request).
        let public = |j: &Judged| {
            j.endpoint.said_public
                || PUBLIC.is_match(&j.endpoint.path)
                || PUBLIC.is_match(j.file)
                || PUBLIC.is_match(&j.endpoint.key)
                || (j.guard.is_none() && !j.endpoint.facts.io)
        };
        let seen = |j: &Judged| j.endpoint.registration.is_none() || files_with_guards.contains(j.file);
        let candidate = |j: &Judged| j.guard.is_none() && j.changed && !public(j) && !j.endpoint.lint_reports && seen(j);
        // The convention is read from the endpoints this change does not call into question.
        let basis: Vec<&Judged> = list.iter().filter(|j| !public(j) && (whole || !candidate(j))).collect();
        let guarded: Vec<&&Judged> = basis.iter().filter(|j| j.guard.is_some()).collect();
        if basis.len() < MIN_ENDPOINTS || (guarded.len() as f64) < MIN_SHARE * basis.len() as f64 {
            continue;
        }
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for j in &guarded {
            *counts.entry(j.guard.as_deref().unwrap_or("")).or_default() += 1;
        }
        let usual = counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))).map_or(String::new(), |(g, _)| g.to_string());
        for j in list.iter().filter(|j| candidate(j)) {
            findings.push(Finding {
                file: j.file.to_string(),
                line: j.line,
                target: format!("auth:{}:{}", j.file, j.endpoint.key),
                message: format!(
                    "{}:{} {} has no auth check, while {} of {} {}s here check who is calling (most with {usual}): add the same check before it reads or writes anything, and limit it to what that caller may see; do not leave it to the client. If it is public by design, acknowledge it",
                    j.file,
                    j.line,
                    j.endpoint.label,
                    guarded.len(),
                    basis.len(),
                    kind
                ),
            });
        }
    }
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    let guarded_count = groups.values().flatten().filter(|j| j.guard.is_some()).count();
    let data = explain.then(|| {
        serde_json::Value::Array(
            groups
                .values()
                .flatten()
                .map(|j| {
                    serde_json::json!([
                        j.file,
                        j.line,
                        j.endpoint.kind,
                        j.endpoint.label,
                        j.guard,
                        j.endpoint.facts.io,
                        j.endpoint.said_public
                    ])
                })
                .collect(),
        )
    });
    Ok(Answer {
        findings,
        summary: format!("{total} endpoints in {} files, {guarded_count} check who is calling", request.files.len()),
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoints(file: &str, src: &str) -> Vec<(String, &'static str, bool)> {
        let f = walk_file(file, src).unwrap();
        f.endpoints
            .iter()
            .map(|(e, _, _)| {
                (
                    e.label.clone(),
                    e.kind,
                    e.facts.callees.iter().any(|c| IDENTITY.is_match(c) && !NOT_IDENTITY.is_match(c))
                        || e.facts.caller_read
                        || e.facts.secret,
                )
            })
            .collect()
    }

    #[test]
    fn next_routes_actions_and_registrations() {
        assert_eq!(
            endpoints("apps/web/app/(dash)/api/invoices/[id]/route.ts", "export async function GET(req) { const user = await getUser(); return Response.json(user); }\nexport const POST = withAuth(async (req) => Response.json({}));\nexport const DELETE = async () => { await db.invoice.delete(); };\n"),
            vec![("GET /api/invoices/[id]".into(), "route handler", true), ("POST /api/invoices/[id]".into(), "route handler", true), ("DELETE /api/invoices/[id]".into(), "route handler", false)]
        );
        assert_eq!(
            endpoints(
                "src/actions.ts",
                "'use server';\nexport async function save(x) { await db.insert(t).values(x); }\nexport function helper() {}\n"
            ),
            vec![("server action save".into(), "server action", false)]
        );
        assert_eq!(
            endpoints("src/server.ts", "const app = express();\napp.get('/api/me', requireAuth, (req, res) => res.json(req.user));\nrouter.post('/api/items', createItem);\naxios.get('/api/x', config);\napi.get('/users', { params });\n"),
            vec![("GET /api/me".into(), "route handler", true), ("POST /api/items".into(), "route handler", false)]
        );
    }

    #[test]
    fn trpc_procedures_and_convex_functions() {
        let trpc = endpoints("src/server/routers/post.ts", "export const postRouter = router({ list: publicProcedure.query(() => db.post.findMany()), create: protectedProcedure.input(z.object({})).mutation(({ input }) => db.post.create({ data: input })) });");
        assert_eq!(trpc, vec![("tRPC query list".into(), "tRPC query", false), ("tRPC mutation create".into(), "tRPC mutation", true)]);
        let convex = endpoints("convex/tasks.ts", "export const add = mutation({ args: {}, handler: async (ctx, a) => { const id = await ctx.auth.getUserIdentity(); } });\nexport const all = query({ handler: async (ctx) => ctx.db.query('tasks').collect() });\nexport const sweep = internalMutation({ handler: async () => {} });\n");
        assert_eq!(
            convex,
            vec![("convex mutation add".into(), "Convex mutation", true), ("convex query all".into(), "Convex query", false)]
        );
    }

    #[test]
    fn matchers_cover_paths() {
        assert!(covers(&["/dashboard/:path*".into()], "/dashboard/settings"));
        assert!(!covers(&["/dashboard/:path*".into()], "/api/x"));
        assert!(covers(&["/((?!_next/static|_next/image|favicon.ico).*)".into()], "/api/invoices/[id]"));
        assert!(!covers(&["/((?!api|_next).*)".into()], "/api/invoices"));
        assert!(covers(&["/api(.*)".into()], "/api/invoices"));
    }

    #[test]
    fn public_paths() {
        for p in [
            "/api/auth/[...nextauth]",
            "/api/webhooks/stripe",
            "/api/health",
            "/api/cron/daily",
            "/api/og",
            "src/app/(auth)/login/route.ts",
        ] {
            assert!(PUBLIC.is_match(p), "{p}");
        }
        for p in ["/api/invoices", "/api/users/[id]", "/api/authors"] {
            assert!(!PUBLIC.is_match(p), "{p}");
        }
    }
}
