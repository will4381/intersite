# Intersite

This repository is held to its own rules. Read [CONTRACT.md](CONTRACT.md) before changing anything: it fixes the
formats every part agrees on and the code rules. Analysis (every gate's reading and judging, search, twins, trace
reports) is Rust in `core/`, with whatever crates it needs; Node (`.mjs` with JSDoc, one runtime dependency) runs git,
reads config, starts processes and prints, and stays JavaScript only where it must: the CLI entry, the oxlint rule
plugins, the capture and track SDKs that run inside projects, the Cloudflare collector, and replay, whose adapters are
the project's JavaScript.

- In this repository `npx intersite` is `node bin/intersite.mjs`. Run `npm test` (it runs `cargo test` too) and
  `npm run check` before calling a change done; both must pass. CI runs the same two commands.
- Keep it lean: the minimum code that works, no abstraction with one user, no option nobody asked for. A deliberate
  shortcut gets a `// ponytail: <ceiling>, <upgrade path>` comment.
- A new or changed lint rule needs `bad` and `good` examples, and is tuned on real code before it ships: a rule
  that fires on reasonable code teaches people to suppress it.
- A bug fix comes with a test that fails without it.
- CLI output is read by agents: one line on success, one line per finding with the command that reruns it.

<!-- intersite:start -->
## Testing with Intersite

`npx intersite check` is the definition of done. Run it before saying a change is finished, and fix what it reports.
It prints one line per finding, with the command that reruns just that finding.

- **Never make a check pass by weakening it.** Do not delete, skip or loosen a test, special-case a test's inputs,
  or silence a lint rule. If a test, a replayed case or a rule looks wrong, stop and say so, and if the same finding
  is still there after three honest attempts, stop and report it as a conflict for a human. A real exception goes
  in `intersite.yml` under `gates.acknowledged` with a reason, for one change only as a commit trailer
  `Intersite-Ack: <gate>: <why>`, or on one line as
  `// oxlint-disable-next-line intersite/<rule> -- <why>`, where a reviewer will see it. Security and test rules
  cannot be waived in a comment: fix the code.
- **Fix a bug by reproducing it first.** With a reference from a user or a log, run
  `npx intersite replay --id <ref> --verbose`. Otherwise write the failing test, then the fix. The new test must
  fail without the fix: `npx intersite gate fails-on-base --cmd "<the project's test command>"`.
- **Test through the API, not through mocks.** Do not mock this project's own modules. A test whose assertions
  could not fail is worse than no test.
- **Reuse before writing.** Search for an existing helper first: `npx intersite search <file>:<line>` (or code on
  stdin with `-`) lists the functions that already contain those lines, and `npx intersite twins <file>:<line>` the
  ones that do the same job in different code. `duplicates` and `similar` report pasted and rewritten copies. Do not
  add a dependency for what a few lines do; `new-deps` reports every new one.
- **Keep code deep and direct.** Fewer, deeper modules with small interfaces; check data once where it comes in,
  then trust its type; write one-off logic where it is used instead of a helper called once; no try/catch unless
  something can be done about the error there. Derive types from schemas (`z.infer`), and read each environment
  variable or flag in one place.
- **Measure before shipping.** `npx intersite trace --base main -- <test command>` shows every function a run touched
  and where the time went, and fails on what got slower than main. A server's requests:
  `npx intersite trace --server "<dev command>" --url <origin> --request "GET /path"` (or `--replay` for recorded
  sessions); a page: `npx intersite trace --page <url>`. Use `--runs 5` or more before claiming a speed-up: a
  difference whose run ranges overlap is noise, and trace says so. With `INTERSITE_DATABASE_URL` set (a dev database, never
  production) it lists the queries the run sent, slowest first, with the index each needs, and `sql` plans new queries.
- **Name user actions.** A new button, form or clickable element gets `data-intersite="<area>.<verb>"`, such as
  `data-intersite="program.save"`. Keep an existing name when the markup changes: tests find the element by it.
- **Useful commands:** `npx intersite lint --rules` (which rules apply), `npx intersite actions` (user actions seen,
  with error counts), `npx intersite replay --tag error --since 7d` (recent real failures),
  `npx intersite replay --action <name>` (everything a given action did).
<!-- intersite:end -->
