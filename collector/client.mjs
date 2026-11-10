// @ts-check
// The read-token call the `actions` and `pin` commands share: adds the project to the query and the body.
// Throws SetupError with the one line to print.
import { collectorTokens, loadConfig } from "../shared/config.mjs";

export class SetupError extends Error {}

/**
 * @param {string} cwd @param {string} method @param {string} path @param {Record<string, unknown>} [body]
 * @returns {Promise<{ project: string, status: number, body: any }>}
 */
export async function callCollector(cwd, method, path, body) {
  /** @type {import("../shared/config.mjs").Config} */
  let config;
  try {
    config = loadConfig(cwd);
  } catch (error) {
    throw new SetupError(/** @type {Error} */ (error).message);
  }
  const base = config.collector.url.replace(/\/$/, "");
  const url = new URL(base + path);
  url.searchParams.set("project", config.project);
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${collectorTokens(config).read}`, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify({ project: config.project, ...body }),
    });
  } catch {
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    throw new SetupError(
      `collector at ${base} is not reachable: ${local ? "start it with `intersite collector`" : "check collector.url in intersite.yml"}`,
    );
  }
  const json = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    throw new SetupError(`collector refused the read token: set ${config.collector.readTokenEnv} to the collector's READ_TOKEN`);
  }
  return { project: config.project, status: response.status, body: json };
}
