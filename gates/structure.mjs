// @ts-check
// Fails when the change makes the code's structure harder to read (after deslop-please and A Philosophy of Software
// Design: deep modules, narrow interfaces): files or folders side by side that use each other in a circle
// (module-cycle), declarations that know each other in a circle a module cycle cannot show (tangle), a field changed
// from outside its class (field-leak), or a folder whose callers use nearly every function it has (shallow-module).
// The work is in core/structure.rs, on the import graph of core/graph.rs.
import { graphGate } from "./imports.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function structure(options) {
  return graphGate("structure", options);
}
