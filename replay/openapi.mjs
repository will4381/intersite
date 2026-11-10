// @ts-check
// An OpenAPI 3 document as contract evidence, so `intersite replay --mode contract --openapi <file>` lints the
// documented contract with no server and no traffic: one synthetic case per documented JSON answer, its shape built
// from the schema, and the request body built from the request schema.
import { shapeOf } from "../shared/shape.mjs";

const METHODS = ["get", "put", "post", "patch", "delete"];
const DEPTH = 12;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The object a local `$ref` (`#/components/schemas/Order`) points at, or undefined.
 * @param {Record<string, any>} doc @param {string} ref
 */
function resolve(doc, ref) {
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).reduce((/** @type {any} */ node, part) => node?.[part], doc);
}

/** The JSON schema of a request body or response, following `$ref`s. @param {Record<string, any>} doc @param {unknown} node */
function jsonSchema(doc, node) {
  const target = isObject(node) && typeof node.$ref === "string" ? resolve(doc, node.$ref) : node;
  if (!isObject(target) || !isObject(target.content)) return undefined;
  const type = Object.keys(target.content).find((name) => /json/.test(name));
  return type ? target.content[type].schema : undefined;
}

/**
 * A JSON value of the schema's form: every property present, one element per array, the first non-null type of a
 * union, the first variant of a oneOf or anyOf. A `$ref` already being expanded on this branch stops the recursion.
 * @param {Record<string, any>} doc @param {unknown} schema @param {string[]} refs
 * @returns {unknown}
 */
function example(doc, schema, refs = []) {
  if (!isObject(schema) || refs.length > DEPTH) return null;
  if (typeof schema.$ref === "string") return refs.includes(schema.$ref) ? null : example(doc, resolve(doc, schema.$ref), [...refs, schema.$ref]);
  if (Array.isArray(schema.allOf)) return Object.assign({}, ...schema.allOf.map((part) => example(doc, part, refs)).filter(isObject));
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants)) return example(doc, variants.find((variant) => variant?.type !== "null") ?? variants[0], refs);
  const type = Array.isArray(schema.type) ? schema.type.find((name) => name !== "null") : schema.type;
  if (type === "object" || isObject(schema.properties)) {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, property]) => [key, example(doc, property, refs)]));
  }
  if (type === "array") return [example(doc, schema.items, refs)];
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "string") return schema.format === "date-time" ? "2026-01-31T09:30:00Z" : "text";
  return null;
}

/**
 * One piece of contract evidence per documented JSON answer of every operation. The case ID names the operation and
 * status. An operation with `security: []` is answered to signed-out callers.
 * @param {Record<string, any>} doc
 * @returns {import("./contract.mjs").Evidence[]}
 */
export function openapiEvidence(doc) {
  if (!isObject(doc.paths)) throw new Error("not an OpenAPI document: it has no paths");
  return Object.entries(doc.paths).flatMap(([path, item]) => METHODS.filter((method) => isObject(item?.[method])).flatMap((method) => {
    const operation = item[method];
    const route = path.replace(/\{([^}]+)\}/g, ":$1");
    const requestSchema = jsonSchema(doc, operation.requestBody);
    const body = requestSchema === undefined ? undefined : example(doc, requestSchema);
    return Object.entries(operation.responses ?? {}).filter(([status]) => /^\d{3}$/.test(status)).flatMap(([status, response]) => {
      const schema = jsonSchema(doc, response);
      if (schema === undefined) return [];
      const actor = Array.isArray(operation.security) && !operation.security.length ? "anonymous" : "member";
      return [{ caseId: `${method.toUpperCase()}:${path}:${status}`, method: method.toUpperCase(), route, path: route, actor, body, status: Number(status), shape: shapeOf(example(doc, schema)) }];
    });
  }));
}
