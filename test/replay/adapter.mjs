// @ts-check
// The replay adapter a project would write, for the toy target in helpers.mjs.

/** @param {string} _kind @param {{ other: boolean }} options */
export async function signIn(_kind, { other }) {
  return { "x-tenant": other ? "b" : "a" };
}

/** @param {string} id */
export async function resolveId(id) {
  return id === "note_prod99" ? "note_seed01" : undefined;
}

/** @param {{ target: string }} options */
export async function reset({ target }) {
  await fetch(`${target}/__reset`, { method: "POST" });
}

export const invariants = [
  {
    name: "ledger balances",
    /** @param {{ target: string, fetch: typeof fetch }} options */
    async check({ target, fetch }) {
      const stats = await (await fetch(`${target}/stats`)).json();
      return stats.ok ? undefined : "ledger is off by 1";
    },
  },
];
