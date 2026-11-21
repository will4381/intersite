---
name: intersite-bug
description: Fix a bug the Intersite way - reproduce it first from the recorded production request, then fix, then prove the test catches it. Use when the user reports a bug, pastes an error or a request ID ("Ref"), asks why something failed in production, or asks for a bug fix in a project that has intersite installed.
---

# Fixing a bug with Intersite

Reproduce first. A fix written without a reproduction is a guess.

## 1. Find the recorded failure

With a request ID from the user, an error page or a log:

```bash
npx intersite replay --id <request-id> --verbose
```

Without one, look at what has been failing:

```bash
npx intersite actions
```

```bash
npx intersite replay --tag error --since 7d --verbose
```

`--verbose` prints the request that was sent and the answer received under each `FAIL` line. A replay that fails
the same way production did is your reproduction: a recorded server error that happens again reads
`still fails as production did`, and passes once it no longer answers 5xx. Keep it from expiring while you work:

```bash
npx intersite pin <request-id>
```

## 2. If the replay passes or is skipped

The bug depends on data the local database does not have. Read the recorded requests, scrubbed, as production saw
them:

```bash
npx intersite replay --id <request-id> --json --verbose
```

`recorded` holds the session's cases up to that request. Write a test through the API that sets up that state and
fails. Do not mock this project's own modules.

## 3. Map the blast radius, then fix the root cause

Before editing, find what depends on the code you are about to change, including what a text search misses:

```bash
npx intersite trace --touched -- <the failing test or script>
```

```bash
npx intersite search <file>:<line>
```

`trace --touched` lists every function the reproduction ran; `search` finds code shaped like the function you will
change, which may carry the same bug. Also check what the compiler cannot see: database columns the code writes, JSON
fields other services read, environment variables and flags. Name the one fact that makes the fix safe ("every
caller passes cents") and check it, with a test or a query, instead of assuming it.

Fix it once, where all callers route through, not only on the path the report names.

## 4. Prove it

```bash
npx intersite replay --id <request-id>
```

```bash
npx intersite gate fails-on-base --cmd "npm test"
```

`fails-on-base` runs your new or changed tests against the code before your fix; they must fail there. Use the
project's test command; with `gates.testCmd` set in `intersite.yml`, `--cmd` can be left out, and
`npx intersite check --full` runs it on its own whenever the branch name or a commit message says fix. Then:

```bash
npx intersite check --full
```

## 5. Stop it coming back

If the bug was a pattern that could be written again elsewhere, add a lint rule for it with the `intersite-rule`
skill. Say in your summary what reproduced the bug, what the root cause was, and what now catches it.
