//! Reading source files and turning byte offsets into line numbers.

use std::path::Path;

/// Files over this size are skipped: generated bundles and data, not code someone wrote.
const MAX_BYTES: u64 = 512 * 1024;
const SCHEMA_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// A file's text, or None when it is missing, too large, binary or generated.
pub fn read(root: &str, file: &str) -> Option<String> {
    let path = Path::new(root).join(file);
    let meta = std::fs::metadata(&path).ok()?;
    // A schema is one file however many tables it holds: a large Prisma schema or SQL dump is still written by hand.
    let limit = if file.ends_with(".prisma") || file.ends_with(".sql") { SCHEMA_MAX_BYTES } else { MAX_BYTES };
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

/// Lowercase words of an identifier or sentence: `getUserById` is get, user, by, id.
pub fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
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

/// A crude stem, so `users` and `user`, `loading` and `load` match.
pub fn stem(word: &str) -> String {
    for suffix in ["ies", "ing", "ed", "es", "s"] {
        if word.len() > suffix.len() + 2 && word.ends_with(suffix) && !word.ends_with("ss") && !word.ends_with("is") && !word.ends_with("us") {
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
}
