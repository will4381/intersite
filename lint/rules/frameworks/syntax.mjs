// @ts-check
// Syntax helpers the framework rules share.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { unwrap } from "../shared.mjs";

/** The base of a member chain, not crossing calls: `db` for `db.query.users.findFirst`. @param {any} node */
export function memberBase(node) {
  while (node?.type === "MemberExpression") node = node.object;
  return node;
}

/** Every method name along a call chain, outermost first: `["where", "set", "update"]` for `db.update(t).set(v).where(c)`. @param {any} node */
export function chainMethods(node) {
  const names = [];
  for (let n = unwrap(node); n?.type === "CallExpression" || n?.type === "MemberExpression"; n = n.type === "CallExpression" ? n.callee : n.object) {
    if (n.type === "MemberExpression" && !n.computed) names.push(n.property.name);
  }
  return names;
}

/** The root of a whole call chain, crossing calls: `supabase` for `supabase.from('t').select().eq('id', 1)`. @param {any} node */
export function chainRoot(node) {
  let n = unwrap(node);
  while (n?.type === "CallExpression" || n?.type === "MemberExpression") n = n.type === "CallExpression" ? n.callee : n.object;
  return n;
}

/** True when the file imports or requires a module whose name matches. @param {any} program @param {RegExp} name */
export function importsModule(program, name) {
  return program.body.some((/** @type {any} */ s) =>
    (s.type === "ImportDeclaration" && name.test(s.source.value)) ||
    (s.type === "VariableDeclaration" && s.declarations.some((/** @type {any} */ d) => {
      const init = unwrap(d.init);
      return init?.type === "CallExpression" && init.callee.name === "require" && name.test(init.arguments[0]?.value ?? "");
    })));
}

/** @type {Map<string, Record<string, string> | null>} directory -> merged dependencies of its package.json */
const packages = new Map();

/**
 * The version range of `name` in the nearest package.json, walking up from `file`, that lists it; undefined when none does.
 * @param {string} file @param {string} name
 */
export function dependencyRange(file, name) {
  for (let dir = dirname(file), up = ""; dir !== up; up = dir, dir = dirname(dir)) {
    if (!packages.has(dir)) {
      const path = join(dir, "package.json");
      let deps = null;
      try {
        if (existsSync(path)) {
          const pkg = JSON.parse(readFileSync(path, "utf8"));
          deps = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };
        }
      } catch {
        deps = null; // An unreadable package.json says nothing about the dependency.
      }
      packages.set(dir, deps);
    }
    const range = packages.get(dir)?.[name];
    if (range) return range;
  }
  return undefined;
}
