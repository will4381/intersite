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
"intersite": "github:will4381/intersite#v1.0.0-beta.1"
```

Add `oxlint` and `@oxlint/plugins` too if the project does not have them, then install and run:

```bash
npx intersite init
```

This writes `intersite.yml`, `intersite.adapter.mjs`, the agent rules and skills, and records today's lint
findings in `intersite-baseline.json` so only new ones fail. Add a script: `"check": "intersite check"`.

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

- `route` is the route template (`/v1/programs/:id`), never the raw path.
- `actor.kind` is a role name such as `member` or `admin`. `session` is the signed-in user's ID; it is hashed
  before it leaves the server.
- Read the collector URL and ingest token from the environment. For local development the URL is
  `http://127.0.0.1:8790` and the token is `local-ingest`.
- List webhook and provider-callback paths in `capture.exclude`, and the project's own personal-data field names in
  `capture.redactKeys`.
- Do not turn capture on in production yet. Tell the user it needs their review of stored cases first.

## 3. Name user actions (web apps)

Create the tracker once at startup and use its `fetch` for API calls (see `node_modules/intersite/track/index.mjs`).
Give each button, form and clickable element a stable name:

```html
<button data-intersite="program.save">Save</button>
```

Names are `<area>.<verb>`, lowercase. Name form controls after the API body's keys (`name="title"`), so the `ui`
replay can fill and submit the form. Add `"actions"` to `lint.packs` so new elements without a name are reported;
baseline the existing ones.

## 4. Write the replay adapter

Open `intersite.adapter.mjs`. Find how this project's tests or seed scripts sign in a test user, and return those
headers from `signIn(actorKind, { other })`. `other: true` must return a user from a different account. Implement
`resolveId` by mapping an ID's prefix to a seeded record of that kind, and `reset` if there is a reseed command.
Never use real user credentials: only seeded test accounts.

Optional: have the server send `Server-Timing: queries;desc=<n>` per request (count queries in the database
wrapper), so `intersite replay --metrics-base` can catch an N+1 before it ships.

## 5. Try the loop locally

In one terminal, keep a collector running:

```bash
npx intersite collector
```

Start the project's dev server, click through a few flows, then:

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

Any key whose kept values look like names, handles or free text goes in `capture.redactKeys`. Show the user this
output; they decide when capture is safe for production.

Set `replay.target` in `intersite.yml` to the dev server's URL if it is not `http://localhost:8787`. Fix adapter
problems until sessions pass or are skipped for a stated reason.

## 6. Report

Tell the user what is wired, what was baselined (counts), which paths are excluded from capture, and what still
needs them: reviewing stored cases before production capture, and choosing where the collector will run.
