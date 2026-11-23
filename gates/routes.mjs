// @ts-check
// Fails when the change adds a link, navigation or API call that no route of the app answers, or calls a route with a
// method it does not handle. Routes come from the framework's files (Next.js, React Router and Remix, SvelteKit, Nuxt,
// Astro) and from routes declared in code (React Router, TanStack, Express, Hono, Fastify). The work is in core/routes.rs.
import { productCodeGate } from "./core.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function routes(options) {
  return productCodeGate("routes", options, true);
}
