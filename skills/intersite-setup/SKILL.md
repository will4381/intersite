---
name: intersite-setup
description: Wire Intersite into a project - lint baseline, the check command, traffic capture, named user actions and the replay adapter. Use when the user asks to "set up intersite", "add intersite", "install the testing library", or when `intersite check` prints `skip replay` and the user wants replay working.
---

# Setting up Intersite in a project

Do the steps in order. Each one leaves the project working, so you can stop after any of them. Read the project's
own agent instructions first and follow its branch and commit rules.

## 1. Install and initialise (2 minutes, no code changes)

Add to `devDependencies`, using the tag the user gives you or the latest one:

```json
"intersite": "github:will4381/intersite#v1.0.0-rc.5"
```

Add `oxlint` and `@oxlint/plugins` too if the project does not have them; if it has them older than 1.93, raise both in
the same install (`oxlint@^1.93 @oxlint/plugins@^1.93`), or npm refuses Intersite's peer range. In a monorepo whose
packages install on their own, the package that imports `intersite/capture` or `intersite/track` lists `intersite` in
its own dependencies; it does not need oxlint there. Then install and run:

```bash
npx intersite init
```

This writes `intersite.yml` (which acknowledges `intersite` itself for the `new-deps` gate), `intersite.adapter.mjs`,
the agent rules and skills, and records today's lint findings in `intersite-baseline.json` so only new ones fail.

If the project already gates its own oxlint rules (a lint script with its own baseline), set `lint: { ownRules: false }` in
`intersite.yml` before `init`: Intersite then reports and baselines only the rules it adds, so the two baselines never
track the same finding.
Add a script: `"check": "intersite check"`.

```bash
npx intersite check
```

It must end with `ok check:`. Lint and the gates now work. Replay is skipped until the steps below are done.

## 2. Capture requests

Find the one place every API request passes through and add about five lines there. Pick the form that fits:

- A `fetch` handler (Cloudflare Workers, Hono, Next.js route handlers): pass the `Request` and `Response`.
- Fastify or Express: pass plain objects from an `onSend` hook or a response middleware.
- No server of its own (the browser calls a hosted API such as Supabase): wrap the client's `fetch` with
  `capture.wrapFetch`.

The examples for each are at the top of `node_modules/intersite/capture/index.mjs`. Rules:

- Build the capture from `intersite.yml`. In a Node server (Fastify, Express, Next.js on the Node runtime):
  `import { captureOptions } from "intersite/shared/config"` and
  `createCapture({ ...captureOptions(), sample: process.env.NODE_ENV === "production" ? 0.05 : 1, url, token, release })`,
  so `project` and the `capture` section (`exclude`, `redactKeys`, `keepKeys`) apply; capture never reads files
  itself. A Cloudflare Worker has no file system: pass `project` (exactly the `project` in `intersite.yml`, or
  nothing shows up), those lists and any `idPattern` inline. Create it inside the request handler, only when the
  collector URL is set, and clone the request only then, so production pays nothing while capture is off.
- Record after the router has run, where the route template and the signed-in caller are known (many routers keep
  them on a per-request context). If the app is also reached under a prefix (`/api/v1/me` for the route `/v1/me`),
  pass the raw path anyway; capture lines the template up with the path's end.
- Record every session while developing (`sample: 1`, as above). The default records 5% of sessions, so a few clicks
  locally would usually record nothing.
- If the server shows a request ID to users (a "Ref" on error pages, or in logs), pass it as `id`, so
  `intersite replay --id <ref>` finds the case.
- `route` is the route template (`/v1/programs/:id`), never the raw path.
- `actor.kind` is a role name such as `member` or `admin`: whatever `signIn` will need to pick the same kind of
  seeded user (with several account types, name the type: `brand`, `partner`, `creator`; mark API keys, as in
  `brand-key`). `session` is the signed-in user's ID; it is hashed before it leaves the server. Leave it unset for a
  signed-out request: the tracker's tab header then groups one browser's requests, and with neither each request is a
  session of its own. Capture stores no
  headers, so anything a request carries only in a header (the account it acts in, an API version) must come back from
  the adapter in step 4.
- If the project's IDs do not look like `prog_8fK2abQ9` or a UUID (base64url with `-` or `_`, plain numbers), set
  `capture.idPattern` in `intersite.yml`, and pass the same pattern inline on Workers. IDs it misses are faked and
  replay cannot follow them.
- Read the collector URL and ingest token from the environment. For local development the URL is
  `http://127.0.0.1:8790` and the token is `local-ingest`; `intersite collector` listens on the port of
  `collector.url`. If the dev or test runtime only lets allowed hosts out (a Miniflare `outboundService`, an egress
  allowlist), let the collector URL through. Capture prints one `intersite capture: cases are not reaching …` line
  when cases are refused or cannot be sent.
- List webhook and provider-callback paths in `capture.exclude` in `intersite.yml`, and the project's own
  personal-data field names in `capture.redactKeys`.
- Do not turn capture on in production yet. Tell the user it needs their review of stored cases first.

## 3. Name user actions (web apps)

Create the tracker once at startup and use its `fetch` for API calls (see `node_modules/intersite/track/index.mjs`).
If any page path can contain a username, handle or other name, pass the tracker `page: () => <current route
template>` from the router, so the name is never sent. Give each button, form and clickable element a stable name:

```html
<button data-intersite="program.save">Save</button>
```

Names are `<area>.<verb>`, lowercase. Name form controls after the API body's keys (`name="title"`), so the `ui`
replay can fill and submit the form. Turn on the `actions` pack so new elements without a name are reported. A
`lint.packs` list replaces the default one, so list the defaults with it:

```yaml
lint:
  packs: [tests, slop, security, state, async, perf, react, next, design, types, validation, naming, globals, ui, orm, query, workers, supabase, server, start, payments, auth, swift, actions]
```

Then baseline the existing ones with `npx intersite lint --write=init`, after checking that `npx intersite lint`
reports nothing but the new pack's findings (`--write=init` records every current finding).

## 4. Write the replay adapter

Open `intersite.adapter.mjs`. Find how this project's tests or seed scripts sign in a test user, and return those
headers from `signIn(actorKind, { other })`, including the header that picks the account it acts in. `other: true`
must return a user from a different account; signing up a fresh one as the app does is the surest stranger. Headers
every request needs whoever sends it (an API version) or that must differ per request (an idempotency key: use the
case ID, so `twice` resends the same one) go in `headers({ caseId, method, route })`. Implement `resolveId` by mapping
an ID's prefix to a seeded record of that kind, or, when replay runs on a copy of the database the traffic was
recorded against, return the ID unchanged. Implement `reset` if there is a reseed command. Never use real user
credentials: only seeded test accounts.

Optional: have the server send `Server-Timing: queries;desc=<n>` per request (count queries in the database
wrapper), so `intersite replay --metrics-base` can catch an N+1 before it ships.

## 5. Try the loop locally

In one terminal, keep a collector running. To record a whole test suite, raise `collector.dailyCap` first: the default
keeps 5,000 cases a day per outcome class and drops the rest.

```bash
npx intersite collector
```

Set `replay.target` in `intersite.yml` to the dev server's URL if it is not `http://localhost:8787` (for the `ui`
mode, `replay.uiTarget` to the URL its pages are served from). Start the project's dev server, click through a few
flows, then:

```bash
npx intersite actions
```

```bash
npx intersite replay --sample 5 --verbose
```

Then check what capture kept:

```bash
npx intersite audit
```

Any key whose kept values look like names, handles or free text goes in `capture.redactKeys`. A row marked "capture
as configured here replaces these" holds fakes of dates or digit strings (they look real), or values stored under
another config, such as a Worker whose inline lists differ from `intersite.yml`. A project enum
whose values came out as `text-…` fakes (such as `sortBy`) goes in `capture.keepKeys`. Show the user this
output; they decide when capture is safe for production.

Fix adapter problems until sessions pass or are skipped for a stated reason. A replayed session runs as the user
`signIn` returns, so a case recorded for one user that another user's data would answer differently (a 404 that is
now a 200) points at the adapter, not the code.

## 6. Report

Tell the user what is wired, what was baselined (counts), which paths are excluded from capture, and what still
needs them: reviewing stored cases before production capture, and choosing where the collector will run.
