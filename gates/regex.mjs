// @ts-check
// Fails when the change adds a regular expression whose backtracking explodes on a crafted input (ReDoS: a repeat
// inside a repeat over the same characters, or overlapping alternatives in a repeat), or a validation pattern (email,
// phone, UUID, URL, IP) that another file writes differently, so the frontend and backend disagree on what is valid.
// Every file is read: a pattern is compared with the patterns of the same name anywhere. The work is in core/regex.rs.
import { productCodeGate } from "./core.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function regex(options) {
  return productCodeGate("regex", options);
}
