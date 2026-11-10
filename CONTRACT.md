# Intersite contract

What every part of this package agrees on. Change it here first, then in code.

## Parts

| Folder | Runs in | Does |
| --- | --- | --- |
| `lint/`, `cli/lint.mjs` | Node, inside oxlint | Slop rules, mostly declared in JSON; baseline that only shrinks |
| `gates/`, `cli/gate.mjs` | Node, local or CI | Checks on a change: test integrity, duplicates, new dependencies, fails-on-base, mutation |
| `track/` | The browser | Names user actions and stamps them on the requests they cause |
| `capture/` | The project's server or browser (any `fetch` runtime) | Samples, scrubs and sends cases to the collector |
| `collector/`, `cli/collector.mjs`, `cli/deploy.mjs` | Node with SQLite locally; a Cloudflare Worker with D1 when deployed | Stores cases, answers queries, deletes expired ones |
| `replay/`, `cli/replay.mjs` | Node, local or CI | Pulls cases, replays them against a target URL, compares |
| `cli/check.mjs`, `cli/init.mjs` | Node | `check` runs everything that applies; `init` sets a project up |
| `shared/` | Everywhere | `case.mjs`, `shape.mjs` (no Node imports), `config.mjs` (Node only) |

## Code rules

- Plain ESM `.mjs` with `// @ts-check` and JSDoc types. No TypeScript files, no build step: the package is installed
  straight from GitHub (`"intersite": "github:<owner>/intersite#<tag>"`), and Node refuses to strip types under
  `node_modules`.
- One runtime dependency, `yaml`, used only where config and rule files are read (never in `capture/` or `track/`).
  `oxlint` and `@oxlint/plugins` are peers; `playwright-core` is an optional peer used only
  by the `ui` replay mode; `wrangler` is a dev dependency.
- `capture/`, `track/`, `shared/case.mjs` and `shared/shape.mjs` use only web-standard APIs.
- Tests are `node --test` files under `test/<part>/`. Test behavior through the part's public entry, not its internals.
- A deliberate shortcut gets a `// ponytail: <ceiling>, <upgrade path>` comment.
- The package passes its own `npm run lint` with an empty baseline.

## CLI output (every command)

Agents read this output, and every line costs them context.

- Success is one line: `ok <command>: <counts>`.
- A finding is one line: what and where, then `| rerun: <exact command>` when a narrower rerun exists.
- Nothing decorative: no banners, colours, progress bars or blank lines. `--json` prints structured data instead.
- Exit 0 pass, 1 findings, 2 usage or setup error. A setup error is one line on stderr that says what to do.

## Config: `intersite.yml`

One optional file at the project root, described by `intersite.schema.json`, loaded with `loadConfig(cwd)` from
`shared/config.mjs`, which fills defaults. With no file every default applies and the project is named after its
package, so each command works in a fresh checkout. `intersite.json` is still read, since JSON is valid YAML. Secrets are never in it; it names the environment variables that hold
them, and `collectorTokens(config)` reads them, falling back to `local-read` and `local-ingest`, the tokens the
local collector accepts.

## Case (v1)

Defined in `shared/case.mjs` (`Case` typedef, `caseProblem`). `response.shape` comes from `shapeOf` and is compared
with `shapeDiff`; `response.ids` comes from `idsOf` (all in `shared/shape.mjs`). A case never holds cookies, tokens,
`Authorization` or API-key headers, or a raw user identifier. Response bodies are not stored, only their shape and IDs.
Request path, query and body values are scrubbed by `capture/scrub.mjs`: a string is kept only when it is an ID, a
short digit string, an ISO date under a date-like key, or a short lowercase code under a structural key (or one in
`capture.keepKeys`); every other string becomes a stable fake of the same form, such as `text-1a2b3c4d`.

A **session** is every case with the same `session` value, ordered by `seq`. Capture samples whole sessions, and
always records a case whose outcome is not `ok`. An `ok` request of an unsampled session costs one small hash: nothing
is cloned or read. Cases are sent in batches of up to 50 per request. On Cloudflare Workers, create the capture
inside the request handler, because a Worker may not carry I/O from one request into another.

### Actions

An **action** is a named thing a user does in the UI, such as `program.save`. Names are written by developers,
match `ACTION_NAME`, and are never derived from page text. They are the stable link between the UI and the tests:
markup can change freely as long as the element keeps its name.

- In markup: `data-intersite="program.save"` on the element the user clicks or the form they submit.
- `track/` notes the most recent action and stamps the requests that follow it. Capture stores it as
  `case.action = { name, page }`, where `page` is the browser path with every segment that is not an ID or a short
  lowercase word (`a` to `z`, at most 20 letters) replaced by `_`: `reducePage` in `shared/case.mjs`. Capture applies
  it again on the server and never trusts the client's value. A name in a path (`/u/maria`) looks like any short
  word, so an app whose paths can hold one passes the tracker `page: () => <route template>` (`/u/:handle`).
- A client-side error or warning with no API call is stored as a **UI case**: `request.method` is `UI_METHOD`,
  `request.route` and `request.path` are the page, `response.status` is 0, and `response.errorCode` is the error's
  name (never its message).

### Headers

| Header | Set by | Meaning |
| --- | --- | --- |
| `x-intersite-action` | `track/` | Action name for this request |
| `x-intersite-page` | `track/` | Page path, already reduced as above |
| `x-intersite-session` | `track/` | Random per-tab ID; capture uses it as the session when the caller gives none |
| `x-intersite-replay` | replay | The case ID being replayed. Capture skips these; a server may use it to stub outside calls |
| `x-intersite-time` | replay | The case's recorded `at`. A server may pin its clock to it |

## Collector HTTP API

JSON in and out. `Authorization: Bearer <token>`. Two secrets: `INGEST_TOKEN` may only `POST /v1/cases`;
`READ_TOKEN` may do everything else. Errors are `{ "error": "<message>" }` with a 4xx/5xx status.
`POST /v1/cases` answers CORS preflight and allows any origin, so a browser can send UI cases; no other route does.

| Method and path | Token | Body or query | Returns |
| --- | --- | --- | --- |
| `GET /health` | none | | `{ ok: true }` |
| `POST /v1/cases` | ingest | `{ cases: Case[] }`, at most 50 | `{ accepted: number, dropped: { id: string, reason: string }[] }` |
| `GET /v1/sessions` | read | query below | `{ sessions: { session: string, cases: Case[] }[] }` |
| `GET /v1/cases/:id` | read | `project` | `{ session: string, cases: Case[] }`: the case and the earlier cases of its session |
| `POST /v1/cases/:id/pin` | read | `{ project, pinned: boolean }` | `{ pinned: boolean }` |
| `POST /v1/results` | read | `{ project, release, results: { session: string, pass: boolean }[] }` | `{ recorded: number }` |
| `GET /v1/actions` | read | `project`, optional `since` | `{ actions: { name, page, ok, warn, rejected, error, lastAt }[] }`, one row per name and page with a count per outcome |

`GET /v1/sessions` query: `project` (required), `outcome` (repeatable), `route` (exact route template), `action`
(exact action name), `since` (ISO timestamp), `known_good=1`, `sample` (how many sessions, default 20, at most 200),
`seed` (integer; same seed and same data give the same sample).

Rules the collector enforces:
- Every case passes `caseProblem`; a failing one is dropped with its reason, the rest are stored.
- A duplicate `(project, id)` is ignored, so capture may retry.
- Each case expires `ttlDays` after `at`. A scheduled run deletes expired cases that are not pinned.
- A daily cap per project and outcome class (`ok` versus everything else) drops the overflow with reason `cap`.
- `known_good=1` returns only sessions whose latest result passed. A session that failed last time, or has never
  been replayed, is left out. So the nightly run on the main branch replays without `known_good` and with `--mark`,
  and pull requests replay with `--known-good`.

All SQL lives in `collector/store.mjs`, written against the D1 interface. Locally, `intersite collector` runs the
same routes and store in Node over `node:sqlite` through a small D1-shaped wrapper, listening on 127.0.0.1 only and
accepting the tokens `local-ingest` and `local-read` unless the token environment variables are set. Its database is
`.intersite/cases.db`. A command that reads cases (`check`, `replay`, `actions`, `pin`) serves that file itself for
the length of the command when the configured collector is local and nothing is listening.

## Gates

Each gate looks at the change between `gates.base` and the working tree (uncommitted work included).
`intersite gate <name> [--base <ref>]` runs one; `intersite check` runs those in `gates.run`.

| Gate | Fails when |
| --- | --- |
| `test-integrity` | A test file was deleted, or has fewer tests or fewer assertions than on base, or gained a skip |
| `duplicates` | An added block of `gates.duplicateLines` or more lines already exists elsewhere in the repository |
| `new-deps` | A `package.json` gained a dependency |
| `artifacts` | The change adds a leftover file: a backup or versioned copy (`*.bak`, `*_old.*`, `*-v2.*`), a scratch or debug script, a log or dump, or a stray planning document (`PLAN.md`, `SUMMARY.md`, `NOTES.md` and the like) |
| `unused` | The change adds a source file nothing references, adds an export nothing uses, or removes the last reference to a file and leaves the file behind |
| `fails-on-base` | The changed tests pass on the base commit, so they do not test the change. Needs `gates.testCmd` |
| `mutation` | A small deliberate break on a changed source line leaves `gates.testCmd` passing. At most `gates.mutants` tries |

A deliberate exception is an entry in `gates.acknowledged`: `{ "gate", "target", "why" }`, where `target` is the file
path or dependency name. It silences that one finding and shows up in review. Every gate's failure line ends by
saying so, because an agent with no honest way out will find a dishonest one.

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

UI cases are skipped by every mode except `ui`.

- `baseline`: replay each session in order; a step passes when the status equals the recorded status and
  `shapeDiff(recorded, replayed)` is undefined. Then run the adapter's invariants.
- `twice`: send each non-GET request a second time; the second answer must not be a 5xx.
- `cross-tenant`: send each request that names an ID as `signIn(kind, { other: true })`; the answer must be 401, 403
  or 404. A request with no ID (a create in the caller's own account) is not checked, and `anonymous` cases are skipped.
  Each checked request is then sent as its owner so the session's state keeps moving.
- `ui`: needs `replay.uiTarget` and `playwright-core`, and drives the installed Chrome. For each distinct
  `action` in the session, in order: open `uiTarget + action.page` (IDs remapped as below) signed in with the
  adapter's headers (a `cookie` becomes browser cookies for the `uiTarget` and `target` origins only; other headers
  go only to those two origins); fail on a page error, a console error, or a 5xx from the API during load; fail when no element
  carries `data-intersite="<name>"`. When every recorded case of that action is a GET, click the element and fail on
  the same three things. An action with exactly one write case (POST, PUT, PATCH, DELETE) whose body is a JSON object
  or empty is filled and submitted: its form is the element or its closest `<form>`; each top-level body key fills the
  control with that `name` or `id` (IDs remapped, dates shifted; nested values left alone); then the form is
  submitted. It passes when a request with the recorded method to a path matching the route template was answered
  with the recorded status and none of the three checks fired. IDs the answer created are mapped for later actions.
  When a key has no control, or there are several write cases, only presence is checked and the step carries
  `checked: "presence"`.
  A page with a `_` segment cannot be rebuilt and is reported `skipped`. IDs in a page go through `resolveId`.

IDs: an ID the recorded response created (in `response.ids`) maps to the ID at the same pointer in the replayed
response, and later requests in the session are rewritten with it. An ID the session did not create goes to
`resolveId`; with no answer the step and everything after it in that session is reported `skipped`, not failed.

Dates: with `replay.shiftDates`, every ISO date or timestamp in a request's query and body is moved forward by the
time between the case's `at` and now, so "starts tomorrow" is still in the future. Each value keeps its format, and a
date without a time moves by whole days. `replaySessions` takes `now` as an option so this is exact in tests.

Metrics: a server may report per-request counters in `Server-Timing` as entries whose `desc` is a number
(`queries;desc=7`); entries with only `dur` are ignored, since durations vary and counts do not.
`--metrics-out <file>` writes `{ "_meta": { seed, sessions }, "<caseId>": { "<counter>": n } }` from the baseline
mode. `--metrics-base <file>` fails a case whose counter is higher than in that file (`FAIL metrics …`), and is a
setup error when the run replays other sessions than the file's; without `--seed` it reuses the file's seed. Compare
two local runs on the same data, never against production.
