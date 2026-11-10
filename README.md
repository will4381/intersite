# Intersite

One testing library for every project. It stops agents shipping slop and tests that prove nothing, and it turns real
user sessions into tests nobody has to write.

## Quickstart

```bash
npm i -D github:will4381/intersite#v1.0.0-beta.1 oxlint @oxlint/plugins
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
| `artifacts` | Leftovers: backup and `_v2` copies, scratch scripts, logs, stray `PLAN.md` and `SUMMARY.md` files | git |
| `unused` | A file or export this change added that nothing uses, or a file it orphaned | git |
| `replay` | An API that now answers real recorded sessions differently | capture and an adapter |

Two more gates run the tests and are opt-in through `gates.run`: `fails-on-base` (a bug fix's new test must fail
without the fix) and `mutation` (a deliberate break on a changed line must make a test fail).

Output is written for agents: one line on success, one line per finding with the command that reruns only that
finding, exit code 0, 1 or 2.

## Commands

| Command | Does |
| --- | --- |
| `intersite init` | Sets a project up; safe to run again after upgrading |
| `intersite check [--skip <stage>]` | Runs every stage that applies |
| `intersite lint [paths] [--write] [--rules]` | Lints; `--write` lowers the baseline; `--rules` lists what applies |
| `intersite gate <name> [--base <ref>]` | Runs one gate against the diff |
| `intersite collector` | Runs the local collector (SQLite file in `.intersite/`) |
| `intersite replay [--id] [--tag] [--action] [--sample] [--mode] [--verbose]` | Replays recorded sessions against a local server |
| `intersite actions` | Lists named user actions seen, with error counts |
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
  packs: [tests, slop, security, state, actions]
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

replay:
  target: http://localhost:8787
  modes: [baseline, twice, cross-tenant]
```

A deliberate exception is always written down where a reviewer sees it: `gates.acknowledged` for a gate, or
`// oxlint-disable-next-line intersite/<rule> -- <why>` for a lint rule.

## Lint rules

A rule is one YAML entry: a syntax-tree `selector` (or a `comment` pattern, for rules about comments), a message
that says what to do instead, and examples.

- For one project: add it to `lint.custom` in `intersite.yml`.
- For every project: add it to [lint/rules.yml](lint/rules.yml) with a `pack`, `bad` and `good` examples. The
  test suite fails unless every `bad` example is reported and no `good` one is.
- When a selector cannot express it: `lint/rules/<id>.mjs`, listed in `lint/rules/index.mjs`.

| Pack | Default | Catches |
| --- | --- | --- |
| `tests` | on | Tests that cannot fail: no assertion, constant or mock-only assertions, skips, module mocking |
| `slop` | on | Swallowed errors, fake fallback values, `any` and double casts, commented-out code, elision markers such as `// ... rest of the code`, comments that narrate an edit, unexplained suppressions |
| `security` | on | Live credentials in source, SQL built by string interpolation |
| `state` | on | Implicit state machines: three or more boolean flags doing one state's job |
| `runtime` | opt-in | Module-level mutable state, which leaks between requests on serverless |
| `actions` | opt-in | Clickable elements with no `data-intersite` name |

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
[capture/index.mjs](capture/index.mjs).

- **Scrubbing is default-deny.** A string is kept only when it is an ID, a date, or a short code such as `active`.
  Everything else becomes a stable fake. No headers and no response bodies are stored. Read a batch of stored cases
  by hand before turning capture on in production; the known gaps are listed in `capture/scrub.mjs`.
- **Actions** are names you give to what users do: `<button data-intersite="program.save">`. The tracker
  (`intersite/track`) stamps each request with the action that caused it, so `intersite actions` shows which
  actions fail in production and `intersite replay --action program.save` replays exactly those. Markup can change
  freely as long as the name stays.
- **Replay modes:** `baseline` (same status and response shape as production), `twice` (a repeated write must not
  error), `cross-tenant` (another account must be refused), `ui` (each named action's page loads cleanly in Chrome
  and the action is still there).
- **The adapter** (`intersite.adapter.mjs`) tells replay how to sign in a seeded test user and which seeded record
  stands in for an ID from production.
- Replay refuses a target that is not local unless `--allow-remote` is passed.

Nightly on the main branch, `intersite replay --sample 200 --mark --release <sha>` records which sessions pass. Pull
requests then run `intersite replay --known-good`, so a failure there is a regression and not old noise.

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
