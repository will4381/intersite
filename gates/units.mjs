// @ts-check
// JavaScript and TypeScript units for the similar gate: a small tokenizer that knows strings, templates, regular
// expressions and JSX, and the top-level functions, components, hooks, classes and types it finds. Another language
// adds a module with the same `units(text, path)` shape.

/**
 * @typedef {{ text: string[], kind: string[], line: number[] }} Tokens kind: id kw str num regex punct tag attr text
 * @typedef {{ name: string, kind: string, line: number, endLine: number, norm: string[], raw: string[], rawKind: string[],
 *   members: string[] }} Unit norm: placeholders for local names and literals; raw: the same tokens as written
 */

const ID = /[A-Za-z_$ -￿][\w$ -￿]*/y;
const NUM = /(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?)n?/y;
const PUNCT = /=>|\.\.\.|\?\?=?|\?\.(?!\d)|[=!]==?|\*\*=?|&&=?|\|\|=?|<<=?|>>>?=?|\+\+|--|[-+*/%&|^<>]=?|[{}()[\];,.:?~@#!=]/y;
const SPACE = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))+/y;
const TAG_NAME = /[\w$.:-]*/y;
const ATTR = /[\w$:-]+/y;
const JSX_FILE = /\.(?:jsx|tsx|js|mjs|cjs)$/;
const KEYWORDS = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for function if " +
    "import in instanceof new null return super switch this throw true try typeof var void while with yield let static async " +
    "await of as interface implements private protected public readonly abstract declare keyof infer is namespace satisfies " +
    "undefined string number boolean any unknown never object symbol bigint type").split(" "),
);
const REGEX_AFTER_KW = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const JSX_AFTER = new Set(["(", ",", "=", ":", "?", "[", "{", "&&", "||", "??", "!", "=>", ";", "return", "default", "yield", "case"]);
// Browser globals Node lacks; everything on globalThis (Math, JSON, fetch, Promise…) is kept by name too.
const BROWSER = new Set(["window", "document", "localStorage", "sessionStorage", "navigator", "location", "history"]);
const CONTINUES = new Set([".", "?.", ")", "]", "}", "=>", "?", ":", "|", "&", "||", "&&", "??", "+", "-", "*", "/", "=", ",", "as", "satisfies", "extends", "implements", ">", "/>"]);
const ENDS_EXPR = new Set([")", "]", "}", ">", "/>"]);
const MODIFIERS = new Set(["export", "default", "declare", "async", "abstract"]);
const TYPE_BRACE_AFTER = new Set([":", "|", "&", "<", ",", "=>"]);

/**
 * @typedef {{ mode: "code" | "tag" | "children" | "tmpl", depth: number }} Mode
 * @typedef {{ src: string, at: number, line: number, tokens: Tokens, stack: Mode[], jsx: boolean }} Lexer
 */

/** @param {Lexer} lx @param {string} kind @param {string} text */
function push(lx, kind, text) {
  lx.tokens.text.push(text);
  lx.tokens.kind.push(kind);
  lx.tokens.line.push(lx.line);
}

/** @param {Lexer} lx @param {number} end */
function advance(lx, end) {
  for (let i = lx.src.indexOf("\n", lx.at); i >= 0 && i < end; i = lx.src.indexOf("\n", i + 1)) lx.line++;
  lx.at = end;
}

/** @param {RegExp} re @param {Lexer} lx @param {number} [from] */
function sticky(re, lx, from = lx.at) {
  re.lastIndex = from;
  return re.test(lx.src) ? re.lastIndex : -1;
}

/** @param {string} src @param {number} at */
function quoteEnd(src, at) {
  let j = at + 1;
  while (j < src.length && src[j] !== src[at] && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
  return Math.min(j + 1, src.length);
}

/** End of a regular expression literal starting at `at`, or -1 when the line ends first. @param {string} src @param {number} at */
function regexEnd(src, at) {
  let inClass = false;
  for (let j = at + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
  }
  return -1;
}

/** @param {Lexer} lx */
function previous(lx) {
  const n = lx.tokens.text.length;
  return n ? { text: lx.tokens.text[n - 1], kind: lx.tokens.kind[n - 1] } : undefined;
}

/** @param {Lexer} lx */
function regexAllowed(lx) {
  const p = previous(lx);
  if (!p) return true;
  if (p.kind === "kw") return REGEX_AFTER_KW.has(p.text);
  return p.kind === "punct" && !ENDS_EXPR.has(p.text);
}

/** @param {Lexer} lx */
function jsxAllowed(lx) {
  const p = previous(lx);
  if (p && !JSX_AFTER.has(p.text)) return false;
  const rest = lx.src.slice(lx.at + 1, lx.at + 40);
  // `<T,>(x) =>` and `<T extends U>` are generics, not elements.
  return /^[A-Za-z>]/.test(rest) && !/^[A-Za-z_$][\w$]*\s*(?:,|extends\b)/.test(rest);
}

/** @param {Lexer} lx */
function openTag(lx) {
  if (lx.src[lx.at + 1] === ">") {
    push(lx, "tag", "<>");
    advance(lx, lx.at + 2);
    lx.stack.push({ mode: "children", depth: 0 });
    return;
  }
  const end = sticky(TAG_NAME, lx, lx.at + 1);
  push(lx, "tag", `<${lx.src.slice(lx.at + 1, end)}`);
  advance(lx, end);
  lx.stack.push({ mode: "tag", depth: 0 });
}

/** @param {Lexer} lx @param {Mode} top */
function codeStep(lx, top) {
  const { src, at } = lx;
  const c = src[at];
  let end = sticky(SPACE, lx);
  if (end > at) return advance(lx, end);
  if (c === '"' || c === "'") {
    end = quoteEnd(src, at);
    push(lx, "str", src.slice(at, end));
    return advance(lx, end);
  }
  if (c === "`") {
    advance(lx, at + 1);
    lx.stack.push({ mode: "tmpl", depth: 0 });
    return;
  }
  if (c === "}" && top.depth === 0 && lx.stack.length > 1) {
    lx.stack.pop();
    if (lx.stack[lx.stack.length - 1].mode !== "tmpl") push(lx, "punct", "}");
    return advance(lx, at + 1);
  }
  end = sticky(ID, lx);
  if (end < 0) end = sticky(NUM, lx);
  if (end > at) {
    const word = src.slice(at, end);
    push(lx, /\d|\./.test(c) ? "num" : KEYWORDS.has(word) ? "kw" : "id", word);
    return advance(lx, end);
  }
  if (c === "/" && regexAllowed(lx) && (end = regexEnd(src, at)) > 0) {
    end = sticky(/[a-z]*/y, lx, end);
    push(lx, "regex", src.slice(at, end));
    return advance(lx, end);
  }
  if (c === "<" && lx.jsx && jsxAllowed(lx)) return openTag(lx);
  end = sticky(PUNCT, lx);
  if (end < 0) return advance(lx, at + 1);
  const p = src.slice(at, end);
  if (p === "{") top.depth++;
  else if (p === "}") top.depth--;
  push(lx, "punct", p);
  advance(lx, end);
}

/** @param {Lexer} lx */
function tagStep(lx) {
  const { src, at } = lx;
  const c = src[at];
  let end = sticky(SPACE, lx);
  if (end > at) return advance(lx, end);
  if (c === ">" || (c === "/" && src[at + 1] === ">")) {
    push(lx, "tag", c === ">" ? ">" : "/>");
    lx.stack.pop();
    if (c === ">") lx.stack.push({ mode: "children", depth: 0 });
    return advance(lx, at + c.length + (c === "/" ? 1 : 0));
  }
  if (c === "{") {
    push(lx, "punct", "{");
    lx.stack.push({ mode: "code", depth: 0 });
    return advance(lx, at + 1);
  }
  if (c === '"' || c === "'") {
    end = quoteEnd(src, at);
    push(lx, "str", src.slice(at, end));
    return advance(lx, end);
  }
  end = sticky(ATTR, lx);
  if (end > at) push(lx, "attr", src.slice(at, end));
  else if (c === "=") push(lx, "punct", "=");
  advance(lx, Math.max(end, at + 1));
}

/** @param {Lexer} lx */
function childrenStep(lx) {
  const { src, at } = lx;
  if (src[at] === "{") {
    push(lx, "punct", "{");
    lx.stack.push({ mode: "code", depth: 0 });
    return advance(lx, at + 1);
  }
  if (src[at] === "<" && src[at + 1] === "/") {
    const gt = src.indexOf(">", at);
    const end = gt < 0 ? src.length : gt + 1;
    push(lx, "tag", `</${src.slice(at + 2, end - 1).trim()}`);
    lx.stack.pop();
    return advance(lx, end);
  }
  if (src[at] === "<") return openTag(lx);
  let end = src.length;
  for (const stop of ["<", "{"]) {
    const i = src.indexOf(stop, at);
    if (i >= 0 && i < end) end = i;
  }
  const text = src.slice(at, end).trim();
  if (text) push(lx, "text", text);
  advance(lx, end);
}

/** @param {Lexer} lx */
function tmplStep(lx) {
  const { src, at } = lx;
  let j = at;
  while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
  if (j > at) push(lx, "str", src.slice(at, j));
  if (src[j] === "`" || j >= src.length) {
    lx.stack.pop();
    return advance(lx, Math.min(j + 1, src.length));
  }
  lx.stack.push({ mode: "code", depth: 0 });
  advance(lx, j + 2);
}

/**
 * @param {string} src
 * @param {boolean} jsx
 * @returns {Tokens}
 */
function tokenize(src, jsx) {
  /** @type {Lexer} */
  const lx = { src, at: 0, line: 1, tokens: { text: [], kind: [], line: [] }, stack: [{ mode: "code", depth: 0 }], jsx };
  while (lx.at < src.length) {
    const top = lx.stack[lx.stack.length - 1];
    if (top.mode === "code") codeStep(lx, top);
    else if (top.mode === "tag") tagStep(lx);
    else if (top.mode === "children") childrenStep(lx);
    else tmplStep(lx);
  }
  return lx.tokens;
}

/** Bracket depth before each token, the innermost open bracket around it, and each opener's closer. @param {Tokens} tk */
function nesting(tk) {
  const n = tk.text.length;
  const depth = new Int32Array(n);
  const parent = new Int32Array(n);
  const close = new Int32Array(n).fill(-1);
  /** @type {number[]} */
  const open = [];
  for (let i = 0; i < n; i++) {
    depth[i] = open.length;
    parent[i] = open.length ? open[open.length - 1] : -1;
    if (tk.kind[i] !== "punct") continue;
    const t = tk.text[i];
    if (t === "(" || t === "[" || t === "{") open.push(i);
    else if ((t === ")" || t === "]" || t === "}") && open.length) close[/** @type {number} */ (open.pop())] = i;
  }
  for (const i of open) close[i] = n - 1;
  return { depth, parent, close };
}

/** Names bound by top-level imports: what a copy calls by the same name. @param {Tokens} tk @param {Int32Array} depth */
function importsOf(tk, depth) {
  /** @type {Set<string>} */
  const names = new Set();
  for (let i = 0; i < tk.text.length; i++) {
    if (depth[i] !== 0 || tk.text[i] !== "import" || tk.text[i + 1] === "(") continue;
    for (i++; i < tk.text.length && tk.kind[i] !== "str"; i++) if (tk.kind[i] === "id") names.add(tk.text[i]);
  }
  return names;
}

/** Names declared at the top of the file: the module's own helpers and state. @param {Tokens} tk @param {Int32Array} depth */
function topNames(tk, depth) {
  /** @type {Set<string>} */
  const names = new Set();
  for (let i = 0; i < tk.text.length - 1; i++) {
    if (depth[i] === 0 && /^(?:const|let|var|function|class|enum)$/.test(tk.text[i]) && tk.kind[i + 1] === "id") names.add(tk.text[i + 1]);
  }
  return names;
}

/**
 * The last token of the statement starting at `j`: a `;` or a new line that cannot continue the expression.
 * @param {Tokens} tk @param {number} j @param {Int32Array} close
 */
function statementEnd(tk, j, close) {
  for (let k = j; k < tk.text.length; k++) {
    if (k > j && tk.line[k] > tk.line[k - 1] && !CONTINUES.has(tk.text[k])) {
      const p = tk.text[k - 1];
      if (ENDS_EXPR.has(p) || /^(?:id|str|num|regex|text)$/.test(tk.kind[k - 1])) return k - 1;
    }
    if (tk.text[k] === ";" && tk.kind[k] === "punct") return k;
    if (close[k] > k) k = close[k];
  }
  return tk.text.length - 1;
}

/** Index of a function body's `{` after the parameters, or -1 for an overload signature. @param {Tokens} tk @param {number} k @param {Int32Array} close */
function bodyBrace(tk, k, close) {
  for (; k < tk.text.length; k++) {
    const t = tk.text[k];
    if (t === ";") return -1;
    if (t === "{" && !TYPE_BRACE_AFTER.has(tk.text[k - 1])) return k;
    if (close[k] > k) k = close[k];
  }
  return -1;
}

/** Whether a `const` initializer is a function: an arrow, `function`, or a wrapper call like `memo(…)` around one. @param {Tokens} tk @param {number} k @param {Int32Array} close */
function functionInit(tk, k, close) {
  const t = (/** @type {number} */ i) => tk.text[i];
  if (t(k) === "async") k++;
  if (t(k) === "function") return true;
  if (tk.kind[k] === "id" && t(k + 1) === "=>") return true;
  if (t(k) === "<") while (k < tk.text.length && t(k) !== "(") k++;
  // `(…) :` at the start of an initializer can only be an arrow's return type.
  if (t(k) === "(") return t(close[k] + 1) === "=>" || t(close[k] + 1) === ":";
  while (tk.kind[k] === "id" && (t(k + 1) === "." || t(k + 1) === "(")) {
    if (t(k + 1) === "(") return functionInit(tk, k + 2, close);
    k += 2;
  }
  return false;
}

/**
 * The unit declared by the statement at `i`, if any.
 * @param {Tokens} tk @param {number} i @param {Int32Array} close @param {string} fallback name for an anonymous default export
 * @returns {{ name: string, kind: string, start: number, end: number } | undefined}
 */
function unitAt(tk, i, close, fallback) {
  let j = i;
  while (MODIFIERS.has(tk.text[j])) j++;
  const t = tk.text[j];
  const named = tk.kind[j + 1] === "id";
  if (t === "function") {
    if (tk.text[j + 1] === "*") j++;
    const name = tk.kind[j + 1] === "id" ? tk.text[j + 1] : tk.text[j - 1] === "default" ? fallback : "";
    const paren = tk.text.indexOf("(", j);
    const body = name && paren > 0 ? bodyBrace(tk, close[paren] + 1, close) : -1;
    return body > 0 ? { name, kind: "function", start: i, end: close[body] } : undefined;
  }
  if ((t === "class" || t === "interface") && named) {
    const body = bodyBrace(tk, j + 2, close);
    return body > 0 ? { name: tk.text[j + 1], kind: t === "class" ? "class" : "type", start: i, end: close[body] } : undefined;
  }
  if (t === "type" && named && (tk.text[j + 2] === "=" || tk.text[j + 2] === "<")) {
    return { name: tk.text[j + 1], kind: "type", start: i, end: statementEnd(tk, j, close) };
  }
  if ((t === "const" || t === "let" || t === "var") && named) {
    let k = j + 2;
    while (k < tk.text.length && tk.text[k] !== "=" && tk.text[k] !== ";") k = close[k] > k ? close[k] + 1 : k + 1;
    if (tk.text[k] !== "=" || !functionInit(tk, k + 1, close)) return undefined;
    return { name: tk.text[j + 1], kind: "function", start: i, end: statementEnd(tk, k + 1, close) };
  }
  return undefined;
}

/** Members of a type: each `name: shape` entry of its top-level braces, as written. @param {Tokens} tk @param {number} start @param {number} end @param {Int32Array} depth */
function membersOf(tk, start, end, depth) {
  /** @type {string[]} */
  const members = [];
  let current = "";
  let braces = false;
  for (let k = start; k <= end; k++) {
    const t = tk.text[k];
    if (depth[k] === 0) braces = t === "{" || (braces && t !== "(" && t !== "[");
    const top = depth[k] === 1 && braces;
    const fresh = top && tk.line[k] > tk.line[k - 1] && /^(?:id|kw|str)$/.test(tk.kind[k]) && /^(?::|\?|\(|\?:)$/.test(tk.text[k + 1]) && !TYPE_BRACE_AFTER.has(tk.text[k - 1]);
    if ((fresh || (top && (t === ";" || t === ",")) || depth[k] === 0 || (top && t === "}")) && current) {
      members.push(current);
      current = "";
    }
    if (braces && depth[k] >= 1 && !(top && (t === ";" || t === "," || t === "}"))) current += (current ? " " : "") + t;
  }
  return members;
}

/**
 * The normalised form of token `k`. What carries meaning stays: keywords, operators, JSX tags and attributes,
 * imported and global names, properties and object keys (the data a unit touches). Local names become `I`, literals
 * `S`, `N`, `R` and JSX text `T`, so a renamed or reworded copy normalises the same.
 * @param {Tokens} tk @param {number} k @param {Set<string>} kept @param {Int32Array} parent
 */
function normal(tk, k, kept, parent) {
  const kind = tk.kind[k];
  const t = tk.text[k];
  if (kind === "id") {
    const p = tk.text[k - 1];
    if (p === "." || p === "?.") return t;
    if (tk.text[k + 1] === ":" && (p === "{" || p === ",") && tk.text[parent[k]] === "{") return t;
    return kept.has(t) || BROWSER.has(t) || t in globalThis ? t : "I";
  }
  if (kind === "str") return "S";
  if (kind === "num") return "N";
  if (kind === "regex") return "R";
  if (kind === "text") return "T";
  return t;
}

/**
 * @param {string} src
 * @param {string} path
 * @returns {Unit[]}
 */
export function units(src, path) {
  const tk = tokenize(src, JSX_FILE.test(path));
  const { depth, parent, close } = nesting(tk);
  const kept = importsOf(tk, depth);
  const fallback = (path.split("/").pop() ?? "").replace(/\..*$/, "");
  const own = topNames(tk, depth);
  /** @type {Unit[]} */
  const found = [];
  for (let i = 0; i < tk.text.length; i++) {
    const starts = i === 0 || tk.text[i - 1] === ";" || tk.text[i - 1] === "}" || tk.line[i] > tk.line[i - 1];
    if (depth[i] !== 0 || !starts) continue;
    const u = unitAt(tk, i, close, fallback);
    if (!u) continue;
    // A function compares from its parameters on, without its own `=>`, so `function F(…) {…}` and
    // `const F = (…) => {…}` read the same. Braces and semicolons are style (`if (x) y` is `if (x) { y; }`).
    const from = u.kind === "function" ? Math.max(u.start, tk.text.indexOf("(", u.start)) : u.start;
    const at = [];
    for (let k = from; k <= u.end; k++) {
      const t = tk.text[k];
      const style = tk.kind[k] === "punct" && (t === "{" || t === "}" || t === ";");
      if (u.kind === "type" || (!style && !(depth[k] === 0 && t === "=>"))) at.push(k);
    }
    const norm = at.map((k) => normal(tk, k, kept, parent));
    const jsx = at.some((k) => tk.kind[k] === "tag");
    const kind = u.kind === "function" && /^use[A-Z0-9]/.test(u.name) ? "hook" : u.kind === "function" && jsx && /^[A-Z]/.test(u.name) ? "component" : u.kind;
    found.push({
      name: u.name,
      kind,
      line: tk.line[u.start],
      endLine: tk.line[u.end],
      norm,
      raw: at.map((k) => tk.text[k]),
      rawKind: at.map((k, n) => (tk.kind[k] !== "id" ? tk.kind[k] : kept.has(norm[n]) ? "dep" : norm[n] === "I" && own.has(tk.text[k]) ? "mod" : "id")),
      members: kind === "type" ? membersOf(tk, u.start, u.end, depth) : [],
    });
    i = u.end;
  }
  return found;
}
