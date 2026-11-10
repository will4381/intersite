---
name: intersite
description: Check a change with Intersite before calling it done. Use whenever you finish editing code in a project that has intersite installed (an intersite.yml, or "intersite" in package.json), when `intersite check` fails, or when the user asks to test, verify or check their change.
---

# Checking a change with Intersite

```bash
npx intersite check
```

This is the definition of done. It runs lint, the gates on your diff, and a replay of real recorded sessions when a
collector is available. Success is one line starting `ok check:`. Each finding is one line; many end with
`| rerun: <command>`, which reruns only that finding.

## Fixing what it reports

| Line starts with | Meaning | Do this |
| --- | --- | --- |
| `path:line:col intersite/<rule>` | A lint rule matched new code | Fix the code as the message says |
| `test-integrity` | A test was deleted, weakened or skipped | Restore it; fix the code instead |
| `duplicates` | You pasted a block that already exists | Import or extract the original, named in the line |
| `similar` | You wrote something that already exists under another name | Reuse the one named in the line; if they differ only in a few values, make one with a variant |
| `naming` | A new file or folder does not follow its neighbours' naming | Rename it to the form the line gives |
| `style-drift` | A new colour or size is almost an existing one | Use the token or value the line names |
| `new-deps` | A dependency was added | Remove it if a few lines of code or the standard library do the job |
| `artifacts` | You left a backup copy, scratch file, log or planning document | Delete it; put anything worth keeping where it belongs |
| `unused` | You added a file or export nothing uses, or orphaned a file | Wire it in or delete it |
| `fails-on-base` | Your new test passes without your fix | Make the test exercise the bug |
| `mutation` | A break on a changed line went unnoticed | Add an assertion that would notice it |
| `FAIL baseline` | The API answered differently from production | Run the rerun command with `--verbose`, then fix the code |
| `FAIL twice` | Repeating a write caused a server error | Make the write safe to repeat |
| `FAIL cross-tenant` | Another account could reach the record | Fix the authorization check |
| `FAIL ui` | A page or named action broke | Run the rerun command with `--headed` to watch |
| `FAIL metrics` | The endpoint now does more work for the same request (`queries 7 → 19`) | Look for a loop that issues one query per item |

## Never make a check pass by weakening it

Do not delete, skip or loosen a test, special-case a test's inputs, edit a baseline by hand, or add a bare
`eslint-disable`. If a check looks wrong, stop and tell the user why. A real exception is recorded where a reviewer
sees it:

- For a gate: add `{ gate: <name>, target: <file or dependency>, why: "<reason>" }` to `gates.acknowledged` in
  `intersite.yml`. The failing line prints the exact entry.
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
