# Intersite

One testing library for every project. It stops agents shipping slop and tests that prove nothing, and it turns real
user sessions into tests nobody has to write.

## Quickstart

```bash
npm i -D github:will4381/intersite#v1.0.0-rc.24 oxlint @oxlint/plugins
```

```bash
npx intersite init
```

```bash
npx intersite check
```

`init` writes the config, the agent rules and skills, and records today's lint findings so only new ones fail.
Beside your code Intersite keeps one file, `intersite.yml`. Everything else it writes goes in `.intersite/`, whose own
`.gitignore` commits only the baseline (`.intersite/baseline.json`) and the replay adapter (`.intersite/adapter.mjs`)
and keeps the rest (recorded cases, the run ledger, generated oxlint configs) out of git. A project set up by an
older version gets its baselines and adapter moved there by `npx intersite init`.

The gates' analysis runs in Intersite's Rust engine, which builds itself with cargo the first time a check needs it
(a minute or two, once), so install Rust first: `curl https://sh.rustup.rs -sSf | sh`.
`check` is the one command to run before calling a change done. Lint and the gates work from this point with no
further setup. To add capture and replay (experimental), ask your agent to "set up intersite"; the `intersite-setup` skill walks it
through the wiring.

For lint and gates only, run `npx intersite init --no-replay`, or put `replay: false` in `intersite.yml`: `check` then
runs no replay stage, and `init` writes no adapter and no replay skill.

In a monorepo, install `intersite`, `oxlint` and `@oxlint/plugins` once at the repository root. A package with its own
`intersite.yml` finds them from there, so a package with no `node_modules` of its own needs nothing installed in it.

## What `check` runs

| Stage | Catches | Needs |
| --- | --- | --- |
| `lint` | Slop and tests that cannot fail, on top of your own oxlint config (`lint.ownRules: false` reports only the rules Intersite adds, for a project that already gates its own) | nothing |
| `test-integrity` | A test deleted, weakened, skipped, focused with `.only` or inverted with `it.fails` to get green | git |
| `tamper` | The checks loosened instead of the code fixed: a strict type option turned off, a lint rule downgraded or a path ignored, a gate or lint pack dropped, a baseline grown, a test runner told to skip files, pass with no tests, retry or accept lower coverage, a CI step that ran the checks removed or allowed to fail, coverage-ignore pragmas | git |
| `special-case` | Production code that answers the tests instead of solving the problem: a branch on running under a test runner, or a branch on a changed test's own input that returns exactly what that test expects | git |
| `duplicates` | A pasted block that already exists in the repository | git |
| `new-deps` | A dependency added without saying why; one npm has never heard of (an invented name anyone could register later) is named as such, and a days-old one says so | git |
| `similar` | A new function, component, hook or type that already exists under another name; when two differ only in a few literals it says to make one with a variant. Also a helper's body pasted inside a new function | git |
| `naming` | A file or folder named against the casing, suffix or test pattern its siblings keep, or unlike its main export | git |
| `style-drift` | A colour, size or token that is almost one the project already has, or off a scale it keeps closed | git |
| `value-drift` | Copy, an API description or a comment that states a fee, rate or price ("1.5% + $0.30 per payment") the constant of the same name no longer holds, or one money rate set to two values in two files | git |
| `sql` | SQL that locks or breaks a live table (`NOT NULL` with no default, an index built without `CONCURRENTLY`, a dropped column), a foreign key with no index or of a different type than the key it points at, UUIDs stored as text (SQL and Prisma), slow or wrong queries (`LIKE '%x'`, `OFFSET` paging, `NOT IN` a subquery, `UPDATE` with no `WHERE`), and queries run once per loop item. Data deletion: `TRUNCATE`, a Supabase `.delete()` with no filter, `DELETE` without `WHERE` in a migration, and `prisma migrate reset`, `db push --accept-data-loss` or `DROP DATABASE` added to a build, start or deploy script, a Dockerfile or CI. On Supabase, a public table without row level security and a policy that lets anyone change every row. With `INTERSITE_DATABASE_URL`, new queries are planned against that database and a scan of a big table names the index to add | git |
| `columns` | A column the change adds that no code writes (it stays NULL), a table nothing uses, a table or column the code names that the schema does not have (raw SQL, Supabase strings, Prisma and Drizzle keys: "did you mean name?"), and removing the last write of a column. With `--all`, every nullable column nothing writes and every table nothing uses, for cleanup | git |
| `data-model` | A flaw in the data model the schemas declare, of the kind that gets dearer with every row. Fails on: a column that names another table with no foreign key, one name with two types across tables, an index another already covers, a timestamp without its zone, money in a float, a table with no primary key. Suggests, and fails nothing: a flag beside the time it was set or beside the status that says the same (one fact, two columns), a list of ids in one column, two tables with the same columns, an enum no column has, a JSON column with no declared shape where the schema declares others. With `INTERSITE_DATABASE_URL` and `--all` it also reads the planner's statistics (never a row) and suggests: a column nothing has ever filled, a column with one value in every row, a text column with a handful of values that an enum or a CHECK would hold | git |
| `states` | Code and schema disagreeing on a status: a value written to or tested against a column that its enum or CHECK does not allow (the database refuses the write, the test is never true; Prisma's name for a value written where SQL holds the stored one). Suggests, and fails nothing, when a rule about statuses is written in many places: one list of statuses tested in three or more files, one change of status written in four or more functions | git |
| `regex` | A regular expression whose backtracking can hang the process on a crafted input, and an email, phone, UUID or URL validator written differently in two places | git |
| `decisions` | One decision made in several files: an environment variable read in three or more files outside the env module, a feature flag checked in three or more, or a dispatch over the same `kind`/`type` values repeated in three or more (per package) | git |
| `renames` | An identifier renamed in code whose old name is still written in strings, comments or docs | git |
| `schema-drift` | An interface or object type that restates the keys of a zod, valibot, yup or TypeBox schema or a Drizzle table by hand, with the derived type to write instead | git |
| `routes` | A link, navigation or API call to a path no page or route of the app answers (`/auth/signup` when the page is `/signup`), or a call with a method the route does not handle (`POST` to a route that exports only `GET`). Reads Next.js, React Router and Remix, SvelteKit, Nuxt and Astro routes, and Express, Hono and Fastify handlers | git |
| `env` | A read of an environment variable the project's `.env.example` (or env schema) does not list: a typo (`STRIPE_WEBHOOK_SECRT`, with the name it probably meant) or a variable the deploy will not know to set | git |
| `secrets` | A credential added to any file (config, workflow, docs, env file): an API key or token with a known format, a private key, a database URL with its password, a Supabase service-role key, or a committed `.env` holding a real secret. The secret is never printed | git |
| `auth` | An endpoint (route handler, server action, loader, tRPC procedure, Convex function, Express/Hono/Fastify route) that never checks who is calling, where most of its kind in the package do. The convention is read from the project; sign-in, webhook, health and cron paths are public | git |
| `structure` | Code whose parts know each other in ways that make it hard to read (after [deslop-please](https://github.com/deterministic-machines/deslop-please) and *A Philosophy of Software Design*): folders or files side by side that call each other in a circle (`module-cycle`), declarations in a circle a folder cycle cannot show (`tangle`), a class field changed from outside the class (`field-leak`), and one caller working through more than 7 of a folder's functions on one type, step by step (`shallow-module`). Runtime uses only: type imports order nothing | git |
| `artifacts` | Leftovers: backup and `_v2` copies, scratch scripts, logs, stray `PLAN.md` and `SUMMARY.md` files | git |
| `unused` | A file or export this change added that nothing uses, or a file it orphaned | git |
| `imports` | An import of something that is not there: a file that does not exist (or only under another case, which macOS forgives and Linux does not), a name the module does not export, or a package no package.json declares and nothing installed provides, the shape of an invented one. Also unchanged imports the change broke by deleting, moving or un-exporting what they named | git |
| `boundaries` | A relative import into another workspace package, a workspace package used without being declared, a new barrel file (unless the project keeps barrels), server-only code (a database driver, a secret read at load) pulled into a `"use client"` module, and, when configured, an import against `gates.layers` or between `gates.features` | git |
| `complexity` | A function this change made hard to follow: cognitive complexity 25 or more, new or grown by 10 or more | git |
| `protected` | A change to paths you marked as protected (money, access) with no test changed alongside | git and a `gates.protected` rule |
| your `checks` | Whatever the project already runs: its tests, generated-file checks, a model checker, a bundle budget | a `checks` entry |
| `replay` (experimental) | An API that now answers real recorded sessions differently | capture and an adapter |

When a newer Intersite release is tagged, `check` says so on one line with the command to upgrade (looked up at most
once a day, never in CI; `INTERSITE_NO_UPDATE_CHECK=1` turns it off).

`gates.base` defaults to `origin/main` and falls back to `main` or `master`; a repository with no commits compares
against an empty tree, and outside git `check` skips the gates.

In a monorepo, put `intersite.yml` in the app's folder: its `check` judges only that folder's changes, names files
relative to it, and still reports a copy of code that lives in a shared package. A root config skips folders that
have their own.

Three more gates run the tests and are opt-in through `gates.run`: `fails-on-base` (a bug fix's new test must pass
with the fix and fail without it on a test's own verdict: a test that only fails to compile, load or finish on the
base proves nothing), `mutation` (a changed function's body removed, an access check, tenant filter, idempotency or
state guard or cache invalidation removed, or an operator flipped on a changed line, must make a test fail; a mutant
that only breaks the build is invalid, not killed) and `coverage` (every function the change added or edited must run
in some test). `check` runs the gates that only read side by side, about five times faster on a large repository. With `gates.testCmd`
set, `check --full` adds `fails-on-base` on its own when the branch name or a commit message since the base says
fix, bug, hotfix or regression.

### Your own checks in the same run

List the commands the project already has under `checks`, and `intersite check` becomes the one command that runs
everything, in order of cost, with one result line:

```yaml
checks:
  - { name: generated, run: npm run generate:check, when: ["src/api/**"] }
  - { name: specs, run: node scripts/specs.mjs, when: ["specs/**", "src/billing/**"] }
  - { name: api, run: npm run test:api, cwd: backend, when: ["backend/**"], slow: true }
```

A check runs only when the change touches its `when` paths (always, with no `when`). A passing check prints nothing;
a failing one prints the end of its output and the command that reruns it. `slow` checks wait for `--full`:

| Command | Runs |
| --- | --- |
| `intersite check` | Lint, the gates, and the fast checks this change touches: for a pre-push hook |
| `intersite check --full` | The same plus the slow checks this change touches: before calling a change done, and in CI |
| `intersite check --all` | Every check, and the gates over the whole repository instead of the change |

### Protected paths

```yaml
gates:
  protected:
    - { paths: ["src/billing/**", "src/auth/**"], why: "money and access change with a test" }
    - { paths: ["src/api/**"], needs: ["openapi.json"] }
```

A change that touches `paths` fails unless it also changes a file under `needs` (by default a test).

### The whole repository, not only the change

`duplicates`, `similar`, `unused`, `naming`, `style-drift`, `value-drift`, `sql`, `regex`, `decisions`, `schema-drift`, `artifacts`, `imports`, `boundaries`, `columns`, `data-model`, `states`, `complexity`, `routes`, `env`, `secrets` and `auth` judge a change. `--all` points them at
every file; record what is there today and only new findings fail, as with lint:

```bash
npx intersite gate duplicates --all --write
```

That records them in `.intersite/baseline.json`. Fix a recorded finding and run it again to lower the count. With `--all`, `sql` treats migrations already written as history: it judges the schema they leave and the queries in code, not the locks a past migration took.

Output is written for agents: one line on success, one line per finding with the command that reruns only that
finding, exit code 0, 1 or 2.

## Commands

| Command | Does |
| --- | --- |
| `intersite init` | Sets a project up; safe to run again after upgrading. `--no-replay` sets up lint and gates only |
| `intersite check [--base <ref>] [--skip <stage>] [--full] [--all] [--json]` | Runs every stage that applies; one line on success. `--full` adds slow checks, `--all` covers the whole repository, `--json` prints one object with every stage's findings. In GitHub Actions each finding prints as an annotation, so it shows on the pull request |
| `intersite stats [--json]` | Per gate and lint rule, the findings `check` raised on this machine, and how many were fixed or acknowledged: a check people mostly acknowledge needs fixing |
| `intersite lint [paths] [--write] [--rules]` | Lints; `--write` lowers the baseline; `--rules` lists what applies |
| `intersite gate <name> [--base <ref>] [--all [--write]]` | Runs one gate against the diff, or with `--all` the whole repository; `--write` records today's findings |
| `intersite search <file>[:<line>[-<line>]] \| - [--max <n>]` | Finds the functions that already contain this code, renamed or reordered |
| `intersite twins [<file>:<line>] [--all]` | Finds functions that do the same job in different code, by the names, calls and fields they use |
| `intersite trace [--base <ref>] [--runs <n>] -- <command>` | Every function a test or script touched and where its time went; with `--base`, what got slower. `--server "<cmd>" --url <origin> --request "GET /x"` (or `--replay`) measures each request to a server, `--page <url>` a page in Chrome (web vitals, JS run, CPU) |
| `intersite collector` | Runs the local collector (SQLite file in `.intersite/`) |
| `intersite replay [--id] [--tag] [--action] [--sample] [--mode] [--verbose] [--metrics-out] [--metrics-base] [--snapshot-out] [--snapshot-base] [--openapi]` | Replays recorded sessions against a local server (experimental) |
| `intersite flow [<file>...] [--concurrency] [--network] [--timing]` / `--from <caseId>` | Plays JSON browser flows in one shared browser, or writes a recorded session as one (experimental) |
| `intersite actions` | Lists named user actions seen, with error counts |
| `intersite audit` | Lists every value capture kept, per key, so personal data that slipped through is easy to spot |
| `intersite pin <id>` | Keeps a recorded case from expiring |
| `intersite deploy [--dry-run]` | Deploys the collector to Cloudflare (Worker and D1) |
| `intersite hook` | Claude Code's edit hook (`init` installs it): blocks an Edit or Write that loosens a check or removes, weakens or skips a test, before it lands |

## Agent skills

`init` installs these into `.claude/skills/` and adds a short rules block to `AGENTS.md`, both at the repository top, so a monorepo with an `intersite.yml` per package gets one copy. It also adds `intersite hook` to `.claude/settings.json` as a `PreToolUse` hook for Edit, Write and MultiEdit, keeping the hooks already there: an edit that would turn a check off or take tests away is blocked with the reason, and the agent is told to fix the code or stop and ask.

| Skill | Used when |
| --- | --- |
| `intersite` | Finishing any change; reading and fixing what `check` reports |
| `intersite-bug` | Fixing a bug: reproduce from the recorded request, fix, prove the test catches it |
| `intersite-rule` | Turning a mistake into a lint rule so it cannot be written again |
| `intersite-setup` | Wiring capture, named actions and the replay adapter into a project |

## Config

Everything has a default, so `intersite.yml` only holds what differs, and every command works with no file at
all. `intersite.schema.json` documents every field and gives editor completion.

```yaml
# yaml-language-server: $schema=./node_modules/intersite/intersite.schema.json
project: acme

lint:
  packs: [tests, slop, security, state, types, validation, actions]   # this list replaces the defaults
  custom:
    - id: no-raw-fetch
      selector: CallExpression[callee.name='fetch']
      message: Call the API through apiClient so errors and auth are handled.
      files: [src/**]

gates:
  base: origin/main
  testCmd: npm test
  run: [test-integrity, duplicates, new-deps, artifacts, unused, fails-on-base]
  acknowledged:
    - { gate: new-deps, target: zod, why: "validates every request body" }

capture:
  exclude: [/webhooks/**]
  redactKeys: [nickname]
  keepKeys: [sortBy]

replay:
  target: http://localhost:8787
  modes: [baseline, twice, cross-tenant]
  crossTenantIgnore:
    - { route: "GET /v1/programs/:id", why: "network programs are public by design" }
```

Some gates also make suggestions: a line that starts `suggestion:`, printed after the findings. A suggestion is worth
doing and is the owner's call (a matter of design, a tidying, a reading of the data), so it never fails a check; on a
pull request it is a notice. Acknowledge one to stop seeing it.

A deliberate exception is always written down where a reviewer sees it: `gates.acknowledged` for a gate, an
`Intersite-Ack: <gate>: <why>` commit trailer for a gate in one change only, or
`// oxlint-disable-next-line intersite/<rule> -- <why>` for a lint rule.

## Lint rules

A rule is one YAML entry: a syntax-tree `selector` (or a `comment` pattern, for rules about comments), a message
that says what to do instead, and examples.

**Type-aware rules.** `lint.typeAware: true` also runs oxlint's type-aware rules: promises nobody awaits
(`typescript/no-floating-promises`, `no-misused-promises`, `await-thenable`), a `switch` over a union that misses a
member (`switch-exhaustiveness-check`), a cast to the type a value already has (`no-unnecessary-type-assertion`), a
check that can never fail because the type already rules it out, such as data checked where it came in and checked
again inside (`no-unnecessary-condition`), a returned promise not awaited inside `try`, which skips the `catch`
(`return-await`), a cast to a narrower type with nothing checked (`no-unsafe-type-assertion`), a throw of something
that is not an `Error` (`only-throw-error`), and a `.catch` callback that types its error `any`
(`use-unknown-in-catch-callback-variable`). `no-unnecessary-condition` runs only when every `tsconfig.json` in the project sets `strict` and
`noUncheckedIndexedAccess`: without the second, `rows[0]` and `const [row] = rows` count as always present, so the
check guarding a missing row would be called unnecessary. Lint prints a note naming the tsconfig when it leaves the
rule out. It needs the
`oxlint-tsgolint` package and a `tsconfig.json`, and it is slower than plain lint, so it is off by default.

**Different rules per folder.** Keep one `.oxlintrc.json` and scope rules with `overrides`. An override takes
`excludeFiles`, so app rules can leave tests and scripts out without those folders switching each rule off:

```json
{ "overrides": [{ "files": ["**"], "excludeFiles": ["tests/**", "e2e/**", "scripts/**"], "rules": { "no-console": "error" } }] }
```

- For one project: add it to `lint.custom` in `intersite.yml`. `files` limits it to path globs and `ignore` exempts some.
- For every project: add it to a file in [lint/packs/](lint/packs/) with a `pack`, `bad` and `good` examples. The
  test suite fails unless every `bad` example is reported and no `good` one is.
- A rule can leave out kinds of file with `skip: [tests]`, `[generated]` or both, and skip files that cannot match
  with `needs: '<regex the source must contain>'`.
- When a selector cannot express it: `lint/rules/<id>.mjs`, listed in `lint/rules/index.mjs`.

| Pack | Default | Catches |
| --- | --- | --- |
| `tests` | on | Tests that cannot fail: no assertion, constant or mock-only assertions, skips, module mocking; an expected value computed by the function under test; tests that only check something did not happen, with no test beside them showing it does; assertions on an error's exact wording; fixed waits (`sleep`, `setTimeout`) inside a test instead of fake timers or the real event; an `expect.poll` nobody awaits |
| `slop` | on | Swallowed errors, a try around code that cannot throw or around a whole function only to rethrow "Failed", alibi comments (`do not remove`, `fine for now`), suppressions of security or test rules (a comment cannot waive those), `==` (but `== null`), switch fallthrough, self-comparison, fake fallback values, `any` and double casts, commented-out code, elision and placeholder comments, comments that restate the next line or narrate an edit, emoji and "here" debug logs, throwaway names (`data2`, `fetchUserV2` beside `fetchUser`), mock data and placeholder copy in source |
| `design` | on | Over-engineering and tangles: two statements on one line (a jump after one is fine), a short helper called once (write it where it is used), a module exporting eight or more functions that average under two statements (a wide interface over little work), import cycles, a module importing itself, nesting past 4 levels, functions over 80 statements, more than 5 parameters, `if` chains that are a lookup table written as code, the same few statements repeated with new names a few lines apart, runs of 20+ statements over 40+ lines with no blank line, boolean-flag arguments, tangled ternaries, pass-through functions and components, one-implementation interfaces, classes that should be functions |
| `async` | on | Async callbacks nobody awaits, `fetch` without a status check, rethrows that drop the original error (or its `cause`), a promise that resolves twice, fixed sleeps, success returned from a catch, exponential backoff (`2 ** attempt`) written outside the project's retry helper |
| `perf` | on | Everywhere: spreading or copying the accumulator in `reduce` (`Object.assign({}, acc)`, `acc.concat`, `new Set(acc)`: quadratic). In files named `*.hot.ts` or `*.hot.tsx` (code that runs on every request): regular expressions built inside functions, dynamic `import()`, deep copies (`structuredClone`, JSON round trips), work at module scope. A project with no `.hot.` files is unaffected |
| `react` | on | `target="_blank"` links without `rel`, `javascript:` URLs, effects that only derive state, racy fetches in effects, pointless memoisation, components defined inside components, twelve or more states in one component, needless `"use client"`, hook dependency mistakes, impure render (random values or the clock read in render, refs read during render, mutated props or state) |
| `security` | on | Live credentials, default secrets, secrets behind public env prefixes or in logs, SQL and shell commands built from strings, request bodies written straight to the database, `Math.random` tokens, disabled TLS checks, open redirects, unverified Stripe webhooks, a recursive delete at a path built from an environment variable or a request |
| `next` | on | Server-only env read in a client file, server actions that write with no auth check |
| `state` | on | Implicit state machines: three or more boolean flags doing one state's job |
| `types` | on | Two casts in a row, a value declared `unknown` or `any` and then cast with nothing checked in between, a literal declared `unknown` or `object`, exported functions returning `unknown` or taking `Record<string, unknown>` past the parse, `Reflect.get`/`apply` dodging types, brands stamped on with `as`, `throw new Error("should never happen")` where a type should rule the case out, casts on outside data (`JSON.parse(x) as T`, `res.json() as T`, `req.body as T`, `process.env.X as string`), `!` on env, URL, header and storage values and on `find()`, type guards that check nothing, `{...} as T` where `satisfies` would check it, `as never`, `T extends any` |
| `validation` | on | Request input reaching a write, query or mail call unchecked, a parsed result thrown away while the raw value is used, `Number()`/`parseInt` on input with no NaN check, page sizes with no maximum, unguarded `JSON.parse(localStorage…)`, raw env reads beside a validated env module |
| `naming` | on | Hook names that lie, lowercase components and types, type words in names (`isLoadingBoolean`), one word cased two ways (`userId` with `userID`), snake_case pasted into camelCase files, abbreviation soup, names over 56 characters, reassigned `UPPER_SNAKE` constants |
| `globals` | on | State on `window`/`globalThis`, exported `let` and exported empty Map/Set/array stores, hand-rolled `getInstance()` singletons |
| `ui` | on | Where the project has tokens or a Tailwind theme: hardcoded colours, type values (size, weight, line height, family), spacing, radius and z-index; raw palette classes; static inline styles; raw controls hand-styled beside the project's own `Button`/`Input`; images without `alt`, clickable `div`s, invalid ARIA, empty links and headings, untitled iframes, positive `tabIndex`; where the theme's colours switch in dark mode, a `dark:` colour set by hand |
| `orm` | on | Drizzle and Prisma: a table whose first column can be null (in a left join Drizzle reads the first column to decide a row is missing, so real rows come back null), a Postgres `text` column filled with generated UUIDs (use `uuid()`), queries on the outer client inside a transaction, update or delete with no `where`, find-then-create races, one lookup per loop item, a `status` or `state` update whose `where` does not check the current state |
| `query` | on | TanStack Query: a `queryKey` missing values the `queryFn` reads, a `queryFn` asserting `id!` with no `enabled` |
| `workers` | on | Cloudflare Workers: promises neither awaited nor passed to `waitUntil`, destructured `ctx.waitUntil` |
| `supabase` | on | Supabase results whose `error` is never read, `auth.getSession()` trusted on the server |
| `server` | on | Express and Fastify: sending twice without `return`, Express 4 async handlers with no error forwarding |
| `start` | on | TanStack Start server functions whose validator only types the input; TanStack Router `redirect()` or `notFound()` written as a statement instead of thrown |
| `effect` | on | Effect: an effect run (`Effect.runPromise`, `runSync`…) inside `Effect.gen`, which starts a second runtime |
| `payments` | on | Stripe amounts built with floats or taken from the client; refunds, transfers and payouts with no idempotency key; in files named `*.money.ts`, fractional literals, `Math.round`/`floor`/`ceil`/`trunc`, `parseFloat` and `toFixed` |
| `auth` | on | A `userId` taken from the request in a handler that has the session |
| `swift` | on | Swift through SwiftLint (`brew install swiftlint`): force `try` and force unwraps, empty `catch` and discarded `try?`, `print` logging, stub `fatalError`s, fixed `asyncAfter` delays, `Task` in `onAppear`, `AnyView`, flag clusters, deprecated SwiftUI APIs, fixed font sizes and raw colours outside design-system files, secrets in source or `UserDefaults`, type and identifier casing, view builders over 100 lines or nested past 7 levels, more than 12 `@State` properties, notification event buses and discarded observers, settable singletons, strong `self` in subscriptions and timers, redundant main-queue hops, generic `MARK`s, restating comments |
| `runtime` | opt-in | Module-level mutable state, which leaks between requests on serverless |
| `actions` | opt-in | Clickable elements with no `data-intersite` name |
| `comments` | opt-in | Comments without a tag: a comment must open with `SAFETY:` (an invariant the code relies on), `PROVIDER:` (how an outside service behaves) or `ponytail:` (a known limit), or be a tool directive (a reasoned suppression, a JSDoc type, a bundler hint), a contract (a doc block with `@throws`, `@example`, `@deprecated` or `@see`) or a link to the issue, pull request or RFC behind the code; and every type cast but `as const` needs a `SAFETY:` comment |

A pack can also switch on rules oxlint already ships (`builtin:` in a pack file), and `lint.rules` turns any single
rule off, or on, by name: `lint.rules: { require-comment-tag: error }` turns on one opt-in rule without restating
the default packs. A framework pack stays silent in a project that does not use the framework. Files the project's
own oxlint config ignores (`ignorePatterns`) are not linted.

Two file suffixes mark code that needs stricter rules: `*.hot.ts` for code on every request's path (`perf`) and
`*.money.ts` for money arithmetic (`payments`). Name a file that way to opt it in.

Swift rules live in [lint/swift/rules.yml](lint/swift/rules.yml), in the same form: a message, `bad` and `good`
examples, and either a SwiftLint rule or a regular expression. Intersite runs SwiftLint with only these rules, so a
project's own `.swiftlint.yml` keeps applying to its own SwiftLint runs and every Intersite finding is attributable.
A deliberate exception in Swift is `// swiftlint:disable:next <id> -- <why>`.

## Capture, actions and replay (experimental)

Replay is experimental: its modes, options and output may change between release candidates, and a failure can be
replay's own mistake (an ID it did not remap, a record the seed lacks) rather than the change's. Read the failing case
with `--verbose` before changing code for it.

Capture samples whole user sessions on the project's server, scrubs them, and sends them to the collector. Replay
sends them again to a local server and compares the answers with what production returned.

```js
import { createCapture } from "intersite/capture";

const capture = createCapture({ project: "acme", url: env.INTERSITE_URL, token: env.INTERSITE_INGEST_TOKEN, release: env.RELEASE });
const copy = request.clone();
const { response, route, user } = await handle(request, env);
ctx.waitUntil(capture.record({ request: copy, response, route, actor: { kind: user?.role ?? "anonymous" }, session: user?.id }));
return response;
```

Fastify, Next.js and browser-only (`wrapFetch`) forms are shown at the top of
[capture/index.mjs](capture/index.mjs). In a Node server, build it with
`createCapture({ ...captureOptions(), url, token, release })` (`captureOptions` from `intersite/shared/config`), so
`project` and the `capture` section of `intersite.yml` apply. Capture never reads files itself; on Workers pass
`project`, `exclude`, `redactKeys` and `keepKeys` inline.

- **Mounted servers work.** A server under a prefix (`/api/v1/me` for the route `/v1/me`) is recorded with its real
  path. When cases cannot reach the collector, capture prints one line saying so.
- **Scrubbing is default-deny.** A string is kept only when it is an ID, a date under a date key such as `createdAt`, or a short
  code such as `active` under a structural key such as `status`. Numbers are kept so replay has amounts and counts.
  Everything else becomes a stable fake. No headers and no response bodies are stored. Before turning capture on in
  production, run `intersite audit`: it lists what was kept, per key, widest first. An enum has a handful of values;
  a key with many distinct kept values is probably personal data and goes in `capture.redactKeys`. A project enum that came out faked (such as `sortBy`)
  goes in `capture.keepKeys`. The known gaps
  are listed in `capture/scrub.mjs`.
- **Actions** are names you give to what users do: `<button data-intersite="program.save">`. The tracker
  (`intersite/track`) stamps each request with the action that caused it, so `intersite actions` shows which
  actions fail in production and `intersite replay --action program.save` replays exactly those. Markup can change
  freely as long as the name stays.
- **Replay modes:** `baseline` (same status and response shape as production; a server error production recorded
  fails while it still happens and passes once it is fixed), `twice` (a repeated write must not
  error, and a PUT, DELETE, webhook or write with an idempotency key must not change the adapter's `state()` again),
  `race` (the same webhook or idempotent write sent twice at once must not fail or create two records), `cross-tenant` (another account must be refused, and its lists must not show records the session created; a record public by design goes in
  `replay.crossTenantIgnore` with a reason), `ui` (each named action's page loads cleanly in Chrome;
  reads are clicked, and writes fill the form from the recorded body, submit it and must get the recorded status).
- **Cheaper `ui` runs:** `ui` runs in Intersite's Rust browser engine (the one flows use) and needs no playwright-core.
  `npx playwright install chromium-headless-shell` makes it use Chrome Headless Shell instead of full Chrome (about
  half the memory and a third of the browser CPU in our benchmark). Lightpanda (`replay.browser: lightpanda`) is lighter still but has no real layout, so clicks and visibility checks may not
  work; it is unverified with Intersite.
- **The adapter** (`.intersite/adapter.mjs`) tells replay how to sign in a seeded test user and which seeded record
  stands in for an ID from production. Its optional `state()` returns what the app holds as JSON (counts, balances),
  which invariants get from before and after each session (money conserved, one credit per payment) and `twice`
  compares around a repeated write. Capture stores no headers, so anything every request needs (an API version,
  an idempotency key) comes from its optional `headers` export.
- Replay refuses a target that is not local unless `--allow-remote` is passed.

Nightly on the main branch, `intersite replay --sample 200 --mark --release <sha>` records which sessions pass. Pull
requests then run `intersite replay --known-good`, so a failure there is a regression and not old noise.

### Verifying Lightpanda

Install it (the binary goes to `~/.local/bin`, which must be on PATH), then run the `ui` suite against it:

```bash
curl -fsSL https://pkg.lightpanda.io/install.sh | bash
```

```bash
INTERSITE_UI_BROWSER=lightpanda node --test test/replay/ui.test.mjs
```

If every test passes, `replay.browser: lightpanda` works with Intersite. Lightpanda has no layout, so the tests most
likely to fail are the ones that click or fill forms; each failure names the step.

### Flows: recorded sessions as browser tests

Turn on steps in the tracker and send its events to capture, as for errors:

```js
const tracker = createTracker({ steps: true, onUi: (event) => navigator.sendBeacon("/api/ui-case", JSON.stringify(event)) });
// on the server, for POST /api/ui-case:
capture.recordUi({ ...event, session: user?.id ?? event.session, actor: { kind: user?.role ?? "anonymous" } });
```

The tracker then records each page load (with the user's connection and device in rough buckets), reload, route
change, click and filled field, never what was typed or a list row's text. Turn a recorded session into a test and
play it:

```bash
npx intersite flow --from <caseId>
```

```bash
npx intersite flow --concurrency 8
```

A flow is a JSON file in `.intersite/flows/` with a handful of verbs (`open`, `reload`, `click`, `fill`, `see`, and
`expect` on a click), so an agent can write one too; the format is in [CONTRACT.md](CONTRACT.md#flows-experimental).
Flows share one headless browser, a context each, driven by Intersite's Rust engine over the DevTools protocol, so
they need no playwright-core. By default a flow runs on the connection and device it was
recorded on (`--network none` turns that off), and `--timing recorded` clicks when the user clicked, which is how a
click before the page finished loading or a double submit on a slow phone comes back. If your API is on another
origin, allow the `x-intersite-step` header in its CORS settings.

### Catching an endpoint that got slower

Have the server report counts in the standard `Server-Timing` header (`queries;desc=7`). On the main branch run
`intersite replay --seed 1 --metrics-out .intersite/metrics/main.json`, then on your branch, against the same local
data, `intersite replay --metrics-base .intersite/metrics/main.json`. A request that now runs more queries fails,
which is how an N+1 shows up before production.

### Linting the API itself

`intersite replay --mode contract` lints request and response bodies across the whole API for inconsistency: key
casing, one field typed two ways, envelopes and list paging, error shapes, a status that disagrees with its body,
values in disguise (`"true"`, float noise, dates as numbers), fields that must not leave the server, and route
naming. Conventions are inferred from your own API (what 90% of it already does), never configured, so a finding
reads `/created_at is snake_case; 212 of 214 response fields in this API are camelCase`. A deliberate exception goes
in `replay.contractIgnore` with a reason. Three or more findings of one kind under one object print as one line
naming the object, the count and a few examples; an ignore entry on that object accepts them all.

`intersite replay --mode contract --openapi openapi.json` does the same on a documented contract, with no server
and no recorded traffic.

### Checking that a data change changed only what it should

Before a migration, backfill or refactor, run `intersite replay --seed 1 --snapshot-out .intersite/snapshot/before.json`
against your local server and data. Apply the change, then run
`intersite replay --snapshot-base .intersite/snapshot/before.json`. Every response whose status or values changed is
one `FAIL snapshot` line with the JSON pointer and both values. IDs the session created, timestamps near now and
request IDs are normalised, a timestamp set as now plus a fixed offset (an invite's expiry) is compared by its
offset from each run's start, so two runs of unchanged code report nothing. Other fields that change on their own go in
`replay.snapshotIgnore` (`[/updatedAt, /items/*/etag]`). The file holds response bodies from your local server, so
keep it under the git-ignored `.intersite/`.

### Checking a migration before it ships

During a deploy the old server briefly runs against the new schema. Replay that state: apply the branch's
migrations to the local database, start the server from the base commit, and run
`intersite replay --known-good`. A failure is a request production would have dropped mid-deploy.

## Collector

Locally it is one SQLite file, `.intersite/cases.db`. Commands that read cases (`replay`, `actions`, `pin`, `check`)
open it themselves when no collector is running. To record while you develop, keep one running:

```bash
npx intersite collector
```

The same code deploys to Cloudflare as a Worker with D1 (`intersite deploy`). Cases expire after
`capture.ttlDays`, a pinned case never does, and `collector.dailyCap` bounds how many are stored per day.

## Developing Intersite

`npm test` runs the Rust engine's unit tests, then every Node test; `npm run check` runs Intersite on its own change,
the JSDoc type check (`npm run typecheck`) among its checks. CI runs both, plus `cargo fmt --check` and
`cargo clippy -- -D warnings`, on Linux and macOS.

```bash
npm test
```

```bash
npm run check
```

The formats and rules every part agrees on are in [CONTRACT.md](CONTRACT.md).
