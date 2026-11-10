// @ts-check
// The replay adapter for the stateless shop in helpers.mjs: one signed-in user, and every recorded ID exists.
import { SHOP_TOKEN } from "./helpers.mjs";

export async function signIn() {
  return { authorization: SHOP_TOKEN };
}

/** @param {string} id */
export async function resolveId(id) {
  return id;
}
