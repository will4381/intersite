// @ts-check
// How Intersite signs in and finds seeded data when it replays captured sessions against this project.
// Only signIn is required. See "Replay adapter" in node_modules/intersite/CONTRACT.md.

/**
 * Headers that authenticate a seeded test user with this role. `other: true` asks for a user of a different account,
 * which the cross-tenant mode uses to check that one account cannot reach another's records.
 * @param {string} actorKind @param {{ target: string, other: boolean }} options
 * @returns {Promise<Record<string, string>>}
 */
export async function signIn(actorKind, { target, other }) {
  throw new Error(`intersite.adapter.mjs: signIn is not written yet (asked for ${other ? "another " : ""}${actorKind} at ${target})`);
}

/**
 * A seeded record to stand in for an ID the replayed session did not create itself. Return undefined to skip.
 * @param {string} id @param {{ target: string }} options
 * @returns {Promise<string | undefined>}
 */
export async function resolveId(_id, _options) {
  return undefined;
}

// Optional: `export async function reset({ target }) {}` runs before each session, for example to reseed.
// Optional: `export const invariants = [{ name, async check({ target, fetch }) { return undefined; } }]` is checked
// after each session; return a message when something that must always hold does not.
