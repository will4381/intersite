// @ts-check
// The collector call the `actions`, `pin` and `audit` commands share: the project's collector from its config, with the
// project added to the query and the body. Throws GateError (CollectorError) with the one line to print.
import { GateError } from "../gates/lib.mjs";
import { call, collectorOf } from "../replay/collector.mjs";
import { loadConfig } from "../shared/config.mjs";

/**
 * @param {string} cwd @param {string} method @param {string} path @param {Record<string, unknown>} [body]
 * @returns {Promise<{ project: string, body: any }>}
 */
export async function callCollector(cwd, method, path, body) {
  let config;
  try {
    config = loadConfig(cwd);
  } catch (error) {
    throw new GateError(/** @type {Error} */ (error).message);
  }
  const query = `${path.includes("?") ? "&" : "?"}${new URLSearchParams({ project: config.project })}`;
  return { project: config.project, body: await call(collectorOf(config), method, path + query, body && { project: config.project, ...body }) };
}
