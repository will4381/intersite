// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isScriptFile, walk } from "../shared.mjs";

/** Names a pattern binds (`id`, `{ id, org: { slug } }`, `[first]`, `...rest`, `x = 1`). @param {any} pattern @param {Set<string>} into */
function bind(pattern, into) {
  walk(pattern, (n, parent) => {
    if (n.type === "AssignmentPattern") {
      bind(n.left, into); // The default value is read, not bound.
      return false;
    }
    if (n.type === "Identifier" && !(parent?.type === "Property" && parent.key === n && !parent.shorthand)) into.add(n.name);
    if (n.type.startsWith("TS")) return false;
  });
}

/** Every identifier name under `node`. @param {any} node */
function namesIn(node) {
  const names = new Set();
  walk(node, (n) => void (n.type === "Identifier" && names.add(n.name)));
  return names;
}

/**
 * What the functions around `node` declare: parameter names, and for each top-level `const`, the names it binds and the
 * names its value reads (`const { from, to } = params`, `const key = { page, q }`).
 * @param {any} node
 */
function enclosingScope(node) {
  const params = new Set();
  /** @type {[Set<string>, Set<string>][]} */
  const decls = [];
  for (let n = node.parent; n; n = n.parent) {
    if (!n.type.endsWith("FunctionExpression") && n.type !== "FunctionDeclaration") continue;
    for (const p of n.params) bind(p, params);
    for (const s of n.body.type === "BlockStatement" ? n.body.body : []) {
      if (s.type !== "VariableDeclaration") continue;
      for (const d of s.declarations) {
        const bound = new Set();
        bind(d.id, bound);
        decls.push([bound, d.init ? namesIn(d.init) : new Set()]);
      }
    }
  }
  return { params, decls };
}

/**
 * Names the key covers: those it names, and through local declarations, the names they were computed from (`key` covers
 * `page` after `const key = { page }`) and the names computed from them (`params` covers `from` after `const { from } = params`).
 * @param {Set<string>} covered @param {[Set<string>, Set<string>][]} decls
 */
function cover(covered, decls) {
  for (let grew = true; grew; ) {
    grew = false;
    for (const [bound, reads] of decls) {
      const linked = [...bound].some((x) => covered.has(x)) || [...reads].some((x) => covered.has(x));
      for (const x of linked ? [...bound, ...reads] : []) if (!covered.has(x)) grew = covered.add(x) !== undefined;
    }
  }
  return covered;
}

/**
 * Identifiers a function reads as values: not property names, not the function called (`fetchTodo` in `fetchTodo(id)`),
 * not the client a method is called on (`api` in `api.get(id)`), not its own locals.
 * @param {any} fn
 */
function readValues(fn) {
  const own = new Set();
  for (const p of fn.params) bind(p, own);
  const reads = new Map();
  const callees = new Set();
  walk(fn.body, (n, parent) => {
    if (n.type === "VariableDeclarator") bind(n.id, own);
    if (n.type.endsWith("FunctionExpression")) for (const p of n.params) bind(p, own);
    if (n.type === "CallExpression") callees.add(n.callee.type === "MemberExpression" ? n.callee.object : n.callee);
    if (n.type !== "Identifier" || !parent || callees.has(n)) return;
    if (parent.type === "MemberExpression" && parent.property === n && !parent.computed) return;
    if (parent.type === "Property" && parent.key === n && !parent.shorthand) return;
    if (!reads.has(n.name)) reads.set(n.name, n);
  });
  for (const name of own) reads.delete(name);
  return reads;
}

/** Hook results and auth values that select a client or credentials, not which data comes back. */
const NOT_DATA = /^(signal|queryClient|client|api|trpc|orpc|navigate|router|t|i18n)$|token|auth|session|headers|fetcher|config/i;

export const id = "query-key-missing-dep";
export const pack = "query";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      missing: "The queryFn reads `{{name}}` but the queryKey does not include it, so when `{{name}}` changes the cache still returns the data fetched for the old value and nothing refetches. Add `{{name}}` to the queryKey.",
    },
  },
  createOnce(context) {
    return {
      // Tests build throwaway clients with unique keys.
      before() {
        return !isScriptFile(context);
      },
      // `{ queryKey: [...], queryFn: () => … }` in useQuery, useSuspenseQuery, queryOptions, prefetchQuery, ensureQueryData.
      ObjectExpression(node) {
        const props = /** @type {any[]} */ (node.properties);
        const key = props.find((p) => p.type === "Property" && p.key?.name === "queryKey")?.value;
        const fn = props.find((p) => p.type === "Property" && p.key?.name === "queryFn")?.value;
        if (!key || !fn?.type.endsWith("FunctionExpression")) return;
        const { params, decls } = enclosingScope(node);
        // A key passed in whole (`queryKey` as a parameter) is the caller's to get right.
        if (key.type === "Identifier" && params.has(key.name)) return;
        const covered = cover(namesIn(key), decls);
        const local = new Set([...params, ...decls.flatMap(([bound]) => [...bound])]);
        for (const [name, n] of readValues(fn)) {
          if (local.has(name) && !covered.has(name) && !NOT_DATA.test(name)) context.report({ node: n, messageId: "missing", data: { name } });
        }
      },
    };
  },
});

export const ext = "tsx";

export const bad = [
  "export function Todo({ id }: { id: string }) {\n  const { data } = useQuery({ queryKey: ['todo'], queryFn: () => fetchTodo(id) });\n  return <p>{data?.title}</p>;\n}",
  "export const todoOptions = (todoId: string, status: string) =>\n  queryOptions({ queryKey: ['todos', todoId], queryFn: () => api.todos(todoId, { status }) });",
  "export function useOrders(page: number) {\n  const org = useOrg();\n  return useQuery({ queryKey: ['orders', page], queryFn: async () => (await fetch(`/api/${org.slug}/orders?page=${page}`)).json() });\n}",
];

export const good = [
  "export function Todo({ id }: { id: string }) {\n  const { data } = useQuery({ queryKey: ['todo', id], queryFn: () => fetchTodo(id) });\n  return <p>{data?.title}</p>;\n}",
  "export const todoOptions = (todoId: string) =>\n  queryOptions({ queryKey: todoKeys.detail(todoId), queryFn: ({ signal }) => api.todo(todoId, { signal }) });",
  "export function useMe() {\n  const api = useApi();\n  const { getToken } = useAuth();\n  return useQuery({ queryKey: ['me'], queryFn: async () => api.me({ token: await getToken() }) });\n}",
  "const LIMIT = 20;\nexport function useFeed() {\n  return useQuery({ queryKey: ['feed'], queryFn: () => loadFeed(LIMIT) });\n}",
  "export function useReport(params: Params) {\n  const { from, to } = params;\n  return useQuery({ queryKey: reportKeys.detail(params), queryFn: () => getReport(from, to) });\n}",
  "export function useList({ status, q }: Filters) {\n  const key = { status, q };\n  return useQuery({ queryKey: listKeys.list(key), queryFn: () => list({ status, q }) });\n}",
  "export function useInfinite({ queryKey, fetchPage, pageSize }: Options) {\n  return useInfiniteQuery({ queryKey, queryFn: ({ pageParam }) => fetchPage(pageParam, pageSize), initialPageParam: 1, getNextPageParam: () => undefined });\n}",
  "export function useUser(user: { id: string }) {\n  return useQuery({ queryKey: ['user', user.id], queryFn: () => getUser(user.id) });\n}",
];
