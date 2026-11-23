// @ts-check
// Fails when the change reads an environment variable that the project's .env.example (or env schema) does not
// declare: a misspelt name, or one the deploy will not have. The work is in core/env.rs.
import { productCodeGate } from "./core.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function env(options) {
  return productCodeGate("env", options, true);
}
