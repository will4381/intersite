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
| contains `"gate": "data-model"` | The schema holds a flaw that grows with the data: a link with no foreign key, one fact in two columns, ids in a list, a name with two types, an index another covers, an enum nothing uses | Do what the line says (add the foreign key, keep the time and read the flag from it, give the link its own table, match the type, drop the index or the enum), or acknowledge why the schema is meant that way |
| contains `"gate": "decisions"` | An environment variable, feature flag or variant dispatch is now decided in three or more files | Read the variable once in the env module and import it; decide the flag once and pass the result; keep per-variant behaviour in one switch or table |
| contains `"gate": "renames"` | You renamed an identifier in code, but its old name is still in strings, comments or docs | Rename those too (log lines, error messages, docs, config keys) |
| contains `"gate": "schema-drift"` | A type restates the keys of a schema (zod, valibot, a Drizzle table) by hand | Derive it from the schema as the line says (`z.infer<typeof X>`, `typeof table.$inferSelect`) and delete the hand-written copy |
| contains `"gate": "regex"` | A pattern that can hang on a crafted input, or a validator written differently elsewhere | Make the repeat's inside unable to match what follows it; import the one validator both sides use |
| contains `"gate": "new-deps"` | A dependency was added | Remove it if a few lines of code or the standard library do the job |
| contains `"gate": "artifacts"` | You left a backup copy, scratch file, log or planning document | Delete it; put anything worth keeping where it belongs |
| contains `"gate": "unused"` | You added a file or export nothing uses, or orphaned a file | Wire it in or delete it |
| contains `"gate": "fails-on-base"` | Your new test does not prove the fix: it passes without it, fails with it too, fails on the base only because it does not compile, load or finish there, or the base failure is in another test | Make the test reach the buggy code through what already exists on the base, so it fails there on its assertion; give a test of a hang its own timeout |
| contains `"gate": "mutation"` | No test noticed a changed function's body removed, an access check, tenant filter, idempotency or state guard or cache invalidation removed, or an operator flipped on a changed line (the line names the mutant and what it protected) | Write a test that fails on that mutant and passes on the real code: for a removed access check or tenant filter, a test where another user or tenant is refused |
| contains `"gate": "coverage"` | A function you added or changed runs in no test | Add a test that calls it and checks what it returns or does |
| contains `"gate": "complexity"` | A function you wrote or grew is too hard to follow (cognitive complexity 25 or more) | Split it into named steps; do not just move its branches into a lookup of closures |
| contains `"gate": "structure"` | Modules or declarations that use each other in a circle, a class field changed from outside the class, or a caller doing a folder's work step by step | Fix the design the line names: decide which module sits below and move what goes against that order, or give the class or folder the one function that does the whole job. Do not hide the use: a dynamic `import()`, a re-export through another file, an `any` or a copy that dodges the circle is weakening the check |
| contains `"gate": "protected"` | You changed protected code (money, access) without changing a test | Add or extend the test that proves the change; do not acknowledge it to get past |
| `typescript/no-unnecessary-condition` | A check the types say can never fail | Decide which side is wrong, one at a time, never in bulk. If the value came through a cast (`as`), a `!`, `JSON.parse`, an untyped response or a library's loose type, the type may be lying: parse it where it enters and keep the check until then. Otherwise the check is dead: delete it |
| `intersite/drizzle-nullable-first-column` | A table's first column can be null, so a left join reads real rows as missing | Move the primary key (or another NOT NULL column) first; if a key-sorting rule fights it, exempt table definitions from that rule |
| `intersite/require-comment-tag`, `intersite/no-alibi-comment` | A comment explains or defends code instead of the code saying it | Reshape first: a clearer name, an extracted function, a type that rules the case out, or a test that fails when the line is removed. Tag it only when none of those can say it |
| `<name>: failed with exit N \| rerun: <command>` | One of the project's own checks failed; its output is printed above the line | Run the rerun command, fix what it reports |
| `skip <names>: slow, run with …` | Slow checks this change touches did not run | Run `npx intersite check --full` before calling the change done |
| `upgrade intersite: <tag> is out …` | A newer Intersite release is tagged than the one installed | Tell the user, with the command the line gives; upgrade only if they agree, then run `npx intersite init` |
| `skip gates:` / `skip replay:` | That stage could not run here (no git, no adapter, no server answering) | Nothing to fix; say so if the change needed it |
| `FAIL baseline` | The API answered differently from production, or a server error production recorded still happens | Run the rerun command with `--verbose`, then fix the code |
| `FAIL twice` | Repeating a write caused a server error, or a repeated PUT, DELETE, webhook or keyed write changed the state again | Make the write safe to repeat: dedupe on the event or idempotency key |
| `FAIL race` | The same webhook or idempotent write sent twice at once failed or created two records | Enforce the dedupe in the database (a unique constraint on the event or key, an upsert), not a check-then-insert |
| `FAIL cross-tenant` | Another account could reach the record, or its list showed a record this session created | Fix the authorization check; if the record is public by design (a marketplace listing, a network program), add the entry the line gives to `replay.crossTenantIgnore` with the reason |
| `FAIL ui` | A page or named action broke | Run the rerun command with `--headed` to watch |
| `FAIL contract` | One route's requests or answers break a convention the rest of the API keeps, or carry something that should not be sent | Make the route match the API as the line says; if the difference is deliberate, add the entry the line gives to `replay.contractIgnore` with the reason |
| `FAIL snapshot` | A response's status or a value changed since the `--snapshot-out` run (`/items/0/total 1999 → 2199`) | If the change was not meant to alter it, fix the code or data change; if it was, write a new snapshot |
| `FAIL metrics` | The endpoint now does more work for the same request (`queries 7 → 19`) | Look for a loop that issues one query per item |

## Never make a check pass by weakening it

Do not delete, skip or loosen a test, special-case a test's inputs, edit a baseline by hand, or add a bare
`eslint-disable`. If a check looks wrong, stop and tell the user why. If the same finding is still there after three
honest attempts, stop and report it as a conflict for a human instead of trying another way around the check. A real
exception is recorded where a reviewer sees it:

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

```bash
npx intersite flow --concurrency 4
```

After a UI change, play the browser flows in `.intersite/flows/`. A journey that broke in production becomes one with
`npx intersite flow --from <ref>`. To add one by hand, write `{ "steps": [...] }` with steps such as
`{ "open": "/ads/new" }`, `{ "fill": { "title": "Spring" } }`, `{ "click": "ad.save", "expect": "POST /api/ads 201" }`
and `{ "see": "Spring" }`; a click names a `data-intersite` value.

`npx intersite lint --rules` lists the rules that apply here. `npx intersite check --skip replay` skips the replay.

## Related skills

- `intersite-bug` when fixing a bug.
- `intersite-rule` when the same mistake should never be written again.
- `intersite-setup` when the project is not wired up yet.
