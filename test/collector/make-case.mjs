// @ts-check

/** A valid case; any field can be overridden. @param {Record<string, any>} [over] */
export function makeCase(over = {}) {
  const { route = "/things/:id", atMs = Date.now(), ...rest } = over;
  return {
    v: 1,
    id: `req-${Math.random().toString(36).slice(2)}`,
    project: "p",
    session: "s1",
    seq: atMs,
    at: new Date(atMs).toISOString(),
    release: "abc",
    outcome: "ok",
    actor: { kind: "creator" },
    request: { method: "GET", route, path: "/things/1", query: {}, body: null },
    response: { status: 200, shape: { id: "string" }, ids: {} },
    ttlDays: 14,
    ...rest,
  };
}
