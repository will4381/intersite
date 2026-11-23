// @ts-check
// Fails when the change adds or edits an endpoint (a route handler, server action, form action, loader, tRPC
// procedure, Convex function or route registration) that never asks who is calling, in a package where most
// endpoints of that kind do. The convention is inferred from the project, never configured; endpoints public by their
// path (sign-in, webhooks, health, cron) are left out. Every file is read, to learn the convention. The work is in
// core/auth.rs.
import { productCodeGate } from "./core.mjs";

/** @param {import("./lib.mjs").GateOptions} options @returns {Promise<import("./lib.mjs").GateResult>} */
export async function auth(options) {
  return productCodeGate("auth", options);
}
