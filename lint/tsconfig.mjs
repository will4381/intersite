// @ts-check
// The compiler options a project's tsconfig.json ends up with, following `extends` (relative paths and packages, one
// or several) the way TypeScript does: later files override earlier ones, the file itself overrides what it extends.
// tsconfig files allow comments and trailing commas, so they are stripped before parsing.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

/** JSON with comments and trailing commas made plain JSON; strings are left as they are. @param {string} text */
function plainJson(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Where an `extends` entry points, from the file that names it. @param {string} entry @param {string} from */
function extendsPath(entry, from) {
  if (entry.startsWith(".") || entry.startsWith("/")) {
    const path = resolve(dirname(from), entry);
    return existsSync(path) || path.endsWith(".json") ? path : `${path}.json`;
  }
  const require = createRequire(from);
  try {
    return require.resolve(entry);
  } catch {
    return require.resolve(`${entry}/tsconfig.json`);
  }
}

/**
 * The merged `compilerOptions` of a tsconfig file, or undefined when it cannot be read.
 * @param {string} file @param {number} [depth]
 * @returns {Record<string, unknown> | undefined}
 */
export function compilerOptions(file, depth = 0) {
  if (depth > 10 || !existsSync(file)) return undefined;
  let config;
  try {
    config = JSON.parse(plainJson(readFileSync(file, "utf8")));
  } catch {
    // An unreadable tsconfig is unknown, and unknown keeps the rules that depend on it off.
    return undefined;
  }
  const bases = (Array.isArray(config.extends) ? config.extends : config.extends ? [config.extends] : []).map((/** @type {string} */ entry) => {
    try {
      return compilerOptions(extendsPath(entry, file), depth + 1) ?? {};
    } catch {
      // A base that cannot be found adds nothing, as TypeScript would refuse it; the file's own options still count.
      return {};
    }
  });
  return Object.assign({}, ...bases, config.compilerOptions ?? {});
}
