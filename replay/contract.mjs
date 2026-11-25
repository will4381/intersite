// @ts-check
// The API contract lint: what the API's requests carry and what it answers, read across every route for inconsistency
// and bad shapes. The judging is the engine's `contract` command (core/src/contract.rs); this module gathers the
// evidence it reads and prints the findings it returns.
import { runCore } from "../gates/core.mjs";
import { UI_METHOD } from "../shared/case.mjs";

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
 * grouped with: findings of one kind under one object, three or more, print as one line.
 * @typedef {{ check: Check, method: string, route: string, pointer: string, message: string, caseId: string, detail?: string, group?: string }} Finding
 */
/** @typedef {{ route: string, pointer?: string, check?: string, why: string }} Ignore */

const SHOWN = 3;
/** How a group of findings is described, per check. */
const GROUP_PHRASE = { types: "are typed two ways across answers", requests: "arrive in two forms across cases" };

/**
 * The contract findings over every case of the sampled sessions, in the order they were found. `ignore` holds
 * `replay.contractIgnore`.
 * @param {Evidence[]} evidence @param {{ idPattern: string, ignore?: Ignore[] }} options
 * @returns {Finding[]}
 */
export function lintContract(evidence, { idPattern, ignore = [] }) {
  return runCore({ command: "contract", options: { evidence, idPattern, ignore } }).data;
}

/** What a finding says to do: the text after its last `: `. @param {string} message */
const remedyOf = (message) => message.slice(message.lastIndexOf(": ") + 2);

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
