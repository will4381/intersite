// @ts-check
// The API contract lint: what the API's requests carry and what it answers, read across every route for inconsistency
// and bad shapes. Nothing is configured: a convention is what a clear majority of enough routes or fields already do
// (as in gates/naming.mjs), and a route that departs from it is a finding. Checks that need no convention (a stack
// trace in an error, a password hash in an answer) report on their own. Findings are per route, not per case.
import { restyle, styleOf } from "../gates/naming.mjs";
import { UI_METHOD } from "../shared/case.mjs";
import { shapeOf } from "../shared/shape.mjs";

/** @typedef {import("../shared/shape.mjs").Shape} Shape */
/**
 * What the local server answered one replayed case in this run. `sent`: the credential header values the request
 * carried, to catch an answer that echoes one.
 * @typedef {{ status: number, json: unknown, text: string, contentType: string, sent: string[] }} Live
 */
/**
 * One case as evidence: the recorded, scrubbed request, the production answer's status and shape, and the live
 * answer when the case was replayed in this run.
 * @typedef {{ caseId: string, method: string, route: string, path: string, actor: string, body: unknown, status: number, shape: Shape, live?: Live }} Evidence
 */
/** @typedef {"casing" | "types" | "envelope" | "errors" | "status" | "values" | "exposure" | "size" | "requests" | "routes"} Check */
/**
 * `detail`: the kinds a field is typed as, for a group's examples. `group`: the parent pointer of the findings it was
 * grouped with (see groupFindings).
 * @typedef {{ check: Check, method: string, route: string, pointer: string, message: string, caseId: string, detail?: string, group?: string }} Finding
 */
/** @typedef {{ route: string, pointer?: string, check?: string, why: string }} Ignore */
/** @typedef {{ caseId: string, status: number, shape: Shape, live: Live | undefined }} Answer */
/** @typedef {{ key: string, method: string, route: string, cases: Evidence[], answers: Answer[], ok: Answer[] }} Route */
/** @typedef {{ routes: Route[], pattern: RegExp, add: (route: Route, check: Check, pointer: string, caseId: string, message: string) => Finding }} Api */

// ponytail: thresholds borrowed from gates/naming.mjs (tuned on 22 repositories), not yet tuned on recorded traffic.
const MIN_AGREE = 5;
const SHARE = 0.9;
const SHOWN = 3;
// Findings of one kind under one object, this many or more, print as one line: one root cause, not dozens of lines.
const GROUP = 3;
/** How a group of findings is described, per check. */
const GROUP_PHRASE = { types: "are typed two ways across answers", requests: "arrive in two forms across cases" };
const STYLE_NAME = { kebab: "kebab-case", snake: "snake_case", camel: "camelCase", Pascal: "PascalCase" };
// Routes that receive or relay another party's payload, whose keys follow that party's casing.
const FOREIGN_ROUTE = /(?:^|\/)(?:webhooks?|callbacks?|hooks)(?:\/|$)/;
// Keys whose type is part of what they mean, so one name typed two ways across routes is the same field drifting.
const TYPED_KEY = /^(?:id|uuid|total|count|amount|price|quantity|cost|balance|subtotal|tax|fee)$|[a-z0-9](?:Id|_id|ID|Count|_count|Total|_total|Amount|_amount|Price|_price|Cents|_cents)$/;
const DATE_KEY = /[a-z0-9](?:At|_at|Date|_date)$|^(?:date|timestamp)$/;
// Named like a date but a flag or a count: `is_vaccinations_up_to_date`, `requires_onset_date`.
const FLAG_KEY = /^(?:is|has|requires|can|should|needs?)(?:_|[A-Z])|up_?to_?date/i;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
// The keys of a body that is only an error report; a record with an `error` field (an ad's delivery error) is not one.
const ERROR_BODY = /^(?:error|errors|message|code|details?|status|statusCode|success|ok|requestId|request_id|traceId)$/;
const NONSENSE = new Set(["null", "undefined", "NaN", "Infinity", "-Infinity", "[object Object]", "Invalid Date"]);
const FLOAT_NOISE = /\.\d*?(?:0{6,}|9{6,})\d{1,3}$/;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {Shape} shape */
const kindOf = (shape) => (Array.isArray(shape) ? "array" : isObject(shape) ? "object" : /** @type {string} */ (shape));
/** @param {string} kind */
const article = (kind) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
/** @param {number} status */
const success = (status) => status >= 200 && status < 300;
/** @param {string[]} list */
const some = (list) => list.slice(0, SHOWN).join(", ") + (list.length > SHOWN ? ` and ${list.length - SHOWN} more` : "");

/**
 * The value a clear majority of enough votes share: at least MIN_AGREE of them and SHARE of all.
 * @template T @param {Iterable<T>} votes
 * @returns {{ value: T, agree: number, total: number } | undefined}
 */
export function majority(votes) {
  const list = [...votes];
  /** @type {Map<T, number>} */
  const counts = new Map();
  for (const vote of list) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  for (const [value, agree] of counts) if (agree >= MIN_AGREE && agree >= SHARE * list.length) return { value, agree, total: list.length };
  return undefined;
}

/**
 * Every object in a shape with its pointer (array elements are `*`) and its keys' shapes.
 * @param {Shape} shape @param {string} [pointer] @param {{ pointer: string, fields: Record<string, Shape> }[]} [out]
 */
function objectsOf(shape, pointer = "", out = []) {
  if (Array.isArray(shape)) for (const element of shape) objectsOf(element, `${pointer}/*`, out);
  else if (isObject(shape)) {
    out.push({ pointer, fields: shape });
    for (const [key, value] of Object.entries(shape)) objectsOf(value, `${pointer}/${key}`, out);
  }
  return out;
}

/** Every key in a shape: its pointer, name, shape, and the object it sits in. @param {Shape} shape */
const fieldsOf = (shape) => objectsOf(shape).flatMap((object) => Object.keys(object.fields).map((key) => ({
  pointer: `${object.pointer}/${key}`, parent: object.pointer, key, shape: object.fields[key], siblings: object.fields,
})));

/**
 * Every leaf of a JSON value with its pointer (array elements are `*`) and key.
 * @param {unknown} value @param {string} [pointer] @param {string} [key] @param {{ pointer: string, key: string, value: unknown }[]} [out]
 */
function leavesOf(value, pointer = "", key = "", out = []) {
  if (Array.isArray(value)) value.forEach((item) => leavesOf(item, `${pointer}/*`, key, out));
  else if (isObject(value)) for (const [name, item] of Object.entries(value)) leavesOf(item, `${pointer}/${name}`, name, out);
  else out.push({ pointer, key, value });
  return out;
}

/** The request body shapes of a route's cases. @param {Route} route */
const requestShapes = (route) => route.cases.filter((item) => item.body !== undefined && item.body !== null).map((item) => ({ caseId: item.caseId, shape: shapeOf(item.body) }));

/** The evidence grouped by method and route template, cases ordered by ID so the case a finding names is stable. @param {Evidence[]} evidence */
function routesOf(evidence) {
  /** @type {Map<string, Route>} */
  const routes = new Map();
  for (const item of [...evidence].sort((a, b) => (a.caseId < b.caseId ? -1 : Number(a.caseId > b.caseId)))) {
    const key = `${item.method} ${item.route}`;
    const route = routes.get(key) ?? { key, method: item.method, route: item.route, cases: [], answers: [], ok: [] };
    routes.set(key, route);
    route.cases.push(item);
    route.answers.push({ caseId: item.caseId, status: item.status, shape: item.shape, live: undefined });
    if (item.live && item.live.status !== 0) route.answers.push({ caseId: item.caseId, status: item.live.status, shape: shapeOf(item.live.json), live: item.live });
  }
  for (const route of routes.values()) route.ok = route.answers.filter((answer) => success(answer.status));
  return [...routes.values()];
}

/**
 * The contract findings over every case of the sampled sessions. `ignore` holds `replay.contractIgnore`.
 * @param {Evidence[]} evidence @param {{ idPattern: string, ignore?: Ignore[] }} options
 * @returns {Finding[]}
 */
export function lintContract(evidence, { idPattern, ignore = [] }) {
  /** @type {Map<string, Finding>} */
  const found = new Map();
  /** @type {Api} */
  const api = {
    routes: routesOf(evidence),
    pattern: new RegExp(idPattern),
    add(route, check, pointer, caseId, message) {
      const key = `${check}\0${route.key}\0${pointer}`;
      if (!found.has(key)) found.set(key, { check, method: route.method, route: route.route, pointer, message, caseId });
      return /** @type {Finding} */ (found.get(key));
    },
  };
  for (const side of /** @type {const} */ (["response", "request"])) {
    casing(api, side);
    types(api, side);
  }
  for (const check of [typesAcrossRoutes, envelope, lists, errors, statusAndBody, values, absence, exposure, repeated, requests, routeNames]) check(api);
  const visible = [...found.values()].filter((finding) => !ignore.some((entry) => ignores(entry, finding)));
  groupFindings(visible);
  // An entry on a group's parent pointer silences the whole group.
  return visible.filter((finding) => finding.group === undefined || !ignore.some((entry) => ignores(entry, { ...finding, pointer: finding.group })));
}

/** What a finding says to do: the text after its last `: `. @param {string} message */
const remedyOf = (message) => message.slice(message.lastIndexOf(": ") + 2);
/** The pointer of the object holding a field: `/a/b` -> `/a`, `/a` -> `` (the answer itself). @param {string} pointer */
const parentOf = (pointer) => pointer.slice(0, Math.max(pointer.lastIndexOf("/"), 0));

/**
 * Sets `group` on findings that share a check, a route, a remedy and a parent object, when there are at least GROUP of
 * them: one cause (a metrics object whose values are strings in some answers) is one line. Sibling groups under one
 * object (`/metrics/tiktok/*` and `/metrics/meta/*`) become one group under it, but never one for the whole answer.
 * @param {Finding[]} findings
 */
function groupFindings(findings) {
  /** @type {Map<string, Map<string, Finding[]>>} check, route and remedy -> parent pointer -> findings */
  const kinds = new Map();
  for (const finding of findings.filter((item) => item.pointer.length > 1)) {
    const kind = `${finding.check}\0${finding.method} ${finding.route}\0${remedyOf(finding.message)}`;
    const parents = kinds.get(kind) ?? new Map();
    kinds.set(kind, parents);
    const parent = parentOf(finding.pointer);
    parents.set(parent, [...(parents.get(parent) ?? []), finding]);
  }
  for (const parents of kinds.values()) {
    lift(parents);
    for (const [parent, list] of parents) if (list.length >= GROUP) for (const finding of list) finding.group = parent || "/";
  }
}

/** Merges sibling groups (two or more findings each) into their parent object, repeatedly, below the answer's root. @param {Map<string, Finding[]>} parents */
function lift(parents) {
  for (let changed = true; changed;) {
    changed = false;
    const ups = Map.groupBy([...parents].filter(([parent, list]) => list.length >= 2 && parentOf(parent) !== ""), ([parent]) => parentOf(parent));
    for (const [up, entries] of ups) {
      if (entries.length < 2) continue;
      parents.set(up, [...(parents.get(up) ?? []), ...entries.flatMap(([, list]) => list)]);
      for (const [parent] of entries) parents.delete(parent);
      changed = true;
    }
  }
}

/**
 * The findings as they print: each group as one finding on its parent pointer, naming how many fields and a few
 * examples; every other finding as it is.
 * @param {Finding[]} findings @returns {Finding[]}
 */
export function printable(findings) {
  const keyOf = (/** @type {Finding} */ finding) => `${finding.check}\0${finding.method} ${finding.route}\0${finding.group}\0${remedyOf(finding.message)}`;
  const groups = Map.groupBy(findings.filter((finding) => finding.group !== undefined), keyOf);
  return findings.flatMap((finding) => {
    const list = finding.group === undefined ? undefined : groups.get(keyOf(finding));
    if (!list) return [finding];
    if (list[0] !== finding) return [];
    const examples = list.slice(0, SHOWN).map((item) => (item.detail ? `${item.pointer} (${item.detail})` : item.pointer)).join(", ");
    const phrase = GROUP_PHRASE[/** @type {keyof typeof GROUP_PHRASE} */ (finding.check)] ?? `have the same ${finding.check} finding`;
    return [{ ...finding, pointer: /** @type {string} */ (finding.group), message: `${finding.group}: ${list.length} fields under it ${phrase}, for example ${examples}: ${remedyOf(finding.message)}` }];
  });
}

/** @param {Ignore} entry @param {Finding} finding */
function ignores(entry, finding) {
  return (entry.route === `${finding.method} ${finding.route}` || entry.route === finding.route)
    && (entry.pointer === undefined || entry.pointer === finding.pointer) && (entry.check === undefined || entry.check === finding.check);
}

/**
 * Keys cased against the API's dominant style, one finding per route. Keys of a nested object written wholly in
 * another style, in a route whose other keys follow the API, are a third party's object passed through and left alone.
 * With no dominant style, an object mixing styles is the finding.
 * @param {Api} api @param {"response" | "request"} side
 */
function casing(api, side) {
  const fields = api.routes.filter((route) => !FOREIGN_ROUTE.test(route.route)).flatMap((route) =>
    (side === "request" ? requestShapes(route) : route.answers).flatMap(({ caseId, shape }) => fieldsOf(shape).map((field) => ({ ...field, route, caseId, style: styleOf(field.key) }))))
    .filter((field) => field.style && field.style !== "word" && !api.pattern.test(field.key));
  const rule = majority(new Map(fields.map((field) => [`${field.route.key}\0${field.pointer}`, field.style])).values());
  if (!rule) return mixedCasing(api, fields, side);
  const style = /** @type {keyof typeof STYLE_NAME} */ (rule.value);
  const followed = new Set(fields.filter((field) => field.style === style).map((field) => field.route));
  /** @type {Map<Route, typeof fields>} */
  const off = new Map();
  for (const field of fields) {
    const keys = Object.keys(field.siblings).filter((key) => /[-_A-Z]/.test(key.slice(1)));
    const passedThrough = field.parent !== "" && ((followed.has(field.route) && keys.length > 1 && !keys.some((key) => styleOf(key) === style)) || dictionary(field.siblings));
    const list = off.get(field.route) ?? [];
    if (field.style === style || passedThrough || list.some((other) => other.pointer === field.pointer)) continue;
    off.set(field.route, [...list, field]);
  }
  const where = side === "request" ? "request " : "";
  for (const [route, list] of off) {
    const what = list.length === 1 ? `${list[0].pointer} is ${STYLE_NAME[/** @type {keyof typeof STYLE_NAME} */ (list[0].style)]}` : `${some(list.map((field) => field.pointer))} are not ${STYLE_NAME[style]}`;
    api.add(route, "casing", list[0].pointer, list[0].caseId, `${where}${what}; ${rule.agree} of ${rule.total} ${side} fields in this API are ${STYLE_NAME[style]}: `
      + `rename ${list.length === 1 ? "it" : "them"} ${some(list.map((field) => restyle(field.key, style)))}`);
  }
}

/**
 * An object keyed by data rather than by field names (`{ good: 3, needs_work: 1, strong: 9 }`, a permission map): at
 * least three keys, no `id`, and values that all have one shape other than a string (a record of strings is common).
 * Its keys are values, so their casing is not the API's to choose.
 * @param {Record<string, Shape>} object
 */
function dictionary(object) {
  const shapes = Object.values(object).map((shape) => JSON.stringify(shape));
  return shapes.length >= 3 && !("id" in object) && shapes[0] !== '"string"' && shapes.every((shape) => shape === shapes[0]);
}

/**
 * With no API-wide style: one object holding both camelCase and snake_case keys.
 * @param {Api} api @param {{ route: Route, parent: string, key: string, style: string | undefined, caseId: string }[]} fields @param {"response" | "request"} side
 */
function mixedCasing(api, fields, side) {
  /** @type {Map<string, Map<string, string>>} route and object -> style -> first key */
  const objects = new Map();
  for (const field of fields) {
    const id = `${field.route.key}\0${field.parent}`;
    const styles = objects.get(id) ?? new Map();
    objects.set(id, styles);
    if (!styles.has(field.style ?? "")) styles.set(field.style ?? "", field.key);
    if (styles.size !== 2) continue;
    const [[a, first], [b, second]] = styles;
    const name = (/** @type {string} */ style) => STYLE_NAME[/** @type {keyof typeof STYLE_NAME} */ (style)];
    api.add(field.route, "casing", field.parent || "/", field.caseId, `${side === "request" ? "request " : ""}${field.parent || "/"} mixes ${name(a)} (${first}) and ${name(b)} (${second}) in one object: write every key in one style`);
  }
}

/**
 * The same key at the same pointer of one route answered (or sent) with different types across cases, beyond null.
 * @param {Api} api @param {"response" | "request"} side
 */
function types(api, side) {
  for (const route of api.routes) {
    /** @type {Map<string, Map<string, Set<string>>>} pointer -> kind -> case IDs */
    const kinds = new Map();
    // A list whose rows type one field differently within a single answer (a field definition's `default`) is a union
    // by design, not drift between cases.
    /** @type {Set<string>} */
    const unions = new Set();
    for (const { caseId, shape } of side === "request" ? requestShapes(route) : route.ok) {
      /** @type {Map<string, string>} */
      const here = new Map();
      for (const field of fieldsOf(shape).filter((item) => kindOf(item.shape) !== "null")) {
        if (here.has(field.pointer) && here.get(field.pointer) !== kindOf(field.shape)) unions.add(field.pointer);
        here.set(field.pointer, kindOf(field.shape));
        const seen = kinds.get(field.pointer) ?? new Map();
        kinds.set(field.pointer, seen.set(kindOf(field.shape), (seen.get(kindOf(field.shape)) ?? new Set()).add(caseId)));
      }
    }
    for (const [pointer, seen] of kinds) {
      if (seen.size < 2 || unions.has(pointer)) continue;
      const [top, ...rest] = [...seen].sort((a, b) => b[1].size - a[1].size);
      const [kind, cases] = rest[0];
      const total = [...seen.values()].reduce((sum, ids) => sum + ids.size, 0);
      const where = side === "request" ? `request ${pointer} arrives as` : `${pointer} is`;
      const finding = api.add(route, side === "request" ? "requests" : "types", pointer, [...cases][0],
        `${where} ${article(kind)} here; ${top[1].size} of ${total} cases of this route have ${article(top[0])}: ${side === "request" ? "clients disagree; accept" : "answer"} one type every time`);
      finding.detail ??= `${kind}, ${top[0]}`;
    }
  }
}

/**
 * An ID, count or money key typed differently across routes (`id` a string in most routes, a number in one; other
 * names, such as `email` or `version`, mean different things in different places), and date fields that
 * are numbers where the API's other date fields are strings.
 * @param {Api} api
 */
function typesAcrossRoutes(api) {
  /** @type {Map<string, Map<Route, { kinds: Set<string>, pointer: string, caseId: string }>>} key -> route -> what it answers */
  const byKey = new Map();
  /** @type {Map<string, { route: Route, pointer: string, kind: string, caseId: string }>} date fields by route and pointer */
  const dates = new Map();
  for (const route of api.routes) {
    for (const { caseId, shape } of route.ok) {
      for (const field of fieldsOf(shape).filter((item) => ["string", "number", "boolean"].includes(kindOf(item.shape)))) {
        const routes = byKey.get(field.key) ?? new Map();
        if (TYPED_KEY.test(field.key)) byKey.set(field.key, routes);
        const entry = routes.get(route) ?? { kinds: new Set(), pointer: field.pointer, caseId };
        routes.set(route, entry);
        entry.kinds.add(kindOf(field.shape));
        if (DATE_KEY.test(field.key) && !FLAG_KEY.test(field.key) && kindOf(field.shape) !== "boolean") dates.set(`${route.key}\0${field.pointer}`, { route, pointer: field.pointer, kind: kindOf(field.shape), caseId });
      }
    }
  }
  for (const [key, routes] of byKey) {
    const single = [...routes].filter(([, entry]) => entry.kinds.size === 1).map(([route, entry]) => ({ route, ...entry, kind: [...entry.kinds][0] }));
    const rule = majority(single.map((entry) => entry.kind));
    for (const entry of rule ? single.filter((item) => item.kind !== rule.value) : []) {
      api.add(entry.route, "types", entry.pointer, entry.caseId, `${entry.pointer} is ${article(entry.kind)}; ${rule?.agree} of ${rule?.total} routes answer ${key} as ${article(String(rule?.value))}: answer ${article(String(rule?.value))}`);
    }
  }
  const rule = majority([...dates.values()].map((entry) => entry.kind));
  for (const entry of rule ? [...dates.values()].filter((item) => item.kind !== rule.value) : []) {
    api.add(entry.route, "types", entry.pointer, entry.caseId, `${entry.pointer} is ${article(entry.kind)}; ${rule?.agree} of ${rule?.total} date fields in this API are ${rule?.value}s: answer ${rule?.value === "string" ? "an ISO 8601 string" : "the same form"}`);
  }
}

/** The first successful answer with a body, per route. @param {Api} api */
const rootsOf = (api) => api.routes.flatMap((route) => {
  const answer = route.ok.find((item) => kindOf(item.shape) !== "null");
  return answer ? [{ route, answer }] : [];
});

/**
 * A top-level wrapper (`data`) most routes answer in and this one does not; or, where most routes answer bare, one
 * that wraps its answer.
 * @param {Api} api
 */
function envelope(api) {
  const roots = rootsOf(api);
  /** @param {Shape} shape */
  const wrappers = (shape) => (isObject(shape) ? Object.keys(shape).filter((key) => ["object", "array"].includes(kindOf(shape[key]))) : []);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const { answer } of roots) for (const key of wrappers(answer.shape)) counts.set(key, (counts.get(key) ?? 0) + 1);
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  const rule = best && majority(roots.map(({ answer }) => wrappers(answer.shape).includes(best[0])));
  if (rule?.value) {
    for (const { route, answer } of roots.filter((root) => !wrappers(root.answer.shape).includes(best[0]))) {
      api.add(route, "envelope", "/", answer.caseId, `answers without the top-level ${best[0]} that ${rule.agree} of ${rule.total} routes wrap their answer in: answer { ${best[0]}: … }`);
    }
    return;
  }
  for (const { route, answer } of roots) {
    const keys = isObject(answer.shape) ? Object.keys(answer.shape) : [];
    const bare = majority(roots.filter((root) => root.route !== route).map((root) => !isObject(root.answer.shape) || !(keys[0] in root.answer.shape)));
    if (keys.length === 1 && /^(?:data|result|payload|response|body)$/.test(keys[0]) && bare?.value) {
      api.add(route, "envelope", "/", answer.caseId, `wraps its answer in { ${keys[0]}: … }; ${bare.agree} of ${bare.total} other routes answer without it: answer the value itself`);
    }
  }
}

const PAGING = {
  total: /^(?:total|count|totalCount|total_count|totalItems|total_items|totalResults|total_results)$/,
  next: /^(?:next|nextCursor|next_cursor|cursor|nextPageToken|next_page_token|nextPage|next_page|nextLink|next_link|endCursor|end_cursor|page)$/,
  more: /^(?:hasMore|has_more|hasNextPage|has_next_page)$/,
};
const LIST_META = /^(?:meta|pagination|paging|page_?info|pageInfo|links)$/;

/**
 * How a GET on a collection (a plural last segment) answers: a bare array, or an object holding one list of rows and its paging keys.
 * Undefined when the answer is not a list. @param {Route} route @param {Shape} shape
 */
function listOf(route, shape) {
  if (route.method !== "GET" || !plural(route.route.split("/").at(-1) ?? "")) return undefined;
  if (Array.isArray(shape)) return { bare: true, items: "", paging: /** @type {string[]} */ ([]) };
  if (!isObject(shape)) return undefined;
  const arrays = Object.keys(shape).filter((key) => Array.isArray(shape[key]));
  const others = Object.keys(shape).filter((key) => !arrays.includes(key));
  if (arrays.length !== 1 || !(plural(arrays[0]) || /^(?:data|list)$/.test(arrays[0])) || others.some((key) => isObject(shape[key]) && !LIST_META.test(key))) return undefined;
  const keys = [...others, ...others.filter((key) => isObject(shape[key])).flatMap((key) => Object.keys(shape[key]))];
  return { bare: false, items: arrays[0], paging: keys.filter((key) => Object.values(PAGING).some((role) => role.test(key))) };
}

/**
 * List answers: a bare array where the API's lists are objects; another name for the rows or a paging key than the
 * API's; a list with no paging at all where the API's lists are paged.
 * @param {Api} api
 */
function lists(api) {
  const found = rootsOf(api).flatMap(({ route, answer }) => {
    const list = listOf(route, answer.shape);
    return list ? [{ route, caseId: answer.caseId, ...list }] : [];
  });
  const shape = majority(found.map((list) => list.bare));
  const wrapped = found.filter((list) => !list.bare);
  const items = majority(wrapped.map((list) => list.items));
  const paged = majority(wrapped.map((list) => list.paging.length > 0));
  for (const list of found) {
    if (shape?.value === false && list.bare) {
      api.add(list.route, "envelope", "/", list.caseId, `answers a bare array; ${shape.agree} of ${shape.total} list routes answer an object with the rows${items ? ` under ${items.value}` : ""} and paging: answer that object`);
    }
    if (items && !list.bare && list.items !== items.value) {
      api.add(list.route, "envelope", `/${list.items}`, list.caseId, `/${list.items} holds the rows; ${items.agree} of ${items.total} list routes call it ${items.value}: rename it ${items.value}`);
    }
    if (paged?.value && !list.bare && !list.paging.length) {
      api.add(list.route, "size", "/", list.caseId, `returns the whole list with no paging; ${paged.agree} of ${paged.total} list routes page theirs: add the API's paging keys`);
    }
  }
  for (const [role, pattern] of Object.entries(PAGING)) {
    const named = wrapped.flatMap((list) => list.paging.filter((key) => pattern.test(key)).slice(0, 1).map((key) => ({ ...list, key })));
    const rule = majority(named.map((list) => list.key));
    for (const list of rule ? named.filter((item) => item.key !== rule.value) : []) {
      api.add(list.route, "envelope", `/${list.key}`, list.caseId, `${list.key} is the ${role === "more" ? "has-more flag" : role === "next" ? "next-page cursor" : "total"}; ${rule.agree} of ${rule.total} list routes call it ${rule.value}: rename it ${rule.value}`);
    }
  }
}

/** The form of an error answer, as a reader would name it. @param {Answer} answer */
function errorForm({ shape, live }) {
  if (live?.text && !/json/.test(live.contentType)) return /html/.test(live.contentType) ? "HTML" : "plain text";
  if (live && /problem\+json/.test(live.contentType)) return "problem+json";
  if (!isObject(shape)) return kindOf(shape) === "null" ? "an empty body" : `a bare ${kindOf(shape)}`;
  if ("title" in shape && ("type" in shape || "detail" in shape)) return "problem+json";
  if ("error" in shape) return `{ error: ${kindOf(shape.error)} }`;
  if ("errors" in shape) return `{ errors: ${kindOf(shape.errors)} }`;
  if ("message" in shape) return "{ message }";
  return `{ ${Object.keys(shape).join(", ")} }`;
}

/**
 * The form of each route's error answers per status (a live answer wins), and the API's dominant one.
 * @param {Api} api
 */
function errorForms(api) {
  /** @type {Map<string, { route: Route, status: number, form: string, caseId: string }>} route and status -> form */
  const units = new Map();
  for (const route of api.routes) {
    for (const answer of route.answers.filter((item) => item.status >= 400)) {
      const unit = `${route.key}\0${answer.status}`;
      if (!units.has(unit) || answer.live) units.set(unit, { route, status: answer.status, form: errorForm(answer), caseId: answer.caseId });
    }
  }
  return { units, rule: majority([...units.values()].map((unit) => unit.form)) };
}

/** 4xx and 5xx answers in another form than the API's dominant error form. @param {Api} api */
function errors(api) {
  const { units, rule } = errorForms(api);
  for (const unit of rule ? [...units.values()].filter((item) => item.form !== rule.value) : []) {
    api.add(unit.route, "errors", "/", unit.caseId, `the ${unit.status} answer is ${unit.form}; ${rule?.agree} of ${rule?.total} error answers in this API are ${rule?.value}: answer in that form`);
  }
}

/**
 * Status and body disagreeing: a 2xx whose body says it failed, a create answered with another status than the API's
 * creates, a 200 with an empty body where the API answers JSON, JSON labelled as something else.
 * @param {Api} api
 */
function statusAndBody(api) {
  // A success answered in the API's own error form (problem+json, `{ error }`) is a failure with the wrong status.
  const own = errorForms(api).rule?.value;
  // A record with a `title` and a `type` is not a problem document: one carries its HTTP status as a number.
  const problem = (/** @type {Answer} */ { shape, live }) => /problem\+json/.test(live?.contentType ?? "") || (isObject(shape) && shape.status === "number" && shape.title === "string");
  const errorShaped = (/** @type {Answer} */ answer) => own !== undefined && errorForm(answer) === own
    && (own === "problem+json" ? problem(answer) : own.startsWith("{ error"));
  for (const route of api.routes) {
    for (const answer of route.ok) {
      const { caseId, status, shape, live } = answer;
      const json = live ? live.json : undefined;
      const failed = isObject(json) && (json.success === false || json.ok === false) ? `"${json.success === false ? "success" : "ok"}": false`
        : isObject(shape) && ["string", "object"].includes(kindOf(shape.error ?? "null")) && Object.keys(shape).every((key) => ERROR_BODY.test(key)) ? "an error"
        : errorShaped(answer) ? `a ${own} error` : undefined;
      if (failed) api.add(route, "status", "/", caseId, `answers ${status} with ${failed} in the body: answer a 4xx or 5xx status for a failure`);
    }
    for (const { caseId, live } of route.answers) {
      if (live?.text && live.json !== undefined && !/json/.test(live.contentType)) {
        api.add(route, "status", "/", caseId, `answers JSON labelled ${live.contentType ? `content-type: ${live.contentType}` : "with no content-type"}: send content-type: application/json`);
      }
    }
  }
  const creates = api.routes.filter((route) => route.method === "POST" && /\/[a-z][\w-]*s$/.test(route.route)).flatMap((route) => route.ok.slice(0, 1).map((answer) => ({ route, ...answer })))
    // 202 says the work was queued, not done: a different answer, not another way of saying created.
    .filter((answer) => answer.status !== 202);
  const created = majority(creates.map((answer) => answer.status));
  for (const answer of created ? creates.filter((item) => item.status !== created.value) : []) {
    api.add(answer.route, "status", "/", answer.caseId, `a create answers ${answer.status}; ${created?.agree} of ${created?.total} creates in this API answer ${created?.value}: answer ${created?.value}`);
  }
  const json = majority(api.routes.flatMap((route) => route.ok.slice(0, 1).map((answer) => kindOf(answer.shape) !== "null" || Boolean(answer.live?.text))));
  for (const route of json?.value ? api.routes : []) {
    const empty = route.ok.find((answer) => answer.status === 200 && answer.live?.text === "");
    if (empty) api.add(route, "status", "/", empty.caseId, `answers 200 with an empty body; ${json?.agree} of ${json?.total} routes answer with a body: answer 204, or the JSON the caller expects`);
  }
}

/** A string under a date key in a form that is not ISO 8601 (a locale or `Date.toString()` form). @param {string} key @param {unknown} value */
const localeDate = (key, value) => DATE_KEY.test(key) && typeof value === "string" && !ISO.test(value) && !Number.isNaN(Date.parse(value));

/**
 * Values in disguise in the live answers: a serialised `null`, `NaN` or `[object Object]`; float noise; booleans as
 * "true"/"false"; a date in a locale form.
 * @param {Api} api
 */
function values(api) {
  for (const route of api.routes) {
    /** @type {Map<string, { strings: Set<string>, caseId: string }>} pointer -> its string values */
    const strings = new Map();
    for (const { caseId, live } of route.ok) {
      for (const { pointer, key, value } of live ? leavesOf(live.json) : []) {
        if (typeof value === "string" && NONSENSE.has(value)) api.add(route, "values", pointer, caseId, `${pointer} is the string "${value}": a value was serialised by mistake; answer null or the real value`);
        if (typeof value === "number" && FLOAT_NOISE.test(String(value))) api.add(route, "values", pointer, caseId, `${pointer} carries binary float noise: round it before answering, and send money as integer minor units`);
        if (localeDate(key, value)) api.add(route, "values", pointer, caseId, `${pointer} is a date in a locale form: answer an ISO 8601 string (2026-01-31T09:30:00Z)`);
        if (typeof value === "string") strings.set(pointer, { strings: (strings.get(pointer)?.strings ?? new Set()).add(value), caseId: strings.get(pointer)?.caseId ?? caseId });
      }
    }
    for (const [pointer, { strings: seen, caseId }] of strings) {
      if ([...seen].every((value) => value === "true" || value === "false")) api.add(route, "values", pointer, caseId, `${pointer} is the string "${[...seen][0]}": answer a JSON boolean`);
    }
  }
}

/**
 * One field that is null in some answers and missing in others, a list that is null in some and an array in others,
 * or a string that is "" in some and null in others: the caller has to handle every form.
 * @param {Api} api
 */
function absence(api) {
  for (const route of api.routes) {
    /** @type {Map<string, { forms: Map<string, string>, parent: string }>} pointer -> form -> first case */
    const fields = new Map();
    /** @type {Map<string, { count: number, keys: Map<string, number> }>} object pointer -> instances and how many hold each key */
    const objects = new Map();
    const note = (/** @type {string} */ pointer, /** @type {string} */ form, /** @type {string} */ caseId) => {
      const entry = fields.get(pointer) ?? { forms: new Map(), parent: pointer.slice(0, pointer.lastIndexOf("/")) };
      fields.set(pointer, entry);
      if (!entry.forms.has(form)) entry.forms.set(form, caseId);
    };
    for (const { caseId, shape, live } of route.ok) {
      for (const object of objectsOf(shape)) {
        const entry = objects.get(object.pointer) ?? { count: 0, keys: new Map() };
        objects.set(object.pointer, { count: entry.count + 1, keys: entry.keys });
        for (const [key, value] of Object.entries(object.fields)) {
          entry.keys.set(key, (entry.keys.get(key) ?? 0) + 1);
          note(`${object.pointer}/${key}`, kindOf(value), caseId);
        }
      }
      for (const leaf of live ? leavesOf(live.json) : []) if (leaf.value === "") note(leaf.pointer, "empty", caseId);
    }
    for (const [pointer, { forms, parent }] of fields) {
      const object = objects.get(parent);
      const missing = object && (object.keys.get(pointer.slice(parent.length + 1)) ?? 0) < object.count;
      const form = forms.has("null") && (missing ? "missing in others" : forms.has("array") ? "a list in others" : forms.has("empty") ? `"" in others` : undefined);
      if (form) api.add(route, "values", pointer, /** @type {string} */ (forms.get("null")), `${pointer} is null in some answers and ${form}: answer one form when it is empty${forms.has("array") ? " ([])" : ""}`);
    }
  }
}

const PASSWORD_KEY = /^(?:password|passwd|passwordhash|passworddigest|hashedpassword|encryptedpassword|salt|passwordsalt|totpsecret|mfasecret|otpsecret|resettoken|passwordresettoken)$/;
// Shown once by the write that creates or rotates them (an OAuth client's secret, a Stripe client secret, a sign-in's
// token); a read that answers them again is the leak.
const CREDENTIAL_KEY = /^(?:clientsecret|apisecret|privatekey|secretkey|accesstoken|refreshtoken|sessiontoken|idtoken|authtoken|apikey|bearertoken)$/;
const AUTH_ROUTE = /(?:^|\/)(?:auth|oauth\d?|login|signin|sign-in|signup|sign-up|register|sessions?|tokens?|refresh|api-?keys)(?:\/|$)/;
/** @type {[string, RegExp][]} */
const LEAKS = [
  ["a stack trace", /(?:\\n|\n)\s*at [\w$.<>[\] ]+ \(|\bat (?:async )?[\w$.<>]+ \((?:file:\/\/)?\/[^)]*:\d+:\d+\)|Traceback \(most recent call last\)/],
  ["a server file path", /\/(?:home|Users|var|srv|app|opt|usr)\/[\w.@-]+\/[\w./@-]*\.(?:[cm]?[jt]sx?|py|rb|go|java|php)\b|node_modules\//],
  ["an SQL fragment", /\bSELECT\s[\s\S]{1,200}?\sFROM\s|\bINSERT\s+INTO\s|\bDELETE\s+FROM\s|syntax error at or near|violates (?:unique|foreign key|not-null) constraint|relation "[^"]+" does not exist|SQLITE_[A-Z]+/],
];

/** What a response key exposes that should not leave the server, or undefined. @param {Route} route @param {string} key @param {Record<string, Shape>} siblings */
function exposed(route, key, siblings) {
  const name = key.toLowerCase().replace(/[-_]/g, "");
  if (PASSWORD_KEY.test(name)) return "a password, hash or reset secret: never send it; drop it from the response";
  if (CREDENTIAL_KEY.test(name) && route.method === "GET" && !AUTH_ROUTE.test(route.route)) return "a credential, on a read: answer it only once, from the write that creates it";
  if (key === "__v") return "Mongoose's version key: drop it from the response (select or toJSON)";
  if (key === "_id" && "id" in siblings) return "the database _id beside id: answer id only";
  return undefined;
}

/**
 * Things that should not leave the server: secret-named keys, ORM artefacts, a soft-delete column to signed-out
 * callers; in the live answers, the request's own credentials echoed back, and a stack trace, file path or SQL in an error.
 * @param {Api} api
 */
function exposure(api) {
  for (const route of api.routes) {
    const anonymous = route.cases.every((item) => item.actor === "anonymous");
    for (const { caseId, shape } of route.answers) {
      for (const field of fieldsOf(shape).filter((item) => item.shape !== "null")) {
        const what = exposed(route, field.key, field.siblings) ?? (anonymous && /^deleted_?at$/i.test(field.key) ? "a soft-delete column, to signed-out callers: drop it from the response" : undefined);
        if (what) api.add(route, "exposure", field.pointer, caseId, `answers ${field.pointer}, ${what}`);
      }
    }
    for (const { caseId, status, live } of route.answers) {
      const secrets = (live?.sent ?? []).flatMap((value) => [value, ...value.split(/;\s*|\s+/).map((part) => part.slice(part.indexOf("=") + 1))]).filter((value) => value.length >= 8);
      // A sign-in or refresh route may hand back a token it issued; elsewhere an echoed credential is a leak.
      if (live && !AUTH_ROUTE.test(route.route) && secrets.some((secret) => live.text.includes(secret))) api.add(route, "exposure", "/", caseId, "the answer echoes the request's credentials: never send Authorization or cookie values back");
      const leak = status >= 400 ? LEAKS.find(([, pattern]) => pattern.test(live?.text ?? "")) : undefined;
      if (leak) api.add(route, "exposure", "/", caseId, `the ${status} answer carries ${leak[0]}: log it on the server and answer a plain message`);
    }
  }
}

/**
 * Every array of at least five objects in a JSON value, with its pointer.
 * @param {unknown} value @param {string} [pointer] @param {{ pointer: string, rows: Record<string, unknown>[] }[]} [out]
 */
function rowsOf(value, pointer = "", out = []) {
  if (Array.isArray(value)) {
    if (value.length >= 5 && value.every(isObject)) out.push({ pointer, rows: value });
    value.forEach((item) => rowsOf(item, `${pointer}/*`, out));
  } else if (isObject(value)) for (const [key, item] of Object.entries(value)) rowsOf(item, `${pointer}/${key}`, out);
  return out;
}

/** The same sizeable object repeated in every row of a live list answer. @param {Api} api */
function repeated(api) {
  for (const route of api.routes) {
    for (const { caseId, live } of route.ok) {
      for (const { pointer, rows } of live ? rowsOf(live.json) : []) {
        const same = Object.keys(rows[0]).filter((key) => isObject(rows[0][key]) && JSON.stringify(rows[0][key]).length >= 100
          && rows.every((row) => JSON.stringify(row[key]) === JSON.stringify(rows[0][key])));
        for (const key of same) api.add(route, "size", `${pointer}/*/${key}`, caseId, `${pointer}/*/${key} is the same object in all ${rows.length} rows: send it once beside the list, or only its id`);
      }
    }
  }
}

/** Whether a path segment or key names a plural (`orders`, `user-profiles`; not `status`, `access`). @param {string} word */
const plural = (word) => /[^siu:]s$|^(?:people|children|data|media)$/.test(word.split(/[-_]|(?<=[a-z])(?=[A-Z])/).at(-1)?.toLowerCase() ?? "");
/** A word in plural form, roughly. @param {string} word */
const pluralOf = (word) => word.replace(/(?<=[^aeiou])y$/, "ie").replace(/(?<=s|x|ch|sh)$/, "e") + "s";
/** A word in singular form, roughly. @param {string} word */
const singular = (word) => word.replace(/ies$/, "y").replace(/(?<=s|x|ch|sh)es$/, "").replace(/(?<!s)s$/, "");

/**
 * Requests: one field sent under several spellings across cases, a GET with a body, an ID in the body that names
 * another record than the path.
 * @param {Api} api
 */
function requests(api) {
  for (const route of api.routes) {
    /** @type {Map<string, Map<string, string>>} parent and words -> spelling -> first case */
    const spellings = new Map();
    for (const { caseId, shape } of requestShapes(route)) {
      for (const field of fieldsOf(shape)) {
        const id = `${field.parent}\0${restyle(field.key, "kebab")}`;
        const seen = spellings.get(id) ?? new Map();
        spellings.set(id, seen);
        if (!seen.has(field.key)) seen.set(field.key, caseId);
        if (seen.size === 2) api.add(route, "requests", field.pointer, caseId, `request ${some([...seen.keys()].map((key) => `${field.parent}/${key}`))} arrive across cases: clients disagree on the name; accept one`);
      }
    }
    for (const item of route.cases) {
      if (item.method === "GET" && item.body !== undefined && item.body !== null) api.add(route, "requests", "/", item.caseId, "a GET arrives with a body, which proxies and caches drop: move it to the query string");
      const clash = pathIdClash(item, api.pattern);
      if (clash) api.add(route, "requests", `/${clash.key}`, item.caseId, `request /${clash.key} names another record than the path's :${clash.param}: take the ID from the path and drop it from the body`);
    }
  }
}

/** A top-level body key that repeats a path parameter (`noteId` for `/notes/:id`) with another ID. @param {Evidence} item @param {RegExp} pattern */
function pathIdClash(item, pattern) {
  if (!isObject(item.body)) return undefined;
  const template = item.route.split("/");
  const path = item.path.split("/");
  const norm = (/** @type {string} */ name) => name.toLowerCase().replace(/[-_]/g, "");
  for (const [index, segment] of template.entries()) {
    if (!segment.startsWith(":") || !pattern.test(path[index] ?? "")) continue;
    const param = segment.slice(1);
    const names = [norm(param), ...(param === "id" && template[index - 1] ? [norm(`${singular(template[index - 1])}Id`)] : [])];
    const key = Object.keys(item.body).find((name) => names.includes(norm(name)) && typeof item.body[name] === "string" && pattern.test(item.body[name]));
    if (key && item.body[key] !== path[index]) return { key, param };
  }
  return undefined;
}

const VERSION = /^v\d+(?:\.\d+)?$/;
const OPS = /^\/(?:api\/)?(?:health|healthz|ready|readyz|livez|ping|metrics|webhooks?|\.well-known|docs|openapi|swagger)\b/;
const VERB = /^(?:get|create|update|delete|fetch|list|add|remove|edit|save|retrieve|insert|modify|do|make)$/;

/**
 * Route naming from the templates alone: a version prefix laid out unlike the rest, a path segment cased against the
 * API's style, a singular collection among plural ones, a CRUD verb in a resource-style API, and one collection's
 * parameter named two ways.
 * @param {Api} api
 */
function routeNames(api) {
  const routes = api.routes.filter((route) => !OPS.test(route.route));
  const segments = (/** @type {Route} */ route) => route.route.split("/").filter(Boolean);
  /** The path up to its version segment, as written and with any version (`/api/v*`). @param {Route} route */
  const prefix = (route) => {
    const parts = segments(route);
    const at = parts.findIndex((part) => VERSION.test(part));
    return at === -1 ? { written: "", shape: "no version prefix" } : { written: `/${parts.slice(0, at + 1).join("/")}`, shape: `/${[...parts.slice(0, at), "v*"].join("/")}` };
  };
  const version = majority(new Map(routes.map((route) => [route.route, prefix(route).shape])).values());
  const usual = routes.map((route) => prefix(route)).find((item) => item.shape === version?.value)?.written;
  for (const route of version ? routes.filter((item) => prefix(item).shape !== version.value) : []) {
    const own = prefix(route).written;
    api.add(route, "routes", "", route.cases[0].caseId, `the path has ${own ? `the prefix ${own}` : "no version prefix"}; ${version?.agree} of ${version?.total} routes start ${version?.value === "no version prefix" ? "without one" : version?.value}: ${usual ? `move it under ${usual}` : "drop the prefix"}`);
  }
  const statics = routes.flatMap((route) => segments(route).map((part, index, all) => ({ route, part, collection: all[index + 1]?.startsWith(":") ?? false })))
    .filter(({ part }) => !part.startsWith(":") && !VERSION.test(part));
  pathStyle(api, statics);
  const names = new Set(statics.map((item) => item.part));
  const collections = new Map(statics.filter((item) => item.collection).map((item) => [item.part, item]));
  const many = majority([...collections.values()].map((item) => plural(item.part)));
  // Only a singular whose plural the API also uses: `/user/:id` beside `/users`. Other singular segments are often
  // actions or kinds (`/invites/join/:account`), not collections.
  for (const item of many?.value ? [...collections.values()].filter((entry) => !plural(entry.part) && names.has(pluralOf(entry.part))) : []) {
    api.add(item.route, "routes", "", item.route.cases[0].caseId, `the collection /${item.part} is singular, and the API also has /${pluralOf(item.part)}; ${many?.agree} of ${many?.total} collections are plural: use /${pluralOf(item.part)}`);
  }
  // `add-ons` and `set-ups` are nouns.
  const verb = (/** @type {Route} */ route) => segments(route).find((part) => {
    const [first, ...rest] = restyle(part, "kebab").split("-");
    return VERB.test(first) && !/^(?:ons?|ups?|ins?|outs?)$/.test(rest.join("-"));
  });
  const resources = majority(new Map(routes.map((route) => [route.route, verb(route) === undefined])).values());
  for (const route of resources?.value ? routes.filter((item) => verb(item) !== undefined) : []) {
    api.add(route, "routes", "", route.cases[0].caseId, `the path segment ${verb(route)} is a verb; ${resources?.agree} of ${resources?.total} routes name resources and let the method say the action: use ${route.method} on the resource`);
  }
  paramNames(api, routes);
}

/** Path segments cased against the API's style, each reported once. @param {Api} api @param {{ route: Route, part: string }[]} statics */
function pathStyle(api, statics) {
  const styled = new Map(statics.map((item) => [item.part, { ...item, style: styleOf(item.part) }]).filter(([, item]) => item.style && item.style !== "word"));
  const rule = majority([...styled.values()].map((item) => item.style));
  const style = /** @type {keyof typeof STYLE_NAME} */ (rule?.value);
  for (const item of rule ? [...styled.values()].filter((entry) => entry.style !== style) : []) {
    api.add(item.route, "routes", "", item.route.cases[0].caseId, `the path segment ${item.part} is ${STYLE_NAME[/** @type {keyof typeof STYLE_NAME} */ (item.style)]}; ${rule?.agree} of ${rule?.total} multi-word path segments are ${STYLE_NAME[style]}: rename it ${restyle(item.part, style)}`);
  }
}

/**
 * One collection's parameter named two ways (`/users/:id` and `/users/:userId`), compared only between routes that
 * use it in the same position, since `/users/:id` beside `/users/:user_id/orders` is a convention of its own.
 * @param {Api} api @param {Route[]} routes
 */
function paramNames(api, routes) {
  /** @type {Map<string, Map<string, Route[]>>} prefix and position -> name -> routes */
  const groups = new Map();
  for (const route of routes) {
    const parts = route.route.split("/");
    for (const [index, part] of parts.entries()) {
      // Only ID parameters are compared: `:slug` beside `:id` addresses the record by another value, not another name.
      if (!/^:(?:.*(?:id|Id|ID)|[a-z]id)$/.test(part)) continue;
      const id = `${parts.slice(0, index).map((item) => (item.startsWith(":") ? ":" : item)).join("/")}\0${index === parts.length - 1}`;
      const names = groups.get(id) ?? new Map();
      groups.set(id, names.set(part, [...(names.get(part) ?? []), route]));
    }
  }
  for (const [id, names] of groups) {
    if (names.size < 2) continue;
    const [[top, users], ...rest] = [...names].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    for (const [name, list] of rest) {
      for (const route of list) api.add(route, "routes", "", route.cases[0].caseId, `the parameter after ${id.split("\0")[0]} is ${name}; ${users.length} other route${users.length === 1 ? "" : "s"} there call it ${top}: use ${top}`);
    }
  }
}

/**
 * The evidence for the lint: every API case of the sessions (deduplicated), with what the server answered it in this
 * run when it was replayed.
 * @param {import("../shared/case.mjs").Case[]} cases @param {Record<string, Live>} live
 * @returns {Evidence[]}
 */
export function evidenceOf(cases, live) {
  const unique = new Map(cases.filter((item) => item.request.method !== UI_METHOD).map((item) => [item.id, item]));
  return [...unique.values()].map((item) => ({
    caseId: item.id, method: item.request.method, route: item.request.route, path: item.request.path, actor: item.actor.kind,
    body: item.request.body, status: item.response.status, shape: item.response.shape, live: live[item.id],
  }));
}
