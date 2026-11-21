// @ts-check
// Fails when the change adds a read of a decision that several files already make on their own: the same environment
// variable read in three or more files, the same feature flag checked in three or more, or a dispatch over the same
// `kind`/`type` values repeated in three or more. Each copy is a place the next change must find; the decision
// belongs in one module. Every file is read, to count the copies that exist. The work is in core/decisions.rs.
import { productCodeGate } from "./core.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function decisions(options) {
  return productCodeGate("decisions", options);
}
