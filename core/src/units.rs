//! JavaScript and TypeScript units for the similar check: a small tokenizer that knows strings, templates, regular
//! expressions and JSX, and the top-level functions, components, hooks, classes and types it finds. Local names and
//! literals are normalised to placeholders, so a renamed or reworded copy reads the same.

use fancy_regex::Regex as Fancy;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::globals::JS_GLOBALS;

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_$\x{a0}-\x{ffff}][\w$\x{a0}-\x{ffff}]*").unwrap());
static NUM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?)n?").unwrap());
static PUNCT: LazyLock<Fancy> = LazyLock::new(|| {
    Fancy::new(r"^(?:=>|\.\.\.|\?\?=?|\?\.(?!\d)|[=!]==?|\*\*=?|&&=?|\|\|=?|<<=?|>>>?=?|\+\+|--|[-+*/%&|^<>]=?|[{}()\[\];,.:?~@#!=])")
        .unwrap()
});
// JavaScript's \s includes the byte-order mark; Rust's does not, so it is added.
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:[\s\x{feff}]+|//[^\n]*|/\*(?s:.)*?(?:\*/|\z))+").unwrap());
static TAG_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w$.:-]*").unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w$:-]+").unwrap());
static FLAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z]*").unwrap());
static JSX_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(?:jsx|tsx|js|mjs|cjs)$").unwrap());

const KEYWORDS: &[&str] = &[
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "let",
    "static",
    "async",
    "await",
    "of",
    "as",
    "interface",
    "implements",
    "private",
    "protected",
    "public",
    "readonly",
    "abstract",
    "declare",
    "keyof",
    "infer",
    "is",
    "namespace",
    "satisfies",
    "undefined",
    "string",
    "number",
    "boolean",
    "any",
    "unknown",
    "never",
    "object",
    "symbol",
    "bigint",
    "type",
];
const REGEX_AFTER_KW: &[&str] =
    &["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"];
const JSX_AFTER: &[&str] = &["(", ",", "=", ":", "?", "[", "{", "&&", "||", "??", "!", "=>", ";", "return", "default", "yield", "case"];
/// Browser globals Node lacks; everything on globalThis (Math, JSON, fetch, Promise…) is kept by name too.
const BROWSER: &[&str] = &["window", "document", "localStorage", "sessionStorage", "navigator", "location", "history"];
const CONTINUES: &[&str] = &[
    ".",
    "?.",
    ")",
    "]",
    "}",
    "=>",
    "?",
    ":",
    "|",
    "&",
    "||",
    "&&",
    "??",
    "+",
    "-",
    "*",
    "/",
    "=",
    ",",
    "as",
    "satisfies",
    "extends",
    "implements",
    ">",
    "/>",
];
const ENDS_EXPR: &[&str] = &[")", "]", "}", ">", "/>"];
const MODIFIERS: &[&str] = &["export", "default", "declare", "async", "abstract"];
const TYPE_BRACE_AFTER: &[&str] = &[":", "|", "&", "<", ",", "=>"];

#[derive(Default)]
pub struct Tokens {
    pub text: Vec<String>,
    pub kind: Vec<&'static str>,
    pub line: Vec<u32>,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Code,
    Tag,
    Children,
    Tmpl,
}

struct Lexer<'s> {
    src: &'s str,
    at: usize,
    line: u32,
    tokens: Tokens,
    stack: Vec<(Mode, i32)>,
    jsx: bool,
}

/// The largest char boundary at or below `i`.
fn floor(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl<'s> Lexer<'s> {
    fn push(&mut self, kind: &'static str, text: &str) {
        self.tokens.text.push(text.to_string());
        self.tokens.kind.push(kind);
        self.tokens.line.push(self.line);
    }

    fn advance(&mut self, end: usize) {
        let end = floor(self.src, end);
        self.line += self.src[self.at..end.max(self.at)].matches('\n').count() as u32;
        self.at = end.max(self.at);
    }

    fn byte(&self, i: usize) -> u8 {
        self.src.as_bytes().get(i).copied().unwrap_or(0)
    }

    /// End of a match of `re` starting exactly at `from`, or None.
    fn sticky(&self, re: &Regex, from: usize) -> Option<usize> {
        re.find(&self.src[floor(self.src, from)..]).map(|m| floor(self.src, from) + m.end())
    }

    fn previous(&self) -> Option<(&str, &str)> {
        let n = self.tokens.text.len();
        (n > 0).then(|| (self.tokens.text[n - 1].as_str(), self.tokens.kind[n - 1]))
    }

    fn regex_allowed(&self) -> bool {
        match self.previous() {
            None => true,
            Some((t, "kw")) => REGEX_AFTER_KW.contains(&t),
            Some((t, k)) => k == "punct" && !ENDS_EXPR.contains(&t),
        }
    }

    fn jsx_allowed(&self) -> bool {
        static START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z>]").unwrap());
        static GENERIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_$][\w$]*\s*(?:,|extends\b)").unwrap());
        if let Some((t, _)) = self.previous() {
            if !JSX_AFTER.contains(&t) {
                return false;
            }
        }
        let rest = &self.src[floor(self.src, self.at + 1)..floor(self.src, self.at + 40)];
        // `<T,>(x) =>` and `<T extends U>` are generics, not elements.
        START.is_match(rest) && !GENERIC.is_match(rest)
    }

    fn open_tag(&mut self) {
        if self.byte(self.at + 1) == b'>' {
            self.push("tag", "<>");
            self.advance(self.at + 2);
            self.stack.push((Mode::Children, 0));
            return;
        }
        let end = self.sticky(&TAG_NAME, self.at + 1).unwrap_or(self.at + 1);
        let text = format!("<{}", &self.src[self.at + 1..end]);
        self.push("tag", &text);
        self.advance(end);
        self.stack.push((Mode::Tag, 0));
    }

    /// A quoted string from `at`, up to its closing quote or the end of the line.
    fn string(&mut self, at: usize) {
        let b = self.src.as_bytes();
        let mut j = at + 1;
        while j < b.len() && b[j] != b[at] && b[j] != b'\n' {
            j += if b[j] == b'\\' { 2 } else { 1 };
        }
        let end = (j + 1).min(b.len());
        let text = self.src[at..floor(self.src, end)].to_string();
        self.push("str", &text);
        self.advance(end);
    }

    fn regex_end(&self, at: usize) -> Option<usize> {
        let b = self.src.as_bytes();
        let mut in_class = false;
        let mut j = at + 1;
        while j < b.len() {
            match b[j] {
                b'\n' => return None,
                b'\\' => j += 1,
                b'[' => in_class = true,
                b']' => in_class = false,
                b'/' if !in_class => return Some(j + 1),
                _ => {}
            }
            j += 1;
        }
        None
    }

    fn code_step(&mut self) {
        let at = self.at;
        let c = self.byte(at);
        if let Some(end) = self.sticky(&SPACE, at).filter(|&e| e > at) {
            return self.advance(end);
        }
        if c == b'"' || c == b'\'' {
            return self.string(at);
        }
        if c == b'`' {
            self.advance(at + 1);
            self.stack.push((Mode::Tmpl, 0));
            return;
        }
        let depth = self.stack.last().map_or(0, |t| t.1);
        if c == b'}' && depth == 0 && self.stack.len() > 1 {
            self.stack.pop();
            if self.stack.last().map(|t| t.0) != Some(Mode::Tmpl) {
                self.push("punct", "}");
            }
            return self.advance(at + 1);
        }
        let end = self.sticky(&ID, at).or_else(|| self.sticky(&NUM, at)).filter(|&e| e > at);
        if let Some(end) = end {
            let word = self.src[at..end].to_string();
            let kind = if c.is_ascii_digit() || c == b'.' {
                "num"
            } else if KEYWORDS.contains(&word.as_str()) {
                "kw"
            } else {
                "id"
            };
            self.push(kind, &word);
            return self.advance(end);
        }
        if c == b'/' && self.regex_allowed() {
            if let Some(end) = self.regex_end(at) {
                let end = self.sticky(&FLAGS, end).unwrap_or(end);
                let text = self.src[at..end].to_string();
                self.push("regex", &text);
                return self.advance(end);
            }
        }
        if c == b'<' && self.jsx && self.jsx_allowed() {
            return self.open_tag();
        }
        let Ok(Some(m)) = PUNCT.find(&self.src[at..]) else {
            let next = self.src[at..].chars().next().map_or(1, char::len_utf8);
            return self.advance(at + next);
        };
        let p = m.as_str().to_string();
        if let Some(top) = self.stack.last_mut() {
            if p == "{" {
                top.1 += 1;
            } else if p == "}" {
                top.1 -= 1;
            }
        }
        self.push("punct", &p);
        self.advance(at + m.end());
    }

    fn tag_step(&mut self) {
        let at = self.at;
        let c = self.byte(at);
        if let Some(end) = self.sticky(&SPACE, at).filter(|&e| e > at) {
            return self.advance(end);
        }
        if c == b'>' || (c == b'/' && self.byte(at + 1) == b'>') {
            self.push("tag", if c == b'>' { ">" } else { "/>" });
            self.stack.pop();
            if c == b'>' {
                self.stack.push((Mode::Children, 0));
            }
            return self.advance(at + if c == b'/' { 2 } else { 1 });
        }
        if c == b'{' {
            self.push("punct", "{");
            self.stack.push((Mode::Code, 0));
            return self.advance(at + 1);
        }
        if c == b'"' || c == b'\'' {
            return self.string(at);
        }
        let end = self.sticky(&ATTR, at).filter(|&e| e > at);
        if let Some(e) = end {
            let text = self.src[at..e].to_string();
            self.push("attr", &text);
        } else if c == b'=' {
            self.push("punct", "=");
        }
        let next = self.src[at..].chars().next().map_or(1, char::len_utf8);
        self.advance(end.unwrap_or(0).max(at + next));
    }

    fn children_step(&mut self) {
        let at = self.at;
        if self.byte(at) == b'{' {
            self.push("punct", "{");
            self.stack.push((Mode::Code, 0));
            return self.advance(at + 1);
        }
        if self.byte(at) == b'<' && self.byte(at + 1) == b'/' {
            let end = self.src[at..].find('>').map_or(self.src.len(), |g| at + g + 1);
            let name = self.src[floor(self.src, at + 2)..floor(self.src, end.saturating_sub(1).max(at + 2))].trim().to_string();
            self.push("tag", &format!("</{name}"));
            self.stack.pop();
            return self.advance(end);
        }
        if self.byte(at) == b'<' {
            return self.open_tag();
        }
        let end = ["<", "{"].iter().filter_map(|s| self.src[at..].find(s).map(|i| at + i)).min().unwrap_or(self.src.len());
        let text = self.src[at..end].trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_string();
        if !text.is_empty() {
            self.push("text", &text);
        }
        self.advance(end);
    }

    fn tmpl_step(&mut self) {
        let at = self.at;
        let b = self.src.as_bytes();
        let mut j = at;
        while j < b.len() && b[j] != b'`' && !(b[j] == b'$' && b.get(j + 1) == Some(&b'{')) {
            j += if b[j] == b'\\' { 2 } else { 1 };
        }
        if j > at {
            let text = self.src[at..floor(self.src, j)].to_string();
            self.push("str", &text);
        }
        if j >= b.len() || b[j] == b'`' {
            self.stack.pop();
            return self.advance((j + 1).min(b.len()));
        }
        self.stack.push((Mode::Code, 0));
        self.advance(j + 2);
    }
}

pub fn tokenize(src: &str, jsx: bool) -> Tokens {
    let mut lx = Lexer { src, at: 0, line: 1, tokens: Tokens::default(), stack: vec![(Mode::Code, 0)], jsx };
    while lx.at < src.len() {
        if lx.stack.is_empty() {
            lx.stack.push((Mode::Code, 0));
        }
        match lx.stack.last().map(|t| t.0).unwrap_or(Mode::Code) {
            Mode::Code => lx.code_step(),
            Mode::Tag => lx.tag_step(),
            Mode::Children => lx.children_step(),
            Mode::Tmpl => lx.tmpl_step(),
        }
    }
    lx.tokens
}

/// Bracket depth before each token, the innermost open bracket around it, and each opener's closer.
fn nesting(tk: &Tokens) -> (Vec<i32>, Vec<i32>, Vec<i32>) {
    let n = tk.text.len();
    let (mut depth, mut parent, mut close) = (vec![0; n], vec![-1; n], vec![-1; n]);
    let mut open: Vec<usize> = Vec::new();
    for i in 0..n {
        depth[i] = open.len() as i32;
        parent[i] = open.last().map_or(-1, |&o| o as i32);
        if tk.kind[i] != "punct" {
            continue;
        }
        match tk.text[i].as_str() {
            "(" | "[" | "{" => open.push(i),
            ")" | "]" | "}" => {
                if let Some(o) = open.pop() {
                    close[o] = i as i32;
                }
            }
            _ => {}
        }
    }
    for i in open {
        close[i] = n as i32 - 1;
    }
    (depth, parent, close)
}

#[derive(Clone, Debug)]
pub struct Unit {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub end_line: u32,
    pub norm: Vec<String>,
    pub raw: Vec<String>,
    pub raw_kind: Vec<String>,
    pub members: Vec<String>,
}

fn t(tk: &Tokens, i: i64) -> &str {
    if i < 0 {
        ""
    } else {
        tk.text.get(i as usize).map_or("", String::as_str)
    }
}

fn k(tk: &Tokens, i: i64) -> &str {
    if i < 0 {
        ""
    } else {
        tk.kind.get(i as usize).copied().unwrap_or("")
    }
}

fn statement_end(tk: &Tokens, j: usize, close: &[i32]) -> usize {
    let mut kk = j;
    while kk < tk.text.len() {
        if kk > j && tk.line[kk] > tk.line[kk - 1] && !CONTINUES.contains(&tk.text[kk].as_str()) {
            let p = tk.text[kk - 1].as_str();
            if ENDS_EXPR.contains(&p) || matches!(tk.kind[kk - 1], "id" | "str" | "num" | "regex" | "text") {
                return kk - 1;
            }
        }
        if tk.text[kk] == ";" && tk.kind[kk] == "punct" {
            return kk;
        }
        kk = if close[kk] > kk as i32 { close[kk] as usize + 1 } else { kk + 1 };
    }
    tk.text.len() - 1
}

/// Index of a function body's `{` after the parameters, or None for an overload signature.
fn body_brace(tk: &Tokens, mut kk: usize, close: &[i32]) -> Option<usize> {
    while kk < tk.text.len() {
        let tt = tk.text[kk].as_str();
        if tt == ";" {
            return None;
        }
        if tt == "{" && !TYPE_BRACE_AFTER.contains(&t(tk, kk as i64 - 1)) {
            return Some(kk);
        }
        kk = if close[kk] > kk as i32 { close[kk] as usize + 1 } else { kk + 1 };
    }
    None
}

/// Whether a `const` initializer is a function: an arrow, `function`, or a wrapper call like `memo(…)` around one.
fn function_init(tk: &Tokens, mut kk: usize, close: &[i32]) -> bool {
    if t(tk, kk as i64) == "async" {
        kk += 1;
    }
    if t(tk, kk as i64) == "function" {
        return true;
    }
    if k(tk, kk as i64) == "id" && t(tk, kk as i64 + 1) == "=>" {
        return true;
    }
    if t(tk, kk as i64) == "<" {
        while kk < tk.text.len() && tk.text[kk] != "(" {
            kk += 1;
        }
    }
    // `(…) :` at the start of an initializer can only be an arrow's return type.
    if t(tk, kk as i64) == "(" {
        let after = close.get(kk).copied().unwrap_or(-1) as i64 + 1;
        return t(tk, after) == "=>" || t(tk, after) == ":";
    }
    while k(tk, kk as i64) == "id" && (t(tk, kk as i64 + 1) == "." || t(tk, kk as i64 + 1) == "(") {
        if t(tk, kk as i64 + 1) == "(" {
            return function_init(tk, kk + 2, close);
        }
        kk += 2;
    }
    false
}

/// The unit declared by the statement at `i`, if any: (name, kind, start, end).
fn unit_at(tk: &Tokens, i: usize, close: &[i32], fallback: &str) -> Option<(String, &'static str, usize, usize)> {
    let mut j = i;
    while MODIFIERS.contains(&t(tk, j as i64)) {
        j += 1;
    }
    let tt = t(tk, j as i64);
    let named = k(tk, j as i64 + 1) == "id";
    if tt == "function" {
        if t(tk, j as i64 + 1) == "*" {
            j += 1;
        }
        let name = if k(tk, j as i64 + 1) == "id" {
            t(tk, j as i64 + 1).to_string()
        } else if t(tk, j as i64 - 1) == "default" {
            fallback.to_string()
        } else {
            String::new()
        };
        let paren = tk.text.iter().skip(j).position(|x| x == "(").map(|p| p + j);
        let body = match paren {
            Some(p) if !name.is_empty() && p > 0 => body_brace(tk, close[p] as usize + 1, close),
            _ => None,
        };
        return body.map(|b| (name, "function", i, close[b] as usize));
    }
    if (tt == "class" || tt == "interface") && named {
        let body = body_brace(tk, j + 2, close)?;
        return Some((t(tk, j as i64 + 1).to_string(), if tt == "class" { "class" } else { "type" }, i, close[body] as usize));
    }
    if tt == "type" && named && (t(tk, j as i64 + 2) == "=" || t(tk, j as i64 + 2) == "<") {
        return Some((t(tk, j as i64 + 1).to_string(), "type", i, statement_end(tk, j, close)));
    }
    if (tt == "const" || tt == "let" || tt == "var") && named {
        let mut kk = j + 2;
        while kk < tk.text.len() && tk.text[kk] != "=" && tk.text[kk] != ";" {
            kk = if close[kk] > kk as i32 { close[kk] as usize + 1 } else { kk + 1 };
        }
        if t(tk, kk as i64) != "=" || !function_init(tk, kk + 1, close) {
            return None;
        }
        return Some((t(tk, j as i64 + 1).to_string(), "function", i, statement_end(tk, kk + 1, close)));
    }
    None
}

/// Members of a type: each `name: shape` entry of its top-level braces, as written.
fn members_of(tk: &Tokens, start: usize, end: usize, depth: &[i32]) -> Vec<String> {
    let mut members = Vec::new();
    let mut current = String::new();
    let mut braces = false;
    #[allow(clippy::needless_range_loop)] // kk indexes the parallel token arrays tk.text, tk.kind and depth
    for kk in start..=end {
        let tt = tk.text[kk].as_str();
        if depth[kk] == 0 {
            braces = tt == "{" || (braces && tt != "(" && tt != "[");
        }
        let top = depth[kk] == 1 && braces;
        let fresh = top
            && kk > 0
            && tk.line[kk] > tk.line[kk - 1]
            && matches!(tk.kind[kk], "id" | "kw" | "str")
            && matches!(t(tk, kk as i64 + 1), ":" | "?" | "(" | "?:")
            && !TYPE_BRACE_AFTER.contains(&t(tk, kk as i64 - 1));
        if (fresh || (top && (tt == ";" || tt == ",")) || depth[kk] == 0 || (top && tt == "}")) && !current.is_empty() {
            members.push(std::mem::take(&mut current));
        }
        if braces && depth[kk] >= 1 && !(top && (tt == ";" || tt == "," || tt == "}")) {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(tt);
        }
    }
    members
}

/// The normalised form of token `kk`: local names become `I`, literals `S`, `N`, `R` and JSX text `T`.
fn normal(tk: &Tokens, kk: usize, kept: &HashSet<String>, parent: &[i32]) -> String {
    let kind = tk.kind[kk];
    let tt = tk.text[kk].as_str();
    if kind == "id" {
        let p = t(tk, kk as i64 - 1);
        if p == "." || p == "?." {
            return tt.to_string();
        }
        if t(tk, kk as i64 + 1) == ":" && (p == "{" || p == ",") && t(tk, parent[kk] as i64) == "{" {
            return tt.to_string();
        }
        return if kept.contains(tt) || BROWSER.contains(&tt) || JS_GLOBALS.contains(&tt) { tt.to_string() } else { "I".to_string() };
    }
    match kind {
        "str" => "S".into(),
        "num" => "N".into(),
        "regex" => "R".into(),
        "text" => "T".into(),
        _ => tt.to_string(),
    }
}

pub fn units(src: &str, path: &str) -> Vec<Unit> {
    let tk = tokenize(src, JSX_FILE.is_match(path));
    if tk.text.is_empty() {
        return vec![];
    }
    let (depth, parent, close) = nesting(&tk);
    // Names bound by top-level imports: what a copy calls by the same name.
    let mut kept: HashSet<String> = HashSet::new();
    let mut i = 0;
    while i < tk.text.len() {
        if depth[i] == 0 && tk.text[i] == "import" && t(&tk, i as i64 + 1) != "(" {
            i += 1;
            while i < tk.text.len() && tk.kind[i] != "str" {
                if tk.kind[i] == "id" {
                    kept.insert(tk.text[i].clone());
                }
                i += 1;
            }
        }
        i += 1;
    }
    // Names declared at the top of the file: the module's own helpers and state.
    let own: HashSet<&str> = (0..tk.text.len().saturating_sub(1))
        .filter(|&i| {
            depth[i] == 0
                && matches!(tk.text[i].as_str(), "const" | "let" | "var" | "function" | "class" | "enum")
                && tk.kind[i + 1] == "id"
        })
        .map(|i| tk.text[i + 1].as_str())
        .collect();
    let fallback = path.rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("");
    let mut found = Vec::new();
    let mut i = 0;
    while i < tk.text.len() {
        let starts = i == 0 || tk.text[i - 1] == ";" || tk.text[i - 1] == "}" || tk.line[i] > tk.line[i - 1];
        if depth[i] != 0 || !starts {
            i += 1;
            continue;
        }
        let Some((name, ukind, start, end)) = unit_at(&tk, i, &close, fallback) else {
            i += 1;
            continue;
        };
        // A function compares from its parameters on, without its own `=>`; braces and semicolons are style.
        let from = if ukind == "function" {
            tk.text.iter().skip(start).position(|x| x == "(").map_or(start, |p| (p + start).max(start))
        } else {
            start
        };
        let at: Vec<usize> = (from..=end)
            .filter(|&kk| {
                let tt = tk.text[kk].as_str();
                let style = tk.kind[kk] == "punct" && (tt == "{" || tt == "}" || tt == ";");
                ukind == "type" || !(style || (depth[kk] == 0 && tt == "=>"))
            })
            .collect();
        let norm: Vec<String> = at.iter().map(|&kk| normal(&tk, kk, &kept, &parent)).collect();
        let jsx = at.iter().any(|&kk| tk.kind[kk] == "tag");
        let starts_upper = name.chars().next().is_some_and(|c| c.is_ascii_uppercase());
        let hook = name.starts_with("use") && name[3..].chars().next().is_some_and(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
        let kind = if ukind == "function" && hook {
            "hook"
        } else if ukind == "function" && jsx && starts_upper {
            "component"
        } else {
            ukind
        };
        let raw_kind = at
            .iter()
            .enumerate()
            .map(|(n, &kk)| {
                if tk.kind[kk] != "id" {
                    tk.kind[kk].to_string()
                } else if kept.contains(&norm[n]) {
                    "dep".into()
                } else if norm[n] == "I" && own.contains(tk.text[kk].as_str()) {
                    "mod".into()
                } else {
                    "id".into()
                }
            })
            .collect();
        found.push(Unit {
            name,
            kind: kind.to_string(),
            line: tk.line[start],
            end_line: tk.line[end],
            norm,
            raw: at.iter().map(|&kk| tk.text[kk].clone()).collect(),
            raw_kind,
            members: if kind == "type" { members_of(&tk, start, end, &depth) } else { vec![] },
        });
        i = end + 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_units_and_normalises_locals() {
        let src = "import { db } from './db';\nexport function totalOf(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\nexport const Card = ({ title }) => <div className=\"card\">{title}</div>;\ntype User = {\n  id: string;\n  name: string;\n};\n";
        let u = units(src, "a.tsx");
        assert_eq!(
            u.iter().map(|u| (u.name.as_str(), u.kind.as_str(), u.line, u.end_line)).collect::<Vec<_>>(),
            vec![("totalOf", "function", 2, 4), ("Card", "component", 5, 5), ("User", "type", 6, 9)]
        );
        assert_eq!(u[0].norm.join(" "), "( I ) return I . reduce ( ( I , I ) => I + I . price , N )");
        assert_eq!(u[2].members, vec!["id : string", "name : string"]);
    }
}
