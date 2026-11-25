//! Reading source files and turning byte offsets into line numbers.

use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;

/// Files over this size are skipped: generated bundles and data, not code someone wrote.
const MAX_BYTES: u64 = 512 * 1024;
const SCHEMA_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// A file's text, or None when it is missing, too large, binary or generated.
pub fn read(root: &str, file: &str) -> Option<String> {
    // A schema is one file however many tables it holds: a large Prisma schema or SQL dump is still written by hand.
    read_up_to(root, file, if file.ends_with(".prisma") || file.ends_with(".sql") { SCHEMA_MAX_BYTES } else { MAX_BYTES })
}

/// A file's text, or None when it is missing, over `limit` bytes, binary or generated.
pub fn read_up_to(root: &str, file: &str, limit: u64) -> Option<String> {
    let path = Path::new(root).join(file);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let mut cut = text.len().min(500);
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let head = &text[..cut];
    if text.contains('\0') || head.contains("@generated") || head.contains("DO NOT EDIT") {
        return None;
    }
    Some(text)
}

/// Edit distance counting a swap of two neighbours as one edit (`nmae` is one from `name`), for "did you mean".
pub fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

/// A fresh temporary folder holding `files` (path, text), for tests; its path.
#[cfg(test)]
pub fn temp_tree(name: &str, files: &[(&str, &str)]) -> String {
    let dir = std::env::temp_dir().join(format!("intersite-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    dir.to_string_lossy().into()
}

/// Byte offset to 1-based line.
pub struct Lines {
    starts: Vec<usize>,
}

impl Lines {
    pub fn new(text: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        Lines { starts }
    }

    pub fn line(&self, offset: usize) -> u32 {
        match self.starts.binary_search(&offset) {
            Ok(i) => i as u32 + 1,
            Err(i) => i as u32,
        }
    }
}

/// The byte ranges of comments and string literals in JavaScript-like code, in order; `true` marks a string.
pub fn code_spans(text: &str) -> Vec<(usize, usize, bool)> {
    // ponytail: regex literals and template ${} expressions are not understood, a tokenizer if that bites
    let b = text.as_bytes();
    let mut spans = vec![];
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                let end = text[i..].find('\n').map_or(b.len(), |p| i + p);
                spans.push((i, end, false));
                i = end;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let end = text[i + 2..].find("*/").map_or(b.len(), |p| i + 2 + p + 2);
                spans.push((i, end, false));
                i = end;
            }
            q @ (b'"' | b'\'' | b'`') => {
                let mut j = i + 1;
                while j < b.len() && b[j] != q && (q == b'`' || b[j] != b'\n') {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                spans.push((i, (j + 1).min(b.len()), true));
                i = j + 1;
            }
            _ => i += 1,
        }
    }
    spans
}

/// The same text with the inside of comments and string literals replaced by spaces, newlines and columns kept.
pub fn strip_code(text: &str) -> String {
    // Each UTF-16 unit becomes a space, as JavaScript blanks them, so columns agree with the JavaScript's offsets.
    let blank = |s: &str| s.chars().map(|c| if c == '\n' { "\n".to_string() } else { " ".repeat(c.len_utf16()) }).collect::<String>();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (s, e, string) in code_spans(text) {
        out.push_str(&text[at..s]);
        if string {
            // The quotes stay; an unclosed string's newline is blanked as a newline.
            let inner_end = if e - 1 > s && text.as_bytes()[e - 1] == text.as_bytes()[s] { e - 1 } else { e };
            out.push_str(&text[s..s + 1]);
            out.push_str(&blank(&text[s + 1..inner_end]));
            out.push_str(&text[inner_end..e]);
        } else {
            out.push_str(&blank(&text[s..e]));
        }
        at = e;
    }
    out.push_str(&text[at..]);
    out
}

/// Lowercase words of an identifier or sentence: `getUserById` is get, user, by, id.
pub fn words(text: &str) -> Vec<String> {
    split_words(text, |c| !c.is_alphanumeric())
}

/// Lowercase words, split at each `sep` character (dropped), before a capital after a lowercase letter or digit, and
/// before the last capital of an acronym followed by a lowercase letter.
fn split_words(text: &str, sep: impl Fn(char) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if sep(c) {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            continue;
        }
        let prev = if i > 0 { chars[i - 1] } else { ' ' };
        let next = chars.get(i + 1).copied().unwrap_or(' ');
        let boundary = c.is_uppercase() && (prev.is_lowercase() || prev.is_ascii_digit() || (prev.is_uppercase() && next.is_lowercase()));
        if boundary && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        word.extend(c.to_lowercase());
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// The casing of a name, for the naming check and the API contract lint.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Style {
    Word,
    Kebab,
    Snake,
    Camel,
    Pascal,
}

pub fn style_name(style: Style) -> &'static str {
    match style {
        Style::Kebab => "kebab-case",
        Style::Snake => "snake_case",
        Style::Camel => "camelCase",
        Style::Pascal => "PascalCase",
        Style::Word => "undefined",
    }
}

/// The casing of a bare name: one lowercase word ("word") fits kebab, snake and camel alike.
pub fn style_of(stem: &str) -> Option<Style> {
    static STYLES: LazyLock<[(Regex, Style); 5]> = LazyLock::new(|| {
        [
            (Regex::new(r"^[a-z][a-z0-9]*$").unwrap(), Style::Word),
            (Regex::new(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$").unwrap(), Style::Kebab),
            (Regex::new(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$").unwrap(), Style::Snake),
            (Regex::new(r"^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$").unwrap(), Style::Camel),
            (Regex::new(r"^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$").unwrap(), Style::Pascal),
        ]
    });
    STYLES.iter().find(|(pattern, _)| pattern.is_match(stem)).map(|(_, style)| *style)
}

/// A name in another casing: `user_card` as Pascal is `UserCard`. Its words are split at - and _ only; any other
/// character stays in its word. No words in camel case is "undefined", as the JavaScript this was ported from says.
pub fn restyle(stem: &str, style: Style) -> String {
    let words = split_words(stem, |c| c == '-' || c == '_');
    let cap = |word: &String| {
        let mut chars = word.chars();
        chars.next().map_or(String::new(), |first| first.to_uppercase().collect::<String>() + chars.as_str())
    };
    match style {
        Style::Kebab => words.join("-"),
        Style::Snake => words.join("_"),
        Style::Pascal => words.iter().map(cap).collect(),
        Style::Camel | Style::Word => match words.split_first() {
            Some((first, rest)) => first.clone() + &rest.iter().map(cap).collect::<String>(),
            None => "undefined".into(),
        },
    }
}

/// A crude stem, so `users` and `user`, `loading` and `load` match.
pub fn stem(word: &str) -> String {
    for suffix in ["ies", "ing", "ed", "es", "s"] {
        if word.len() > suffix.len() + 2
            && word.ends_with(suffix)
            && !word.ends_with("ss")
            && !word.ends_with("is")
            && !word.ends_with("us")
        {
            let base = &word[..word.len() - suffix.len()];
            return if suffix == "ies" { format!("{base}y") } else { base.to_string() };
        }
    }
    word.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_large_schema_is_read_and_a_large_source_file_is_not() {
        let big = "x".repeat(600 * 1024);
        let root = temp_tree("text-limits", &[("schema.prisma", big.as_str()), ("bundle.ts", big.as_str())]);
        assert!(read(&root, "schema.prisma").is_some());
        assert!(read(&root, "bundle.ts").is_none());
    }

    #[test]
    fn splits_identifiers_and_lines() {
        assert_eq!(words("getUserById"), vec!["get", "user", "by", "id"]);
        assert_eq!(words("MAX_PHOTO_BYTES"), vec!["max", "photo", "bytes"]);
        assert_eq!(words("HTMLParser"), vec!["html", "parser"]);
        let lines = Lines::new("a\nbc\n\nd");
        assert_eq!([lines.line(0), lines.line(2), lines.line(5), lines.line(6)], [1, 2, 3, 4]);
        assert_eq!(stem("users"), "user");
        assert_eq!(stem("status"), "status");
    }

    #[test]
    fn finds_comments_and_strings_once() {
        let src = "a('x // y') // z\nb /* c */ `d\ne` 'f";
        let spans: Vec<(&str, bool)> = code_spans(src).iter().map(|&(s, e, string)| (&src[s..e], string)).collect();
        assert_eq!(spans, vec![("'x // y'", true), ("// z", false), ("/* c */", false), ("`d\ne`", true), ("'f", true)]);
        assert_eq!(strip_code(src), "a('      ')     \nb         ` \n ` ' ");
    }
}
