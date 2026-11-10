## Testing with Intersite

`npx intersite check` is the definition of done. Run it before saying a change is finished, and fix what it reports.
It prints one line per finding, with the command that reruns just that finding.

- **Never make a check pass by weakening it.** Do not delete, skip or loosen a test, special-case a test's inputs,
  or silence a lint rule. If a test, a replayed case or a rule looks wrong, stop and say so. A real exception goes
  in `intersite.yml` under `gates.acknowledged` with a reason, or on one line as
  `// oxlint-disable-next-line intersite/<rule> -- <why>`, where a reviewer will see it.
- **Fix a bug by reproducing it first.** With a reference from a user or a log, run
  `npx intersite replay --id <ref> --verbose`. Otherwise write the failing test, then the fix. The new test must
  fail without the fix: `npx intersite gate fails-on-base --cmd "<the project's test command>"`.
- **Test through the API, not through mocks.** Do not mock this project's own modules. A test whose assertions
  could not fail is worse than no test.
- **Reuse before writing.** Search for an existing helper first; `duplicates` reports pasted blocks. Do not add a
  dependency for what a few lines do; `new-deps` reports every new one.
- **Name user actions.** A new button, form or clickable element gets `data-intersite="<area>.<verb>"`, such as
  `data-intersite="program.save"`. Keep an existing name when the markup changes: tests find the element by it.
- **Useful commands:** `npx intersite lint --rules` (which rules apply), `npx intersite actions` (user actions seen,
  with error counts), `npx intersite replay --tag error --since 7d` (recent real failures),
  `npx intersite replay --action <name>` (everything a given action did).
