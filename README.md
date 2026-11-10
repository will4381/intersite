# Intersite

One testing library for every project. It stops agents shipping slop and tests that prove nothing, and it turns real
production traffic into tests nobody has to write.

| Part | What it does |
| --- | --- |
| `intersite lint` | Slop rules on top of oxlint, with a baseline that can only shrink |
| `intersite gate fails-on-base` | Proves a bug fix's new test fails without the fix |
| `intersite/capture` | Samples real API requests in production, scrubs them, sends them to the collector |
| `intersite deploy` | Deploys the collector: one Cloudflare Worker and one D1 database |
| `intersite replay` | Replays captured sessions against a local server and reports what changed |

The exact formats and rules are in [CONTRACT.md](CONTRACT.md).

## Install

Straight from GitHub, pinned to a tag. There is no build step.

```json
{ "devDependencies": { "intersite": "github:<owner>/intersite#v0.1.0", "oxlint": "^1.93.0", "@oxlint/plugins": "^1.93.0" } }
```

## Config

One `intersite.json` at the project root. Everything but `project` has a default; `intersite.schema.json` documents
every field.

```json
{
  "$schema": "./node_modules/intersite/intersite.schema.json",
  "project": "acme",
  "collector": { "url": "https://intersite-collector.<account>.workers.dev" },
  "lint": {
    "packs": ["tests", "slop"],
    "rules": { "no-explicit-any": "off" },
    "custom": [
      { "id": "no-raw-fetch", "selector": "CallExpression[callee.name='fetch']", "message": "Use the injected fetch.", "files": ["src/**"] }
    ]
  },
  "capture": { "sample": 0.05, "exclude": ["/webhooks/**"], "redactKeys": ["nickname"] },
  "replay": { "target": "http://localhost:8787", "adapter": "./intersite.adapter.mjs", "modes": ["baseline", "twice", "cross-tenant"] }
}
```

## Lint

```bash
npx intersite lint
```

- `npx intersite lint --write=init` records today's findings in `lint-baseline.json`. From then on a new finding
  fails, and so does fixing one without running `npx intersite lint --write` to lower the count.
- The project's own `.oxlintrc.json` still applies; Intersite's rules are added on top.
- A deliberate exception needs a rule name and a reason: `// oxlint-disable-next-line intersite/<rule> -- <why>`.

### Adding a rule

A rule is one JSON entry: a syntax-tree selector, a message that says what to do instead, and examples.

- For one project: add it to `lint.custom` in that project's `intersite.json`.
- For every project: add it to [lint/rules.json](lint/rules.json) with a `pack`, a `bad` list and a `good` list.
  `npm test` fails unless every `bad` snippet is reported and no `good` snippet is.
- When a selector cannot express it, write `lint/rules/<id>.mjs` exporting `{ id, pack, rule, bad, good }` and list
  it in `lint/rules/index.mjs`.

## Gate

```bash
npx intersite gate fails-on-base --base origin/main --cmd "npm test" --setup "npm ci"
```

Checks out the base commit in a temporary worktree, copies in the changed test files and runs the command. If the
tests pass there, they do not test the fix, and the gate fails.

## Capture

In the project's server (shown for a Cloudflare Worker):

```js
import { createCapture } from "intersite/capture";

const capture = createCapture({ project: "acme", url: env.INTERSITE_URL, token: env.INTERSITE_INGEST_TOKEN, release: env.RELEASE });
const copy = request.clone();
const { response, route, user } = await handle(request, env);
ctx.waitUntil(capture.record({ request: copy, response, route, actor: { kind: user?.role ?? "anonymous" }, session: user?.id ?? "anonymous" }));
return response;
```

- Whole sessions are sampled (`capture.sample`); any request that is not `ok` is always recorded.
- Scrubbing is default-deny: a string is kept only when it is an ID, a date, or a short code such as `active`.
  Everything else becomes a stable fake. No headers and no response bodies are stored.
- Read a batch of stored cases by hand before turning capture on in production, and add the project's own field
  names to `capture.redactKeys`. The known gaps are listed in `capture/scrub.mjs`.

## Collector

```bash
npx intersite deploy --dry-run
```

```bash
npx intersite deploy
```

Creates the D1 database, applies the schema, deploys the Worker and prints two tokens once: the ingest token for the
production server and the read token for developers and CI. Set `collector.domain` for a custom domain. Cases expire
after `capture.ttlDays`, a daily run deletes them, `POST /v1/cases/:id/pin` keeps one forever, and `collector.dailyCap`
bounds how many are stored per project per day.

## Replay

```bash
npx intersite replay --sample 20
```

```bash
npx intersite replay --tag error --since 7d
```

```bash
npx intersite replay --id <request id>
```

The project supplies `intersite.adapter.mjs`: `signIn` returns headers for a seeded user of a role, `resolveId` maps
an ID the session did not create to a seeded record, `reset` reseeds, and `invariants` are checked after each
session. A failure prints one line with the command that reruns it. Replay refuses a target that is not local unless
`--allow-remote` is passed.

- Nightly on the main branch: `intersite replay --sample 200 --mark --release <sha>` records which sessions pass.
- On pull requests: `intersite replay --known-good --sample 20` replays only sessions that passed on main.

## Developing

```bash
npm test
```

```bash
npm run lint
```
