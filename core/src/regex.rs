//! The regex check: patterns whose backtracking explodes on a crafted input (ReDoS), and one validation (email,
//! phone, URL…) written as different patterns in different files, so the frontend and backend disagree on what is
//! valid. JavaScript patterns are parsed here, lookarounds, named groups and backreferences included.

use rayon::prelude::*;
use std::collections::HashMap;

use crate::text;
use crate::{js, Answer, Finding, Request};

/// The characters a piece of pattern can match: ASCII one by one, everything else as one bucket.
#[derive(Clone, Copy, PartialEq)]
struct Set {
    ascii: [bool; 128],
    other: bool,
}

impl Set {
    const NONE: Set = Set { ascii: [false; 128], other: false };
    const ALL: Set = Set { ascii: [true; 128], other: true };

    fn of(f: impl Fn(u8) -> bool) -> Set {
        let mut s = Set::NONE;
        for c in 0..128u8 {
            s.ascii[c as usize] = f(c);
        }
        s
    }

    fn char(c: char) -> Set {
        if (c as u32) < 128 {
            Set::of(|b| b as char == c)
        } else {
            Set { ascii: [false; 128], other: true }
        }
    }

    fn union(self, o: Set) -> Set {
        let mut s = self;
        for i in 0..128 {
            s.ascii[i] |= o.ascii[i];
        }
        s.other |= o.other;
        s
    }

    fn not(self) -> Set {
        let mut s = self;
        for i in 0..128 {
            s.ascii[i] = !s.ascii[i];
        }
        s.other = !s.other;
        s
    }

    fn overlaps(&self, o: &Set) -> bool {
        (self.other && o.other) || (0..128).any(|i| self.ascii[i] && o.ascii[i])
    }

    fn is_empty(&self) -> bool {
        !self.other && !self.ascii.iter().any(|&b| b)
    }
}

#[derive(Clone, PartialEq)]
enum Node {
    Empty,
    Chars(Set),
    Seq(Vec<Node>),
    Alt(Vec<Node>),
    Repeat { node: Box<Node>, min: u32, max: Option<u32> },
    /// Lookarounds, anchors and backreferences: they consume nothing the analysis can follow.
    ZeroWidth,
}

struct Parser<'p> {
    chars: Vec<char>,
    at: usize,
    _src: &'p str,
}

fn digit() -> Set {
    Set::of(|b| b.is_ascii_digit())
}
fn word() -> Set {
    Set::of(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn space() -> Set {
    Set::of(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
}

impl<'p> Parser<'p> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn alternation(&mut self) -> Node {
        let mut branches = vec![self.sequence()];
        while self.eat('|') {
            branches.push(self.sequence());
        }
        if branches.len() == 1 {
            branches.pop().unwrap()
        } else {
            Node::Alt(branches)
        }
    }

    fn sequence(&mut self) -> Node {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.atom();
            items.push(self.quantified(atom));
        }
        match items.len() {
            0 => Node::Empty,
            1 => items.pop().unwrap(),
            _ => Node::Seq(items),
        }
    }

    fn number(&mut self) -> Option<u32> {
        let start = self.at;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.at += 1;
        }
        self.chars[start..self.at].iter().collect::<String>().parse().ok()
    }

    fn quantified(&mut self, atom: Node) -> Node {
        let (min, max) = match self.peek() {
            Some('*') => (0, None),
            Some('+') => (1, None),
            Some('?') => (0, Some(1)),
            Some('{') => {
                let save = self.at;
                self.at += 1;
                let Some(min) = self.number() else {
                    self.at = save;
                    return atom;
                };
                let max = if self.eat(',') { self.number() } else { Some(min) };
                if !self.eat('}') {
                    self.at = save;
                    return atom;
                }
                self.at -= 1;
                (min, max)
            }
            _ => return atom,
        };
        self.at += 1;
        self.eat('?');
        Node::Repeat { node: Box::new(atom), min, max }
    }

    fn escape(&mut self, in_class: bool) -> Node {
        let Some(c) = self.peek() else { return Node::Chars(Set::char('\\')) };
        self.at += 1;
        let set = match c {
            'd' => digit(),
            'D' => digit().not(),
            'w' => word(),
            'W' => word().not(),
            's' => space(),
            'S' => space().not(),
            'b' | 'B' if !in_class => return Node::ZeroWidth,
            'b' => Set::char('\u{8}'),
            'n' => Set::char('\n'),
            't' => Set::char('\t'),
            'r' => Set::char('\r'),
            'f' => Set::char('\u{c}'),
            'v' => Set::char('\u{b}'),
            '0' => Set::char('\0'),
            '1'..='9' if !in_class => {
                while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    self.at += 1;
                }
                return Node::ZeroWidth;
            }
            'k' if !in_class && self.peek() == Some('<') => {
                while self.peek().is_some_and(|c| c != '>') {
                    self.at += 1;
                }
                self.at += 1;
                return Node::ZeroWidth;
            }
            'x' => {
                let hex: String = self.chars[self.at..(self.at + 2).min(self.chars.len())].iter().collect();
                self.at = (self.at + 2).min(self.chars.len());
                u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32).map_or(Set::ALL, Set::char)
            }
            'u' => {
                let code = if self.eat('{') {
                    let start = self.at;
                    while self.peek().is_some_and(|c| c != '}') {
                        self.at += 1;
                    }
                    let hex: String = self.chars[start..self.at].iter().collect();
                    self.at += 1;
                    hex
                } else {
                    let hex: String = self.chars[self.at..(self.at + 4).min(self.chars.len())].iter().collect();
                    self.at = (self.at + 4).min(self.chars.len());
                    hex
                };
                u32::from_str_radix(&code, 16).ok().and_then(char::from_u32).map_or(Set::ALL, Set::char)
            }
            'p' | 'P' => {
                // A Unicode property class: treated as letters and everything outside ASCII.
                if self.eat('{') {
                    while self.peek().is_some_and(|c| c != '}') {
                        self.at += 1;
                    }
                    self.at += 1;
                }
                Set::of(|b| b.is_ascii_alphabetic()).union(Set { ascii: [false; 128], other: true })
            }
            'c' => {
                self.at += 1;
                Set::ALL
            }
            other => Set::char(other),
        };
        Node::Chars(set)
    }

    fn class(&mut self) -> Node {
        let negated = self.eat('^');
        let mut set = Set::NONE;
        let mut first = true;
        while let Some(c) = self.peek() {
            if c == ']' && !first {
                break;
            }
            first = false;
            self.at += 1;
            let lo = if c == '\\' {
                match self.escape(true) {
                    Node::Chars(s) => s,
                    _ => Set::NONE,
                }
            } else {
                Set::char(c)
            };
            // A range a-z: both ends single ASCII characters.
            if self.peek() == Some('-') && self.chars.get(self.at + 1).is_some_and(|&n| n != ']') {
                let lo_char = c;
                self.at += 1;
                let hi = self.peek().unwrap_or(lo_char);
                self.at += 1;
                let (a, b) = (lo_char as u32, hi as u32);
                if c != '\\' && a < 128 && b < 128 && a <= b {
                    set = set.union(Set::of(|x| (x as u32) >= a && (x as u32) <= b));
                } else {
                    set = set.union(Set::ALL);
                }
                continue;
            }
            set = set.union(lo);
        }
        self.eat(']');
        Node::Chars(if negated { set.not() } else { set })
    }

    fn atom(&mut self) -> Node {
        let Some(c) = self.peek() else { return Node::Empty };
        self.at += 1;
        match c {
            '\\' => self.escape(false),
            '[' => self.class(),
            '.' => Node::Chars(Set::of(|b| b != b'\n' && b != b'\r').union(Set { ascii: [false; 128], other: true })),
            '^' | '$' => Node::ZeroWidth,
            '(' => {
                let look = if self.eat('?') {
                    match self.peek() {
                        Some(':') => {
                            self.at += 1;
                            false
                        }
                        Some('=') | Some('!') => {
                            self.at += 1;
                            true
                        }
                        Some('<') if matches!(self.chars.get(self.at + 1), Some('=') | Some('!')) => {
                            self.at += 2;
                            true
                        }
                        Some('<') => {
                            while self.peek().is_some_and(|c| c != '>') {
                                self.at += 1;
                            }
                            self.at += 1;
                            false
                        }
                        _ => false,
                    }
                } else {
                    false
                };
                let inner = self.alternation();
                self.eat(')');
                if look {
                    Node::ZeroWidth
                } else {
                    inner
                }
            }
            other => Node::Chars(Set::char(other)),
        }
    }
}

fn parse(pattern: &str) -> Node {
    let mut p = Parser { chars: pattern.chars().collect(), at: 0, _src: pattern };
    let mut node = p.alternation();
    // An unbalanced `)` ends the pattern early; read on so the rest is still checked.
    while p.at < p.chars.len() {
        p.at += 1;
        let rest = p.alternation();
        node = Node::Seq(vec![node, rest]);
    }
    node
}

/// Whether a node can match the empty string.
fn nullable(n: &Node) -> bool {
    match n {
        Node::Empty | Node::ZeroWidth => true,
        Node::Chars(_) => false,
        Node::Seq(items) => items.iter().all(nullable),
        Node::Alt(b) => b.iter().any(nullable),
        Node::Repeat { node, min, .. } => *min == 0 || nullable(node),
    }
}

/// Every character a node can consume, anywhere in it.
fn chars(n: &Node) -> Set {
    match n {
        Node::Empty | Node::ZeroWidth => Set::NONE,
        Node::Chars(s) => *s,
        Node::Seq(items) | Node::Alt(items) => items.iter().fold(Set::NONE, |a, i| a.union(chars(i))),
        Node::Repeat { node, .. } => chars(node),
    }
}

/// The characters a node can start with.
fn first(n: &Node) -> Set {
    match n {
        Node::Empty | Node::ZeroWidth => Set::NONE,
        Node::Chars(s) => *s,
        Node::Alt(b) => b.iter().fold(Set::NONE, |a, i| a.union(first(i))),
        Node::Repeat { node, .. } => first(node),
        Node::Seq(items) => {
            let mut out = Set::NONE;
            for i in items {
                out = out.union(first(i));
                if !nullable(i) {
                    break;
                }
            }
            out
        }
    }
}

fn unbounded(n: &Node) -> bool {
    matches!(n, Node::Repeat { max: None, .. } | Node::Repeat { max: Some(16..), .. })
}

/// Why a pattern backtracks exponentially, if it does. Linear-run patterns (`\s+$` unanchored) are quadratic in
/// V8 too, but need tens of thousands of characters of untrusted input to matter, so they are not reported.
fn hazard(n: &Node) -> Option<(&'static str, String)> {
    exponential(n)
}

fn exponential(n: &Node) -> Option<(&'static str, String)> {
    let mut found: Option<(&'static str, String)> = None;
    walk(n, &mut |node| {
        if found.as_ref().is_some_and(|f| f.0 == "exponential") {
            return;
        }
        if let Node::Repeat { node: body, .. } = node {
            if !unbounded(node) {
                return;
            }
            // (x+)+ and (\w+\s?)+: an unbounded repeat inside an unbounded repeat, where what else the outer body
            // needs is optional or can be matched by the inner repeat too, so a run splits between them many ways.
            let items: Vec<&Node> = match body.as_ref() {
                Node::Seq(items) => items.iter().collect(),
                other => vec![other],
            };
            for (i, item) in items.iter().enumerate() {
                let inner = innermost_unbounded(item);
                if let Some(inner_set) = inner {
                    let rest_ambiguous = items.iter().enumerate().filter(|(j, _)| *j != i).all(|(_, other)| nullable(other) || first(other).overlaps(&inner_set));
                    if rest_ambiguous && !inner_set.is_empty() {
                        found = Some(("exponential", "a repeated group whose inside repeats too, matching the same characters".into()));
                        return;
                    }
                }
            }
            // (a|aa)+ and (\d|\w)+: alternatives that can start the same way, repeated.
            if let Node::Alt(branches) = body.as_ref() {
                for (i, a) in branches.iter().enumerate() {
                    for b in &branches[i + 1..] {
                        if first(a).overlaps(&first(b)) && !first(a).is_empty() {
                            found = Some(("exponential", "a repeated choice whose alternatives can match the same characters".into()));
                            return;
                        }
                    }
                }
            }
        }
    });
    found
}

/// The characters of an unbounded repeat inside `n`, if it has one.
fn innermost_unbounded(n: &Node) -> Option<Set> {
    let mut out = None;
    walk(n, &mut |node| {
        if out.is_none() && unbounded(node) {
            out = Some(chars(node));
        }
    });
    out
}

fn walk(n: &Node, f: &mut impl FnMut(&Node)) {
    f(n);
    match n {
        Node::Seq(items) | Node::Alt(items) => items.iter().for_each(|i| walk(i, f)),
        Node::Repeat { node, .. } => walk(node, f),
        _ => {}
    }
}

/// Validations that mean one thing everywhere: two patterns for one of these should agree. A slug, handle or code
/// differs by entity on purpose, so those are left out.
const CONCEPTS: [&str; 5] = ["email", "phone", "uuid", "url", "ip"];
/// Words a pattern's name may add around the concept without narrowing it: EMAIL_RE, emailSchema, isValidPhone.
const GENERIC: [&str; 15] = ["re", "regex", "regexp", "rx", "pattern", "schema", "valid", "validation", "validator", "is", "shape", "format", "string", "matcher", "address"];

/// The concept a pattern's name is purely about: `EMAIL_PATTERN` is email; `BASE64URL` or `creatorEmail` are not.
fn concept(name: &str) -> Option<&'static str> {
    let words: Vec<String> = text::words(name).into_iter().filter(|w| !GENERIC.contains(&w.as_str())).collect();
    match words.as_slice() {
        [one] => CONCEPTS.iter().find(|c| one == *c || text::stem(one) == **c).copied(),
        _ => None,
    }
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let sites: Vec<(String, js::RegexSite)> = request
        .files
        .par_iter()
        .filter_map(|file| {
            let src = text::read(&request.root, file)?;
            Some(js::facts(file, &src)?.regexes.into_iter().map(|r| (file.clone(), r)).collect::<Vec<_>>())
        })
        .flatten()
        .collect();
    let mut findings = Vec::new();
    for (file, site) in sites.iter().filter(|(f, s)| request.changed(f, s.line)) {
        if let Some((_, why)) = hazard(&parse(&site.pattern)) {
            let shown: String = site.pattern.chars().take(60).collect();
            let cost = "time doubles with each extra character";
            findings.push(Finding {
                file: file.clone(),
                line: site.line,
                target: format!("{file}:redos:{shown}"),
                message: format!("{file}:{} /{shown}/ has {why}, so on a crafted input that almost matches its {cost} and can hang the process: make the inside of the repeat unable to match what follows it (e.g. [^\\s]+ instead of .+), or bound the input length before matching", site.line),
            });
        }
    }
    // One validation, two patterns: group named patterns by what they validate.
    let mut groups: HashMap<&str, Vec<&(String, js::RegexSite)>> = HashMap::new();
    for s in &sites {
        // A validator matches the whole string: a pattern that only finds a prefix or a part is not one.
        let validator = s.1.pattern.starts_with('^') && s.1.pattern.ends_with('$') && !matches!(parse(&s.1.pattern), Node::Alt(_));
        if let Some(c) = s.1.name.as_deref().and_then(concept).filter(|_| validator) {
            groups.entry(c).or_default().push(s);
        }
    }
    let mut concepts: Vec<_> = groups.into_iter().collect();
    concepts.sort_by_key(|(c, _)| *c);
    for (c, list) in concepts {
        let Some(changed) = list.iter().find(|(f, s)| request.changed(f, s.line)) else { continue };
        // Compared by meaning: \d and [0-9] are one pattern.
        let mine = parse(&changed.1.pattern);
        let Some(other) = list.iter().find(|(f, s)| f != &changed.0 && parse(&s.pattern) != mine) else { continue };
        let (file, site) = (&changed.0, &changed.1);
        let name = site.name.as_deref().unwrap_or("?");
        findings.push(Finding {
            file: file.clone(),
            line: site.line,
            target: format!("{file}:pattern-drift:{c}"),
            message: format!("{file}:{} {name} validates {c} as /{}/ but {} at {}:{} uses /{}/, so the two disagree on what is a valid {c}: keep one pattern in a module both import", site.line, site.pattern, other.1.name.as_deref().unwrap_or("?"), other.0, other.1.line, other.1.pattern),
        });
    }
    Ok(Answer { findings, summary: format!("{} regular expressions read", sites.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(p: &str) -> Option<&'static str> {
        hazard(&parse(p)).map(|h| h.0)
    }

    #[test]
    fn finds_catastrophic_backtracking() {
        assert_eq!(kind("^(a+)+$"), Some("exponential"));
        assert_eq!(kind("^(\\w+\\s?)+$"), Some("exponential"));
        assert_eq!(kind("^(a|aa)+$"), Some("exponential"));
        assert_eq!(kind("^([a-zA-Z0-9]+[a-z0-9])*@x$"), Some("exponential"));
        assert_eq!(kind("\\s+$"), None);
        assert!(parse("^\\+[1-9]\\d{7,14}$") == parse("^\\+[1-9][0-9]{7,14}$"));
        assert_eq!(kind("^[a-z0-9]+(?:-[a-z0-9]+)*$"), None);
        assert_eq!(kind("^[\\w-]+(\\.[\\w-]+)+"), None);
        assert_eq!(kind("^(#{1,6})\\s+(.+)$"), None);
        assert_eq!(kind("foo\\s+bar"), None);
        assert_eq!(kind("^(\\w+\\s)+$"), None);
        assert_eq!(kind("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$"), None);
        assert_eq!(kind("^(?<year>\\d{4})-(\\d{2})$"), None);
        assert_eq!(kind("^(a|b)+$"), None);
        assert_eq!(kind("^\\d+(?:\\.\\d+)?$"), None);
        assert_eq!(concept("EMAIL_PATTERN"), Some("email"));
        assert_eq!(concept("phoneRegex"), Some("phone"));
        assert_eq!(concept("isValidEmail"), Some("email"));
        assert_eq!(concept("BASE64URL"), None);
        assert_eq!(concept("creatorHandlePattern"), None);
    }
}
