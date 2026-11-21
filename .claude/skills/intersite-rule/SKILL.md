---
name: intersite-rule
description: Add an Intersite lint rule so a mistake can never be written again. Use when the user says "add a rule", "ban this pattern", "make sure this never happens again", after fixing a bug caused by a code pattern, or when a review keeps flagging the same thing.
---

# Adding a lint rule

A rule is one YAML entry: a syntax-tree selector, a message, and examples. No code.

## 1. Add it to `lint.custom` in `intersite.yml`

```yaml
lint:
  custom:
    - id: no-raw-fetch
      selector: CallExpression[callee.name='fetch']
      message: Call the API through apiClient so errors and auth are handled. Import it from src/api/client.
      files: [src/**]
      bad:
        - fetch('/v1/things')
      good:
        - apiClient.get('/v1/things')
```

- `selector` uses ESLint selector syntax over the syntax tree: `CallExpression`, `MemberExpression`, `Identifier`,
  `JSXOpeningElement`, `TSAsExpression`, with attribute tests such as `[callee.property.name='then']`, regular
  expressions such as `[name=/^tmp/]`, and `:not()`, `:has()`, `>` and descendant combinators.
- For a rule about comments, use `comment: <regular expression>` instead of `selector`; it is tested against the
  first line of every comment, ignoring case. `unless: <regular expression>` exempts a comment it matches.
- `message` says what to do instead, not only what is wrong. An agent will read it and act on it.
- `files` limits the rule to path globs. Leave it out to apply everywhere.
- `ignore` exempts path globs, such as the one file allowed to do what the rule bans.
- Make the selector narrow. A rule that fires on reasonable code teaches people to suppress it.

## 2. Check it

```bash
npx intersite lint
```

A new rule usually matches existing code. Fix those places if there are few. If there are many, and the new rule's
are the only findings listed, record them so only new ones fail (this records every current finding), and say so in
your summary:

```bash
npx intersite lint --write=init
```

## 3. When a selector cannot express it

Rules that need logic (counting, comparing two nodes, reading comments) are code rules in the Intersite package
itself: `lint/rules/<id>.mjs` exporting `{ id, pack, rule, bad, good }`. Propose that to the user instead of forcing
a selector.

## Sharing a rule across projects

Move the entry from `lint.custom` into the Intersite package's `lint/packs/` folder (Swift rules: `lint/swift/rules.yml`) with a `pack`. Its test suite
fails unless every `bad` example is reported and no `good` example is.
