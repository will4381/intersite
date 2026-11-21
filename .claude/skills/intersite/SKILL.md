---
name: intersite
description: Check a change with Intersite before calling it done. Use whenever you finish editing code in a project that has intersite installed (an intersite.yml, or "intersite" in package.json), when `intersite check` fails, or when the user asks to test, verify or check their change.
---

# Checking a change with Intersite

```bash
npx intersite check
```

This is the definition of done; when it prints `skip …: slow, run with \`intersite check --full\``, run that before
saying a change is finished. It runs lint, the gates on your diff, the project's own checks, and a replay of real recorded sessions when the
project's server is running. Success is one line starting `ok check:`, after any `skip …:` lines that say what did
not run and why. Each finding is one line: a gate's carries `| to accept: add { "gate": "<name>", … }`, which names
the gate; a replay failure ends with `| rerun: <command>`, which reruns only that case. Replay is experimental: rerun a failure
with `--verbose` first, and if the request it sent or its comparison is what looks wrong, not the server, say so
instead of changing code to satisfy it.

## Fixing what it reports

| Line | Meaning | Do this |
| --- | --- | --- |
| `path:line:col <rule> <message>` | A lint rule matched new code | Fix the code as the message says |
| `path <rule>: N findings, baseline allows M` | Old findings were fixed | Lower the baseline with `npx intersite lint --write` |
| contains `"gate": "test-integrity"` | A test was deleted, weakened or skipped | Restore it; fix the code instead |
| contains `"gate": "duplicates"` | You pasted a block that already exists | Import or extract the original, named in the line |
| contains `"gate": "similar"` | You wrote something that already exists under another name, or pasted a helper's body (`repeats … (N% of it)`) | Reuse the one named in the line; if they differ only in a few values, make one with a variant; for a pasted body, call the helper, or extract the part they share |
| contains `"gate": "naming"` | A new file or folder does not follow its neighbours' naming | Rename it to the form the line gives |
| contains `"gate": "style-drift"` | A new colour or size is almost an existing one | Use the token or value the line names |
| contains `"gate": "value-drift"` | Copy states a fee or price the code's constant does not hold | Find out which is right; render the copy from the constant so they cannot drift again |
| contains `"gate": "sql"` | A migration that locks or breaks a live table, a slow or wrong query, or a query per loop item | Do what the line says (`CONCURRENTLY`, `NOT VALID` then `VALIDATE`, a default, fetch before the loop); if a loop's sequential queries are deliberate, say why with `// oxlint-disable-next-line no-await-in-loop -- <why>` |
| contains `"gate": "decisions"` | An environment variable, feature flag or variant dispatch is now decided in three or more files | Read the variable once in the env module and import it; decide the flag once and pass the result; keep per-variant behaviour in one switch or table |
| contains `"gate": "renames"` | You renamed an identifier in code, but its old name is still in strings, comments or docs | Rename those too (log lines, error messages, docs, config keys) |
| contains `"gate": "schema-drift"` | A type restates the keys of a schema (zod, valibot, a Drizzle table) by hand | Derive it from the schema as the line says (`z.infer<typeof X>`, `typeof table.$inferSelect`) and delete the hand-written copy |
| contains `"gate": "regex"` | A pattern that can hang on a crafted input, or a validator written differently elsewhere | Make the repeat's inside unable to match what follows it; import the one validator both sides use |
| contains `"gate": "new-deps"` | A dependency was added | Remove it if a few lines of code or the standard library do the job |
| contains `"gate": "artifacts"` | You left a backup copy, scratch file, log or planning document | Delete it; put anything worth keeping where it belongs |
| contains `"gate": "unused"` | You added a file or export nothing uses, or orphaned a file | Wire it in or delete it |
| contains `"gate": "fails-on-base"` | Your new test passes without your fix | Make the test exercise the bug |
| contains `"gate": "mutation"` | A break on a changed line went unnoticed | Add an assertion that would notice it |
| contains `"gate": "protected"` | You changed protected code (money, access) without changing a test | Add or extend the test that proves the change; do not acknowledge it to get past |
| `intersite/require-comment-tag`, `intersite/no-alibi-comment` | A comment explains or defends code instead of the code saying it | Reshape first: a clearer name, an extracted function, a type that rules the case out, or a test that fails when the line is removed. Tag it only when none of those can say it |
| `<name>: failed with exit N \| rerun: <command>` | One of the project's own checks failed; its output is printed above the line | Run the rerun command, fix what it reports |
| `skip <names>: slow, run with …` | Slow checks this change touches did not run | Run `npx intersite check --full` before calling the change done |
| `upgrade intersite: <tag> is out …` | A newer Intersite release is tagged than the one installed | Tell the user, with the command the line gives; upgrade only if they agree, then run `npx intersite init` |
| `skip gates:` / `skip replay:` | That stage could not run here (no git, no adapter, no server answering) | Nothing to fix; say so if the change needed it |
| `FAIL baseline` | The API answered differently from production, or a server error production recorded still happens | Run the rerun command with `--verbose`, then fix the code |
| `FAIL twice` | Repeating a write caused a server error | Make the write safe to repeat |
| `FAIL cross-tenant` | Another account could reach the record, or its list showed a record this session created | Fix the authorization check; if the record is public by design (a marketplace listing, a network program), add the entry the line gives to `replay.crossTenantIgnore` with the reason |
| `FAIL ui` | A page or named action broke | Run the rerun command with `--headed` to watch |
| `FAIL contract` | One route's requests or answers break a convention the rest of the API keeps, or carry something that should not be sent | Make the route match the API as the line says; if the difference is deliberate, add the entry the line gives to `replay.contractIgnore` with the reason |
| `FAIL snapshot` | A response's status or a value changed since the `--snapshot-out` run (`/items/0/total 1999 → 2199`) | If the change was not meant to alter it, fix the code or data change; if it was, write a new snapshot |
| `FAIL metrics` | The endpoint now does more work for the same request (`queries 7 → 19`) | Look for a loop that issues one query per item |

## Never make a check pass by weakening it

Do not delete, skip or loosen a test, special-case a test's inputs, edit a baseline by hand, or add a bare
`eslint-disable`. If a check looks wrong, stop and tell the user why. A real exception is recorded where a reviewer
sees it:

- For a gate: add `{ gate: <name>, target: <file or dependency>, why: "<reason>" }` to `gates.acknowledged` in
  `intersite.yml`. The failing line prints the exact entry. When the exception is about this change and not the
  file forever (a protected path changed by a rename, say), put `Intersite-Ack: <gate>: <why>` in a commit message
  instead.
- For a lint rule: `// oxlint-disable-next-line intersite/<rule> -- <why>` on the line above (in Swift:
  `// swiftlint:disable:next <id> -- <why>`).
- After fixing existing findings, lower the baseline with `npx intersite lint --write`.

## Faster loops while working

```bash
npx intersite lint src/changed-file.ts
```

```bash
npx intersite gate duplicates
```

```bash
npx intersite replay --action program.save --verbose
```

`npx intersite lint --rules` lists the rules that apply here. `npx intersite check --skip replay` skips the replay.

## Related skills

- `intersite-bug` when fixing a bug.
- `intersite-rule` when the same mistake should never be written again.
- `intersite-setup` when the project is not wired up yet.
