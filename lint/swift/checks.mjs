// @ts-check
// Swift checks SwiftLint cannot express. A small scanner blanks comments and strings and matches braces; on top of it
// sit the regions some rules skip (#Preview, #if DEBUG, command-line tools) and the `check:` rules in rules.yml.

/**
 * A `{ … }` block in the masked source: `depth` counts the blocks around it, `header` is the code since the previous
 * `{`, `}` or `;` (the declaration or call that opens the block), starting at `start`.
 * @typedef {{ open: number, close: number, depth: number, parent: Block | undefined, header: string, start: number }} Block
 */
/**
 * A type or extension: `attrs` are its attributes (`@MainActor`), `inherits` its conformance list.
 * @typedef {{ kind: string, name: string, attrs: string, inherits: string[] }} TypeDecl
 */
/**
 * A scanned file: `masked` is `text` with comments and strings blanked, `starts` the offset of each line.
 * @typedef {{ text: string, masked: string, blocks: Block[], starts: number[] }} Scanned
 */
/** @typedef {{ line: number, column: number }} Hit */
/** @typedef {{ classes: Set<string>, mainActor: Set<string> }} Project */

const rawStart = /#+"/y;

/**
 * The text with every comment and string literal (interpolations included) replaced by spaces, newlines kept, so
 * what is left is code with its offsets unchanged.
 * @param {string} text
 */
function mask(text) {
  const out = text.split("");
  /** @param {number} from @param {number} to */
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /** Skips code from i to an unmatched `)` (the end of an interpolation) or the end of the text. @param {number} i */
  const code = (i, inside = false) => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      const next = text[i + 1];
      rawStart.lastIndex = i;
      if (c === "/" && (next === "/" || next === "*")) {
        const end = next === "/" ? lineEnd(text, i) : commentEnd(text, i);
        blank(i, end);
        i = end;
      } else if (c === '"' || (c === "#" && rawStart.test(text))) {
        const end = string(i);
        blank(i, end);
        i = end;
      } else {
        if (inside && c === ")" && depth-- === 0) return i;
        if (inside && c === "(") depth++;
        i++;
      }
    }
    return i;
  };
  /** Skips the string literal starting at i (`"`, `"""`, `#"…"#`) and returns the index after it. @param {number} i */
  const string = (i) => {
    const hashes = /^#*/.exec(text.slice(i, i + 8))?.[0] ?? "";
    i += hashes.length;
    const multi = text.startsWith('"""', i);
    const close = (multi ? '"""' : '"') + hashes;
    const escape = `\\${hashes}`;
    for (i += multi ? 3 : 1; i < text.length; ) {
      if (text.startsWith(escape, i)) {
        i += escape.length;
        i = text[i] === "(" ? code(i + 1, true) + 1 : i + 1;
      } else if (text.startsWith(close, i)) {
        return i + close.length;
      } else if (!multi && text[i] === "\n") {
        return i;
      } else {
        i++;
      }
    }
    return i;
  };
  code(0);
  return out.join("");
}

/** @param {string} text @param {number} i */
const lineEnd = (text, i) => (text.indexOf("\n", i) + 1 || text.length + 1) - 1;

/** The index after the (nestable) block comment starting at i. @param {string} text @param {number} i */
function commentEnd(text, i) {
  let depth = 0;
  for (; i < text.length; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === "*/" && depth === 1) return i + 2;
    if (pair === "/*" || pair === "*/") {
      depth += pair === "/*" ? 1 : -1;
      i++;
    }
  }
  return text.length;
}

/**
 * Scans a file: masks it, matches its braces, and indexes its lines.
 * @param {string} text
 * @returns {Scanned}
 */
export function scan(text) {
  const masked = mask(text);
  /** @type {Block[]} */
  const blocks = [];
  /** @type {Block[]} */
  const stack = [];
  let boundary = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") {
      const block = { open: i, close: masked.length, depth: stack.length, parent: stack.at(-1), header: masked.slice(boundary, i).trim(), start: boundary };
      block.start += masked.slice(boundary, i).search(/\S|$/);
      blocks.push(block);
      stack.push(block);
    } else if (c === "}") {
      const block = stack.pop();
      if (block) block.close = i;
    }
    if (c === "{" || c === "}" || c === ";") boundary = i + 1;
  }
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return { text, masked, blocks, starts };
}

/**
 * The 1-based line and column of an offset.
 * @param {Scanned} f
 * @param {number} index
 * @returns {Hit}
 */
function position(f, index) {
  let lo = 0;
  let hi = f.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f.starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - f.starts[lo] + 1 };
}

const typePattern =
  /((?:@\w+(?:\([^()]*\))?\s+)*)(?:(?:public|private|fileprivate|internal|package|open|final|indirect|nonisolated)\s+)*(struct|class|enum|actor|extension|protocol)\s+(?!(?:func|var|let|override|subscript|static)\b)([A-Za-z_][\w.]*)\s*(?:<[^{]*?>)?\s*(?::\s*([^{]*?))?\s*(?:\bwhere\b[^{]*)?$/;

/**
 * The type or extension a block declares, if it declares one.
 * @param {Block} block
 * @returns {TypeDecl | undefined}
 */
function typeOf(block) {
  const m = typePattern.exec(block.header);
  if (!m) return undefined;
  const inherits = (m[4] ?? "").split(",").map((s) => s.trim().replace(/^SwiftUI\./, "")).filter(Boolean);
  return { attrs: m[1], kind: m[2], name: m[3], inherits };
}

/** The innermost block around an offset. @param {Scanned} f @param {number} index */
const blockAt = (f, index) => f.blocks.findLast((b) => b.open < index && b.close > index);

/** The type or extension declaration around an offset. @param {Scanned} f @param {number} index */
function typeAt(f, index) {
  for (let b = blockAt(f, index); b; b = b.parent) {
    const t = typeOf(b);
    if (t) return t;
  }
  return undefined;
}

/** The line ranges of #Preview blocks and PreviewProvider types. @param {Scanned} f */
function previewRanges(f) {
  return f.blocks
    .filter((b) => /#Preview\b/.test(b.header) || typeOf(b)?.inherits.includes("PreviewProvider"))
    .map((b) => [position(f, b.start).line, position(f, b.close).line]);
}

/** The line ranges compiled only into debug builds: `#if DEBUG` (or the `#else` of `#if !DEBUG`). @param {Scanned} f */
function debugRanges(f) {
  /** @type {number[][]} */
  const ranges = [];
  /** @type {{ debug: boolean, negated: boolean, from: number }[]} */
  const stack = [];
  f.masked.split("\n").forEach((line, i) => {
    const directive = /^\s*#(if|elseif|else|endif)\b(.*)/.exec(line);
    if (!directive) return;
    const top = stack.at(-1);
    if (top?.debug) ranges.push([top.from, i + 1]);
    if (directive[1] === "if") {
      const debug = /^\s*\(?\s*DEBUG\b/.test(directive[2]);
      stack.push({ debug, negated: /^\s*!\s*DEBUG\s*$/.test(directive[2]), from: i + 1 });
    } else if (top && directive[1] !== "endif") {
      Object.assign(top, { debug: directive[1] === "else" && top.negated, negated: false, from: i + 1 });
    } else {
      stack.pop();
    }
  });
  return ranges;
}

/**
 * The line ranges each region covers: `preview` (#Preview and PreviewProvider), `debug` (#if DEBUG) and `cli` (the
 * whole file, when it is a command-line tool built on ArgumentParser or CommandLine.arguments).
 * @param {Scanned} f
 * @returns {Record<string, number[][]>}
 */
export function regions(f) {
  const cli = /^\s*import\s+ArgumentParser\b|\bCommandLine\.arguments\b/m.test(f.masked) ? [[1, f.starts.length]] : [];
  return { preview: previewRanges(f), debug: debugRanges(f), cli };
}

/**
 * The class names and main-actor types (@MainActor, SwiftUI views, UIKit views and controllers) declared anywhere in
 * the project, so an `extension Foo` in another file knows what Foo is.
 * @param {Scanned[]} files
 * @returns {Project}
 */
export function project(files) {
  /** @type {Project} */
  const p = { classes: new Set(), mainActor: new Set() };
  for (const f of files) {
    for (const b of f.blocks) {
      const t = typeOf(b);
      if (!t || t.kind === "extension") continue;
      if (t.kind === "class") p.classes.add(t.name);
      if (isMainActor(t, p)) p.mainActor.add(t.name);
    }
  }
  return p;
}

/** @param {TypeDecl} t @param {Project} p */
function isMainActor(t, p) {
  if (/@MainActor\b/.test(t.attrs) || (t.kind === "extension" && (p.mainActor.has(t.name) || /^(?:View|App|Scene)$/.test(t.name)))) return true;
  return t.inherits.some((name) => /^(?:View|App|Scene)$|^UI\w*(?:View|Controller|Cell|Window)$/.test(name) || p.mainActor.has(name));
}

/** View builders: `var body: some View`, any other `var x: some View`, and functions returning `some View`. */
const viewBuilder = /(?:\bvar\s+\w+\s*:\s*some\s+View|->\s*some\s+View)\s*$/;

/** @param {Scanned} f @param {Block} b The number of lines inside a block that hold code. */
const codeLines = (f, b) => f.masked.slice(b.open + 1, b.close).split("\n").filter((line) => line.trim() && line.trim() !== "}").length;

/**
 * Rules that need the scanner, by the name rules.yml gives them in `check:`. Each returns the places to report.
 * @type {Record<string, (f: Scanned, p: Project, config: any) => Hit[]>}
 */
export const checks = {
  /** A view builder with more than `max` lines of code. */
  viewBodyLength(f, _p, { max }) {
    return f.blocks.filter((b) => viewBuilder.test(b.header) && codeLines(f, b) > max).map((b) => declaration(f, b, /\b(?:var|func)\b/g));
  },

  /** A view builder whose braces nest deeper than `max` inside it. */
  viewNesting(f, _p, { max }) {
    return f.blocks
      .filter((b) => viewBuilder.test(b.header) && !viewBuilder.test(enclosingBuilder(b)?.header ?? ""))
      .filter((b) => Math.max(0, ...f.blocks.filter((x) => x.open > b.open && x.close < b.close).map((x) => x.depth - b.depth)) > max)
      .map((b) => declaration(f, b, /\b(?:var|func)\b/g));
  },

  /** A class whose `static let shared` instance exposes settable properties, or a `static var shared`. */
  singletonState(f) {
    /** @type {Hit[]} */
    const hits = [];
    for (const m of f.masked.matchAll(/\bstatic\s+(let|var)\s+shared\b/g)) {
      const index = m.index ?? 0;
      const owner = blockAt(f, index);
      if (!owner || typeOf(owner)?.kind !== "class") continue;
      if (m[1] === "var" || settableVars(f, owner).length) hits.push(position(f, index));
    }
    return hits;
  },

  /** A closure kept alive by a subscription, observer or repeating timer that captures self strongly, in a class. */
  strongSelfCapture(f, p) {
    const trigger = /\.sink\s*[({]|\baddObserver\s*\(\s*forName\s*:|\bTimer\.scheduledTimer\s*\(\s*withTimeInterval\s*:[^)]*\brepeats\s*:\s*true\b|\.assign\s*\(\s*to\s*:[^()]*\bon\s*:\s*self\s*\)/g;
    /** @type {Hit[]} */
    const hits = [];
    for (const m of f.masked.matchAll(trigger)) {
      const index = m.index ?? 0;
      const t = typeAt(f, index);
      if (!t || !(t.kind === "class" || (t.kind === "extension" && p.classes.has(t.name)))) continue;
      const strong = m[0].startsWith(".assign") || closuresOf(f, index + f.masked.slice(index).search(/[({]/)).some((b) => {
        const body = f.masked.slice(b.open + 1, b.close);
        return !/^\s*\[[^\]]*\b(?:weak|unowned)\s+self\b/.test(body) && /\bself\b/.test(body);
      });
      if (strong) hits.push(position(f, index));
    }
    return hits;
  },

  /** DispatchQueue.main.async or MainActor.run in code that already runs on the main actor. */
  mainActorDispatch(f, p) {
    return [...f.masked.matchAll(/\bDispatchQueue\.main\.async\s*(?:\{|\(\s*execute\s*:)|\bawait\s+MainActor\.run\s*[({]/g)]
      .filter((m) => onMainActor(f, p, m.index ?? 0))
      .map((m) => position(f, m.index ?? 0));
  },

  /** A whole-line comment whose words all appear in the line of code under it. */
  restatingComment(f, _p, { maxWords }) {
    const lines = f.text.split("\n");
    const masked = f.masked.split("\n");
    /** @type {Hit[]} */
    const hits = [];
    lines.forEach((line, i) => {
      const comment = /^\s*\/\/(?!\/)\s*(.*)$/.exec(line);
      if (!comment || masked[i].trim() || !masked[i + 1]?.trim() || /^\s*\/\//.test(lines[i - 1] ?? "")) return;
      if (/^(?:MARK|TODO|FIXME|NOTE|HACK|swiftlint|-)/i.test(comment[1])) return;
      const words = comment[1].split(/[^A-Za-z]+/).filter(Boolean);
      const meaning = words.map(stem).filter((w) => w.length > 1 && !stopWords.has(w));
      const code = new Set(masked[i + 1].split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map(stem));
      if (words.length <= maxWords && meaning.length && meaning.every((w) => code.has(w))) hits.push({ line: i + 1, column: line.indexOf("//") + 1 });
    });
    return hits;
  },

  /** A SwiftUI view with more than `max` @State properties. */
  stateCount(f, _p, { max }) {
    return views(f).filter((v) => stateDecls(f, v).length > max).map((v) => declaration(f, v, /\bstruct\b/g));
  },

  /** A SwiftUI view with `min` or more @State booleans that each drive a sheet, alert or dialog (`isPresented: $flag`). */
  presentationFlags(f, _p, { min }) {
    return views(f)
      .map((v) =>
        stateDecls(f, v).filter((d) => {
          const name = /\bvar\s+(\w+)\s*(?::\s*Bool\s*)?=\s*(?:false|true)\s*$/.exec(d.text)?.[1];
          // The whole file, since the modifiers may sit in an extension of the view.
          return name && new RegExp(`\\bisPresented\\s*:\\s*\\$${name}\\b`).test(f.masked);
        }),
      )
      .filter((flags) => flags.length >= min)
      .map((flags) => position(f, flags[0].index));
  },
};

/**
 * Where the declaration that opens a block starts: the last match of `keyword` in its header.
 * @param {Scanned} f
 * @param {Block} b
 * @param {RegExp} keyword with the g flag
 */
function declaration(f, b, keyword) {
  const matches = [...f.masked.slice(b.start, b.open).matchAll(keyword)];
  return position(f, b.start + (matches.at(-1)?.index ?? 0));
}

/** The nearest view builder around a block. @param {Block} block */
function enclosingBuilder(block) {
  for (let b = block.parent; b; b = b.parent) if (viewBuilder.test(b.header)) return b;
  return undefined;
}

/** The structs that conform to View. @param {Scanned} f */
const views = (f) => f.blocks.filter((b) => {
  const t = typeOf(b);
  return t?.kind === "struct" && t.inherits.includes("View");
});

/**
 * The @State declarations directly inside a type (not in its methods or nested types), with their line text.
 * @param {Scanned} f
 * @param {Block} type
 */
function stateDecls(f, type) {
  const inside = f.masked.slice(type.open, type.close);
  /** @type {{ index: number, text: string }[]} */
  const found = [];
  for (const m of inside.matchAll(/@State\b(?!Object)/g)) {
    const index = type.open + (m.index ?? 0);
    if (blockAt(f, index) === type) found.push({ index, text: f.masked.slice(f.starts[position(f, index).line - 1], lineEnd(f.masked, index)) });
  }
  return found;
}

/**
 * The settable `var`s declared directly in a type (not private, private(set) or computed).
 * @param {Scanned} f
 * @param {Block} type
 */
function settableVars(f, type) {
  const inside = f.masked.slice(type.open + 1, type.close);
  return [...inside.matchAll(/(?:^|[{;])[ \t]*((?:@\w+(?:\([^()\n]*\))?[ \t]+|\w+[ \t]+)*)var[ \t]+\w+([^\n;]*)/gm)].filter((m) => {
    const index = type.open + 1 + (m.index ?? 0) + m[0].search(/\S/);
    const computed = /^[^=]*\{/.test(m[2]);
    return blockAt(f, index) === type && !/\b(?:private|fileprivate|static|class)\b/.test(m[1]) && !computed;
  });
}

/**
 * The closures passed to the call whose `(` or `{` is at `at`: closure arguments and a trailing closure.
 * @param {Scanned} f
 * @param {number} at
 */
function closuresOf(f, at) {
  let end = at;
  if (f.masked[at] === "(") {
    for (let depth = 0; end < f.masked.length; end++) {
      if (f.masked[end] === "(") depth++;
      if (f.masked[end] === ")" && --depth === 0) break;
    }
    end = f.masked.slice(end + 1).search(/\S|$/) + end + 1;
  }
  const caller = blockAt(f, at);
  return f.blocks.filter((b) => b.open >= at && b.open <= end && b.parent === caller);
}

/** SwiftUI and concurrency closures that run on the main actor when their caller does. */
const mainClosure = /(?:^|\.)(?:onAppear|onDisappear|onTapGesture|onLongPressGesture|onChange|onSubmit|task|refreshable)\b|^Button\b|\baction\s*:$|^withAnimation\b|^Task\s*(?:\(\s*priority\s*:[^()]*\))?$/;
const declarationStart = /^(?:(?:public|private|fileprivate|internal|package|open|final|override|static|class|mutating|nonmutating|convenience|required|lazy)\s+)*(?:func|init|deinit|subscript|var|get|set|willSet|didSet)\b(?![^=]*=\s*$)/;
const control = /^(?:if|else|guard|for|while|repeat|switch|do|catch|defer)\b/;

/**
 * Whether the code at an offset runs on the main actor: inside a main-actor type or @MainActor function, through
 * only control flow, declarations and closures that keep the caller's actor.
 * @param {Scanned} f
 * @param {Project} p
 * @param {number} index
 */
function onMainActor(f, p, index) {
  for (let b = blockAt(f, index); b; b = b.parent) {
    const t = typeOf(b);
    if (t) return isMainActor(t, p);
    const lines = b.header.split("\n").map((line) => line.trim());
    let from = lines.length - 1;
    while (from > 0 && (count(lines.slice(from).join(" "), ")") > count(lines.slice(from).join(" "), "(") || lines[from - 1].startsWith("@"))) from--;
    const statement = lines.slice(from).join(" ").replace(/^(?:@\w+(?:\([^()]*\))?\s+)*/, (attrs) => (/@MainActor\b/.test(attrs) ? "@MainActor " : ""));
    if (/\bnonisolated\b/.test(statement)) return false;
    if (statement.startsWith("@MainActor ")) return true;
    if (!declarationStart.test(statement) && !control.test(statement) && !mainClosure.test(statement)) return false;
  }
  return false;
}

/** @param {string} text @param {string} c */
const count = (text, c) => text.split(c).length - 1;

/** A crude stem so `loading`, `loaded` and `loads` all match `load`. @param {string} word */
const stem = (word) => word.toLowerCase().replace(/(?<=\w{3})(?:ing|ed|es|s)$/, "");

/** Words that carry no meaning of their own in a comment about the next line. */
const stopWords = new Set(
  "the a an to of for and or in on at with from by this that it its is are be if then new our we all current as into up now here value method function func var variable property call set get create make init initialize update add return check handle do perform use".split(" ").map(stem),
);
