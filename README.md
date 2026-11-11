# Intersite

One testing library for every project. It stops agents shipping slop and tests that prove nothing, and it turns real
user sessions into tests nobody has to write.

## Quickstart

```bash
npm i -D github:will4381/intersite#v1.0.0-rc.3 oxlint @oxlint/plugins
```

```bash
npx intersite init
```

```bash
npx intersite check
```

`init` writes the config, the agent rules and skills, and records today's lint findings so only new ones fail.
`check` is the one command to run before calling a change done. Lint and the gates work from this point with no
further setup. To add capture and replay, ask your agent to "set up intersite"; the `intersite-setup` skill walks it
through the wiring.

## What `check` runs

| Stage | Catches | Needs |
| --- | --- | --- |
| `lint` | Slop and tests that cannot fail, on top of your own oxlint config | nothing |
| `test-integrity` | A test deleted, weakened or skipped to get green | git |
| `duplicates` | A pasted block that already exists in the repository | git |
| `new-deps` | A dependency added without saying why | git |
| `similar` | A new function, component, hook or type that already exists under another name; when two differ only in a few literals it says to make one with a variant | git |
| `naming` | A file or folder named against the casing, suffix or test pattern its siblings keep, or unlike its main export | git |
| `style-drift` | A colour, size or token that is almost one the project already has, or off a scale it keeps closed | git |
| `artifacts` | Leftovers: backup and `_v2` copies, scratch scripts, logs, stray `PLAN.md` and `SUMMARY.md` files | git |
| `unused` | A file or export this change added that nothing uses, or a file it orphaned | git |
| `replay` | An API that now answers real recorded sessions differently | capture and an adapter |

`gates.base` defaults to `origin/main` and falls back to `main` or `master`; a repository with no commits compares
against an empty tree, and outside git `check` skips the gates.

In a monorepo, put `intersite.yml` in the app's folder: its `check` judges only that folder's changes, names files
relative to it, and still reports a copy of code that lives in a shared package. A root config skips folders that
have their own.

Two more gates run the tests and are opt-in through `gates.run`: `fails-on-base` (a bug fix's new test must fail
without the fix) and `mutation` (a deliberate break on a changed line must make a test fail).

Output is written for agents: one line on success, one line per finding with the command that reruns only that
finding, exit code 0, 1 or 2.

## Commands

| Command | Does |
| --- | --- |
| `intersite init` | Sets a project up; safe to run again after upgrading |
| `intersite check [--base <ref>] [--skip <stage>]` | Runs every stage that applies; one line on success |
| `intersite lint [paths] [--write] [--rules]` | Lints; `--write` lowers the baseline; `--rules` lists what applies |
| `intersite gate <name> [--base <ref>]` | Runs one gate against the diff |
| `intersite collector` | Runs the local collector (SQLite file in `.intersite/`) |
| `intersite replay [--id] [--tag] [--action] [--sample] [--mode] [--verbose] [--metrics-out] [--metrics-base] [--snapshot-out] [--snapshot-base] [--openapi]` | Replays recorded sessions against a local server |
| `intersite actions` | Lists named user actions seen, with error counts |
| `intersite audit` | Lists every value capture kept, per key, so personal data that slipped through is easy to spot |
| `intersite pin <id>` | Keeps a recorded case from expiring |
| `intersite deploy [--dry-run]` | Deploys the collector to Cloudflare (Worker and D1) |

## Agent skills

`init` installs these into `.claude/skills/` and adds a short rules block to `AGENTS.md`.

| Skill | Used when |
| --- | --- |
| `intersite` | Finishing any change; reading and fixing what `check` reports |
| `intersite-bug` | Fixing a bug: reproduce from the recorded request, fix, prove the test catches it |
| `intersite-rule` | Turning a mistake into a lint rule so it cannot be written again |
| `intersite-setup` | Wiring capture, named actions and the replay adapter into a project |

## Config

Everything has a default, so `intersite.yml` only holds what differs, and every command works with no file at
all. `intersite.schema.json` documents every field and gives editor completion.

```yaml
# yaml-language-server: $schema=./node_modules/intersite/intersite.schema.json
project: acme

lint:
  packs: [tests, slop, security, state, types, validation, actions]   # this list replaces the defaults
  custom:
    - id: no-raw-fetch
      selector: CallExpression[callee.name='fetch']
      message: Call the API through apiClient so errors and auth are handled.
      files: [src/**]

gates:
  base: origin/main
  testCmd: npm test
  run: [test-integrity, duplicates, new-deps, artifacts, unused, fails-on-base]
  acknowledged:
    - { gate: new-deps, target: zod, why: "validates every request body" }

capture:
  exclude: [/webhooks/**]
  redactKeys: [nickname]
  keepKeys: [sortBy]

replay:
  target: http://localhost:8787
  modes: [baseline, twice, cross-tenant]
  crossTenantIgnore:
    - { route: "GET /v1/programs/:id", why: "network programs are public by design" }
```

A deliberate exception is always written down where a reviewer sees it: `gates.acknowledged` for a gate, or
`// oxlint-disable-next-line intersite/<rule> -- <why>` for a lint rule.

## Lint rules

A rule is one YAML entry: a syntax-tree `selector` (or a `comment` pattern, for rules about comments), a message
that says what to do instead, and examples.

- For one project: add it to `lint.custom` in `intersite.yml`.
- For every project: add it to a file in [lint/packs/](lint/packs/) with a `pack`, `bad` and `good` examples. The
  test suite fails unless every `bad` example is reported and no `good` one is.
- A rule can leave out kinds of file with `skip: [tests]`, `[generated]` or both, and skip files that cannot match
  with `needs: '<regex the source must contain>'`.
- When a selector cannot express it: `lint/rules/<id>.mjs`, listed in `lint/rules/index.mjs`.

| Pack | Default | Catches |
| --- | --- | --- |
| `tests` | on | Tests that cannot fail: no assertion, constant or mock-only assertions, skips, module mocking |
| `slop` | on | Swallowed errors, fake fallback values, `any` and double casts, commented-out code, elision and placeholder comments, comments that restate the next line or narrate an edit, emoji and "here" debug logs, throwaway names (`data2`, `fetchUserV2` beside `fetchUser`), mock data and placeholder copy in source |
| `design` | on | Over-engineering and tangles: import cycles, nesting past 4 levels, functions over 80 statements, more than 5 parameters, boolean-flag arguments, tangled ternaries, pass-through functions and components, one-implementation interfaces, classes that should be functions |
| `async` | on | Async callbacks nobody awaits, `fetch` without a status check, rethrows that drop the original error, fixed sleeps, success returned from a catch |
| `react` | on | Effects that only derive state, racy fetches in effects, pointless memoisation, components defined inside components, twelve or more states in one component, needless `"use client"`, hook dependency mistakes |
| `security` | on | Live credentials, default secrets, secrets behind public env prefixes or in logs, SQL and shell commands built from strings, request bodies written straight to the database, `Math.random` tokens, disabled TLS checks, open redirects, unverified Stripe webhooks |
| `next` | on | Server-only env read in a client file, server actions that write with no auth check |
| `state` | on | Implicit state machines: three or more boolean flags doing one state's job |
| `types` | on | Casts on outside data (`JSON.parse(x) as T`, `res.json() as T`, `req.body as T`, `process.env.X as string`), `!` on env, URL, header and storage values and on `find()`, type guards that check nothing, `{...} as T` where `satisfies` would check it, `as never` |
| `validation` | on | Request input reaching a write, query or mail call unchecked, a parsed result thrown away while the raw value is used, `Number()`/`parseInt` on input with no NaN check, page sizes with no maximum, unguarded `JSON.parse(localStorage…)`, raw env reads beside a validated env module |
| `naming` | on | Hook names that lie, lowercase components and types, type words in names (`isLoadingBoolean`), one word cased two ways (`userId` with `userID`), snake_case pasted into camelCase files, abbreviation soup, names over 56 characters, reassigned `UPPER_SNAKE` constants |
| `globals` | on | State on `window`/`globalThis`, exported `let` and exported empty Map/Set/array stores, hand-rolled `getInstance()` singletons |
| `ui` | on | Where the project has tokens or a Tailwind theme: hardcoded colours, type values (size, weight, line height, family), spacing, radius and z-index; raw palette classes; static inline styles; raw controls hand-styled beside the project's own `Button`/`Input`; images without `alt`, clickable `div`s |
| `orm` | on | Drizzle and Prisma: queries on the outer client inside a transaction, update or delete with no `where`, find-then-create races, one lookup per loop item |
| `query` | on | TanStack Query: a `queryKey` missing values the `queryFn` reads, a `queryFn` asserting `id!` with no `enabled` |
| `workers` | on | Cloudflare Workers: promises neither awaited nor passed to `waitUntil`, destructured `ctx.waitUntil` |
| `supabase` | on | Supabase results whose `error` is never read, `auth.getSession()` trusted on the server |
| `server` | on | Express and Fastify: sending twice without `return`, Express 4 async handlers with no error forwarding |
| `start` | on | TanStack Start server functions whose validator only types the input |
| `payments` | on | Stripe amounts built with floats or taken from the client; refunds, transfers and payouts with no idempotency key |
| `auth` | on | A `userId` taken from the request in a handler that has the session |
| `swift` | on | Swift through SwiftLint (`brew install swiftlint`): force `try` and force unwraps, empty `catch` and discarded `try?`, `print` logging, stub `fatalError`s, fixed `asyncAfter` delays, `Task` in `onAppear`, `AnyView`, flag clusters, deprecated SwiftUI APIs, fixed font sizes and raw colours outside design-system files, secrets in source or `UserDefaults`, type and identifier casing, view builders over 100 lines or nested past 7 levels, more than 12 `@State` properties, notification event buses and discarded observers, settable singletons, strong `self` in subscriptions and timers, redundant main-queue hops, generic `MARK`s, restating comments |
| `runtime` | opt-in | Module-level mutable state, which leaks between requests on serverless |
| `actions` | opt-in | Clickable elements with no `data-intersite` name |

A pack can also switch on rules oxlint already ships (`builtin:` in a pack file), and `lint.rules` turns any single
rule off by name. A framework pack stays silent in a project that does not use the framework.

Swift rules live in [lint/swift/rules.yml](lint/swift/rules.yml), in the same form: a message, `bad` and `good`
examples, and either a SwiftLint rule or a regular expression. Intersite runs SwiftLint with only these rules, so a
project's own `.swiftlint.yml` keeps applying to its own SwiftLint runs and every Intersite finding is attributable.
A deliberate exception in Swift is `// swiftlint:disable:next <id> -- <why>`.

## Capture, actions and replay

Capture samples whole user sessions on the project's server, scrubs them, and sends them to the collector. Replay
sends them again to a local server and compares the answers with what production returned.

```js
import { createCapture } from "intersite/capture";

const capture = createCapture({ project: "acme", url: env.INTERSITE_URL, token: env.INTERSITE_INGEST_TOKEN, release: env.RELEASE });
const copy = request.clone();
const { response, route, user } = await handle(request, env);
ctx.waitUntil(capture.record({ request: copy, response, route, actor: { kind: user?.role ?? "anonymous" }, session: user?.id }));
return response;
```

Fastify, Next.js and browser-only (`wrapFetch`) forms are shown at the top of
[capture/index.mjs](capture/index.mjs). In a Node server, build it with
`createCapture({ ...captureOptions(), url, token, release })` (`captureOptions` from `intersite/shared/config`), so
`project` and the `capture` section of `intersite.yml` apply. Capture never reads files itself; on Workers pass
`project`, `exclude`, `redactKeys` and `keepKeys` inline.

- **Mounted servers work.** A server under a prefix (`/api/v1/me` for the route `/v1/me`) is recorded with its real
  path. When cases cannot reach the collector, capture prints one line saying so.
- **Scrubbing is default-deny.** A string is kept only when it is an ID, a date under a date key such as `createdAt`, or a short
  code such as `active` under a structural key such as `status`. Numbers are kept so replay has amounts and counts.
  Everything else becomes a stable fake. No headers and no response bodies are stored. Before turning capture on in
  production, run `intersite audit`: it lists what was kept, per key, widest first. An enum has a handful of values;
  a key with many distinct kept values is probably personal data and goes in `capture.redactKeys`. A project enum that came out faked (such as `sortBy`)
  goes in `capture.keepKeys`. The known gaps
  are listed in `capture/scrub.mjs`.
- **Actions** are names you give to what users do: `<button data-intersite="program.save">`. The tracker
  (`intersite/track`) stamps each request with the action that caused it, so `intersite actions` shows which
  actions fail in production and `intersite replay --action program.save` replays exactly those. Markup can change
  freely as long as the name stays.
- **Replay modes:** `baseline` (same status and response shape as production; a server error production recorded
  fails while it still happens and passes once it is fixed), `twice` (a repeated write must not
  error), `cross-tenant` (another account must be refused, and its lists must not show records the session created; a record public by design goes in
  `replay.crossTenantIgnore` with a reason), `ui` (each named action's page loads cleanly in Chrome;
  reads are clicked, and writes fill the form from the recorded body, submit it and must get the recorded status).
- **Cheaper `ui` runs:** `npx playwright install chromium-headless-shell` makes `ui` use Chrome Headless Shell instead
  of full Chrome (about half the memory and a third of the browser CPU in our benchmark). Lightpanda
  (`replay.browser: lightpanda`) is lighter still but has no real layout, so clicks and visibility checks may not
  work; it is unverified with Intersite.
- **The adapter** (`intersite.adapter.mjs`) tells replay how to sign in a seeded test user and which seeded record
  stands in for an ID from production. Capture stores no headers, so anything every request needs (an API version,
  an idempotency key) comes from its optional `headers` export.
- Replay refuses a target that is not local unless `--allow-remote` is passed.

Nightly on the main branch, `intersite replay --sample 200 --mark --release <sha>` records which sessions pass. Pull
requests then run `intersite replay --known-good`, so a failure there is a regression and not old noise.

### Verifying Lightpanda

Install it (the binary goes to `~/.local/bin`, which must be on PATH), then run the `ui` suite against it:

```bash
curl -fsSL https://pkg.lightpanda.io/install.sh | bash
```

```bash
INTERSITE_UI_BROWSER=lightpanda node --test test/replay/ui.test.mjs
```

If every test passes, `replay.browser: lightpanda` works with Intersite. Lightpanda has no layout, so the tests most
likely to fail are the ones that click or fill forms; each failure names the step.

### Catching an endpoint that got slower

Have the server report counts in the standard `Server-Timing` header (`queries;desc=7`). On the main branch run
`intersite replay --seed 1 --metrics-out .intersite/metrics/main.json`, then on your branch, against the same local
data, `intersite replay --metrics-base .intersite/metrics/main.json`. A request that now runs more queries fails,
which is how an N+1 shows up before production.

### Linting the API itself

`intersite replay --mode contract` lints request and response bodies across the whole API for inconsistency: key
casing, one field typed two ways, envelopes and list paging, error shapes, a status that disagrees with its body,
values in disguise (`"true"`, float noise, dates as numbers), fields that must not leave the server, and route
naming. Conventions are inferred from your own API (what 90% of it already does), never configured, so a finding
reads `/created_at is snake_case; 212 of 214 response fields in this API are camelCase`. A deliberate exception goes
in `replay.contractIgnore` with a reason. Three or more findings of one kind under one object print as one line
naming the object, the count and a few examples; an ignore entry on that object accepts them all.

`intersite replay --mode contract --openapi openapi.json` does the same on a documented contract, with no server
and no recorded traffic.

### Checking that a data change changed only what it should

Before a migration, backfill or refactor, run `intersite replay --seed 1 --snapshot-out .intersite/snapshot/before.json`
against your local server and data. Apply the change, then run
`intersite replay --snapshot-base .intersite/snapshot/before.json`. Every response whose status or values changed is
one `FAIL snapshot` line with the JSON pointer and both values. IDs the session created, timestamps near now and
request IDs are normalised, a timestamp set as now plus a fixed offset (an invite's expiry) is compared by its
offset from each run's start, so two runs of unchanged code report nothing. Other fields that change on their own go in
`replay.snapshotIgnore` (`[/updatedAt, /items/*/etag]`). The file holds response bodies from your local server, so
keep it under the git-ignored `.intersite/`.

### Checking a migration before it ships

During a deploy the old server briefly runs against the new schema. Replay that state: apply the branch's
migrations to the local database, start the server from the base commit, and run
`intersite replay --known-good`. A failure is a request production would have dropped mid-deploy.

## Collector

Locally it is one SQLite file, `.intersite/cases.db`. Commands that read cases (`replay`, `actions`, `pin`, `check`)
open it themselves when no collector is running. To record while you develop, keep one running:

```bash
npx intersite collector
```

The same code deploys to Cloudflare as a Worker with D1 (`intersite deploy`). Cases expire after
`capture.ttlDays`, a pinned case never does, and `collector.dailyCap` bounds how many are stored per day.

## Developing Intersite

```bash
npm test
```

```bash
npm run lint
```

The formats and rules every part agrees on are in [CONTRACT.md](CONTRACT.md).
