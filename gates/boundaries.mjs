// @ts-check
// Fails when an added import crosses a line the project draws: a relative path into another workspace package, a
// workspace package used without being declared, a new barrel file (unless the project keeps barrels), server-only
// code (a database driver, a secret read at load) pulled into a "use client" module, and, when configured,
// `gates.layers` imported upward or one of `gates.features` importing another. The work is in core/boundaries.rs,
// on the import graph of core/graph.rs.
import { graphGate } from "./imports.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function boundaries(options) {
  return graphGate("boundaries", options, { entryPaths: options.entryPaths, layers: options.layers, features: options.features });
}
