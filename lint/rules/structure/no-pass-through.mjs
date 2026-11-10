// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

/** The call or `new` a function body only returns, under `await`. @param {any} body */
function onlyCall(body) {
  let value = body;
  if (body.type === "BlockStatement") {
    if (body.body.length !== 1 || body.body[0].type !== "ReturnStatement") return undefined;
    value = body.body[0].argument;
  }
  if (value?.type === "AwaitExpression") value = value.argument;
  return value?.type === "CallExpression" || value?.type === "NewExpression" ? value : undefined;
}

/** A parameter's name, `...rest` included, or undefined for a pattern or a default. @param {any} p */
const paramName = (p) => (p.type === "Identifier" ? p.name : p.type === "RestElement" && p.argument.type === "Identifier" ? `...${p.argument.name}` : undefined);
/** @param {any} a */
const argName = (a) => (a.type === "Identifier" ? a.name : a.type === "SpreadElement" && a.argument.type === "Identifier" ? `...${a.argument.name}` : undefined);

/** The name a function is declared under: `function load`, `const load = () => ...`. Callbacks and methods have none. @param {any} node */
function declaredName(node) {
  if (node.type === "FunctionDeclaration") return node.id?.name;
  if (node.parent.type === "VariableDeclarator" && node.parent.init === node && node.parent.id.type === "Identifier") return node.parent.id.name;
  return undefined;
}

export const id = "no-pass-through";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      through: "{{name}} only calls {{callee}} with the same arguments in the same order, so it is a second name for {{callee}} that every reader has to look through. Call {{callee}} directly, or give this function work of its own.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      const name = declaredName(node);
      // A type parameter or return type can make a wrapper narrow a loose API, which is work of its own.
      if (!name || !node.params.length || node.typeParameters || node.returnType) return;
      const call = onlyCall(node.body);
      // A plain function name only: (value) => pattern.test(value) binds a receiver, which is work of its own.
      if (!call || call.callee.type !== "Identifier" || call.typeArguments) return;
      const params = node.params.map(paramName);
      const args = call.arguments.map(argName);
      if (params.includes(undefined) || params.length !== args.length || params.some((p, i) => p !== args[i])) return;
      const callee = call.callee.name;
      // A function that calls itself under the same name, or a hook renamed for a component, is not a pass-through.
      if (callee === name) return;
      context.report({ node: node.type === "FunctionDeclaration" ? node.id : node.parent.id, messageId: "through", data: { name, callee: call.type === "NewExpression" ? `new ${callee}` : callee } });
    }
    return {
      // Tests keep short local names for constructors, such as const day = (iso) => new Date(iso).
      before: () => !isTestFile(context),
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});

export const bad = [
  "import { fetchUser } from './api';\nexport async function getUser(id) { return await fetchUser(id); }",
  "export const formatDate = (date, locale) => format(date, locale);",
  "export function createClient(options) { return new HttpClient(options); }",
  "export const track = (...args) => send(...args);",
];

export const good = [
  "export const formatDate = (date) => format(date, 'yyyy-MM-dd');",
  "export function getUser(id) { return fetchUser(id, { cache: true }); }",
  "export function readJson<T>(path: string) { return parse<T>(path); }",
  "export function total(items: Item[]): Cents { return sum(items); }",
  "export class Store { get(key) { return this.map.get(key); } }",
  "export const isEmail = (value) => EMAIL.test(value);",
  "items.forEach((item) => save(item));",
  "export function sort(list, by) { return [...list].sort(by); }",
];
