# Intersite contract

What every part of this package agrees on. Change it here first, then in code.

## Parts

| Folder | Runs in | Does |
| --- | --- | --- |
| `lint/`, `cli/lint.mjs` | Node, inside oxlint | Slop rules, mostly declared in JSON; baseline that only shrinks |
| `gates/`, `cli/gate.mjs` | Node, CI | `fails-on-base`: a bug fix's new test must fail on the base commit |
| `capture/` | The project's server (Workers first, any `fetch` runtime) | Samples, scrubs and sends cases to the collector |
| `collector/`, `cli/deploy.mjs` | Its own Cloudflare Worker + D1 | Stores cases, answers queries, deletes expired ones |
| `replay/`, `cli/replay.mjs` | Node, local or CI | Pulls cases, replays them against a target URL, compares |
| `shared/` | Everywhere | `case.mjs`, `shape.mjs` (no Node imports), `config.mjs` (Node only) |

## Code rules

- Plain ESM `.mjs` with `// @ts-check` and JSDoc types. No TypeScript files, no build step: the package is installed
  straight from GitHub (`"intersite": "github:<owner>/intersite#v0.1.0"`), and Node refuses to strip types under
  `node_modules`.
- No runtime dependencies. `oxlint` and `@oxlint/plugins` are peers; `wrangler` is a dev dependency.
- `capture/` and `shared/case.mjs`, `shared/shape.mjs` use only web-standard APIs (`fetch`, `crypto.subtle`, `URL`).
- Tests are `node --test` files under `test/<part>/`. Test behavior through the part's public entry, not its internals.
- A deliberate shortcut gets a `// ponytail: <ceiling>, <upgrade path>` comment.
- CLI output is for agents: one line per finding, the exact command to rerun it, nothing decorative. Exit 0 pass,
  1 findings, 2 usage or setup error.

## Config: `intersite.json`

One file at the project root, described by `intersite.schema.json`, loaded with `loadConfig(cwd)` from
`shared/config.mjs` (which fills defaults). Secrets are never in it; it names the environment variables that hold them.

## Case (v1)

Defined in `shared/case.mjs` (`Case` typedef, `caseProblem`). `response.shape` comes from `shapeOf` and is compared
with `shapeDiff`; `response.ids` comes from `idsOf` (all in `shared/shape.mjs`). A case never holds cookies, tokens,
`Authorization` or API-key headers, or a raw user identifier. Response bodies are not stored, only their shape and IDs.

A **session** is every case with the same `session` value, ordered by `seq`. Capture samples whole sessions
(`hash(session) < sample`), and always records a case whose outcome is not `ok`.

## Collector HTTP API

JSON in and out. `Authorization: Bearer <token>`. Two secrets: `INGEST_TOKEN` may only `POST /v1/cases`;
`READ_TOKEN` may do everything else. Errors are `{ "error": "<message>" }` with a 4xx/5xx status.

| Method and path | Token | Body or query | Returns |
| --- | --- | --- | --- |
| `GET /health` | none | | `{ ok: true }` |
| `POST /v1/cases` | ingest | `{ cases: Case[] }`, at most 50 | `{ accepted: number, dropped: { id: string, reason: string }[] }` |
| `GET /v1/sessions` | read | query below | `{ sessions: { session: string, cases: Case[] }[] }` |
| `GET /v1/cases/:id` | read | `project` | `{ session: string, cases: Case[] }`: the case and the earlier cases of its session |
| `POST /v1/cases/:id/pin` | read | `{ project, pinned: boolean }` | `{ pinned: boolean }` |
| `POST /v1/results` | read | `{ project, release, results: { session: string, pass: boolean }[] }` | `{ recorded: number }` |

`GET /v1/sessions` query: `project` (required), `outcome` (repeatable; a session matches when any of its cases has
it), `route` (exact route template), `since` (ISO timestamp), `known_good=1` (only sessions whose latest result
passed), `sample` (how many sessions, default 20, at most 200), `seed` (integer; same seed and same data give the
same sample).

Rules the collector enforces:
- Every case passes `caseProblem`; a failing one is dropped with its reason, the rest are stored.
- A duplicate `(project, id)` is ignored, so capture may retry.
- Each case expires `ttlDays` after `at`. A scheduled run deletes expired cases that are not pinned.
- A daily cap per project and outcome class (`ok` versus everything else) drops the overflow with reason `cap`.
- `known_good=1` returns only sessions whose latest result passed. A session that failed last time, or has never
  been replayed, is left out. So the nightly run on the main branch replays without `known_good` and with `--mark`,
  and pull requests replay with `--known-good`.

Storage is D1 only in v1, behind one module (`collector/store.mjs`), so R2 for large bodies can be added without
touching the routes.

## Replay adapter

A project supplies the module named by `replay.adapter`. All exports are optional except `signIn`.

```js
/** Headers that authenticate a seeded test user of this role. `other: true` asks for a user of a different account. */
export async function signIn(actorKind, { target, other }) { return { cookie: "…" }; }
/** A seeded record to stand in for an ID the session did not create. Return undefined to skip that step. */
export async function resolveId(id, { target }) { return undefined; }
/** Runs before each session, for example to reseed. */
export async function reset({ target }) {}
/** Checked after each session; return a message when broken. */
export const invariants = [{ name: "ledger balances", async check({ target, fetch }) { return undefined; } }];
```

## Replay modes

- `baseline`: replay each session in order; a step passes when the status equals the recorded status and
  `shapeDiff(recorded, replayed)` is undefined. Then run the adapter's invariants.
- `twice`: send each non-GET request a second time; the second answer must not be a 5xx.
- `cross-tenant`: send each request that names an ID as `signIn(kind, { other: true })`; the answer must be 401, 403
  or 404. A request with no ID (a create in the caller's own account) is not checked, and `anonymous` cases are skipped.
  Each checked request is then sent as its owner so the session's state keeps moving.

IDs: an ID the recorded response created (in `response.ids`) maps to the ID at the same pointer in the replayed
response, and later requests in the session are rewritten with it. An ID the session did not create goes to
`resolveId`; with no answer the step and everything after it in that session is reported `skipped`, not failed.
