// @ts-check
// What the naming rules share: the names a file declares itself (not imports, which a library chose) and splitting a
// name into its words.

/**
 * Calls `see(id, how)` for every name the file binds itself: variables, functions, classes and parameters. `how` is
 * "destructured" for a name taken from an object pattern without renaming (`const { user_id } = body`), whose spelling
 * belongs to the data, and "param" for a parameter.
 * @param {(id: any, how: "declared" | "destructured" | "param") => void} see
 */
export function bindings(see) {
  /** @param {any} pattern @param {"declared" | "param"} how */
  const visit = (pattern, how) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") see(pattern, how);
    else if (pattern.type === "AssignmentPattern") visit(pattern.left, how);
    else if (pattern.type === "RestElement") visit(pattern.argument, how);
    else if (pattern.type === "ArrayPattern") for (const e of pattern.elements) visit(e, how);
    else if (pattern.type === "ObjectPattern") {
      for (const p of pattern.properties) {
        if (p.type === "RestElement") visit(p.argument, how);
        else if (p.shorthand) see(p.value.type === "AssignmentPattern" ? p.value.left : p.value, "destructured");
        else visit(p.value, how);
      }
    }
  };
  /** @param {any} fn */
  const fn = (fn) => {
    if (fn.id) see(fn.id, "declared");
    for (const p of fn.params) visit(p.type === "TSParameterProperty" ? p.parameter : p, "param");
  };
  return {
    VariableDeclarator: (/** @type {any} */ node) => visit(node.id, "declared"),
    FunctionDeclaration: fn,
    FunctionExpression: fn,
    ArrowFunctionExpression: fn,
    ClassDeclaration: (/** @type {any} */ node) => node.id && see(node.id, "declared"),
  };
}

/**
 * The words of an identifier with their case kept: `parseURLParams` gives parse, URL, Params; `user_id` gives user, id.
 * @param {string} name
 */
export const words = (name) => name.replace(/^[_$]+|[_$]+$/g, "").split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);

/** Whether a function node sits directly at module scope (declared, exported, or assigned to a top-level const). @param {any} fn */
export function atModuleScope(fn) {
  let n = fn.parent;
  while (n && (n.type === "VariableDeclarator" || n.type === "VariableDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration" || n.type === "CallExpression")) n = n.parent;
  return n?.type === "Program";
}
