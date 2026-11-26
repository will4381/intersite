# Intersite contract

What every part of this package agrees on. Change it here first, then in code.

## Parts

| Folder | Runs in | Does |
| --- | --- | --- |
| `lint/`, `cli/lint.mjs` | Node, inside oxlint | Slop rules, mostly declared in JSON; baseline that only shrinks |
| `gates/`, `cli/gate.mjs` | Node, local or CI | Each gate's git work (the diff, the files, the config's globs) and its output; the judging is in `core/` |
| `core/` | Rust, built by cargo the first time a check needs it (and again when its source changes) | The analysis engine, called with one JSON request per check: similar (lexer, k-grams, Aroma features), duplicates, unused, naming, style-drift, value-drift, sql (with planning against a database), columns, regex, artifacts, test-integrity, new-deps, tamper (and the edit hook), special-case, complexity, coverage, stats, mutation's choice of mutants, routes, env, structure, test-run outcomes, search, twins, trace reports |
| `cli/search.mjs`, `cli/twins.mjs`, `cli/trace.mjs` | Node | `search`, `twins` and `trace`: arguments, processes (servers, inspectors, Chrome) and output |
| `track/` | The browser | Names user actions and stamps them on the requests they cause |
| `capture/` | The project's server or browser (any `fetch` runtime) | Samples, scrubs and sends cases to the collector |
| `collector/`, `cli/collector.mjs`, `cli/deploy.mjs` | Node with SQLite locally; a Cloudflare Worker with D1 when deployed | Stores cases, answers queries, deletes expired ones |
| `replay/`, `cli/replay.mjs` | Node, local or CI | Pulls cases, replays them against a target URL, compares (experimental: may change between release candidates) |
| `cli/check.mjs`, `cli/init.mjs` | Node | `check` runs everything that applies; `init` sets a project up |
| `shared/` | Everywhere | `case.mjs`, `shape.mjs` (no Node imports), `config.mjs` (Node only) |

## Code rules

- Analysis is Rust in `core/`, with the crates it needs (oxc for JavaScript and TypeScript, sqlparser for SQL,
  postgres for planning). A machine that runs the gates needs Rust (`rustup`): `gates/core.mjs` builds the engine with
  cargo the first time and whenever `core/src` is newer than the binary, then sends it one JSON request on stdin and
  reads one JSON answer: `{ findings: [{ file, line, target, message }], summary, data? }`, paths relative to `root`.
- Node code is plain ESM `.mjs` with `// @ts-check` and JSDoc types, checked strictly by `npm run typecheck`
  (`tsc` over `tsconfig.json`). No TypeScript files: the package is installed
  straight from GitHub (`"intersite": "github:<owner>/intersite#<tag>"`), and Node refuses to strip types under
  `node_modules`. Node stays where it must: the CLI entry, git and process orchestration, the oxlint rule plugins,
  `capture/` and `track/`, the collector, and replay (adapters are the project's JavaScript).
- One runtime dependency, `yaml`, used only where config and rule files are read (never in `capture/` or `track/`).
  `oxlint` and `@oxlint/plugins` are optional peers that `lint` needs (a package that only imports
  `intersite/capture` or `intersite/track` installs neither), and `oxlint-tsgolint` an optional peer that
  `lint.typeAware` needs; `playwright-core` is an optional peer used only by `trace --page` (the `ui` replay mode and flows drive the browser
  from intersite-core);
  `wrangler`, `typescript` and `@types/node` are dev dependencies, and `oxc-parser` one only for search's recall test.
- `capture/`, `track/`, `shared/case.mjs` and `shared/shape.mjs` use only web-standard APIs.
- Tests are `node --test` files under `test/<part>/`. Test behavior through the part's public entry, not its internals.
- A deliberate shortcut gets a `// ponytail: <ceiling>, <upgrade path>` comment.
- The package passes its own `npm run check` with an empty baseline, and the Rust engine `cargo fmt --check` and
  `cargo clippy --all-targets -- -D warnings`.

## CLI output (every command)

Agents read this output, and every line costs them context.

- Success is one line: `ok <command>: <counts>`.
- A finding is one line: what and where, then `| rerun: <exact command>` when a narrower rerun exists.
- A suggestion is one line that starts `suggestion: ` and says it fails nothing. A gate prints its suggestions after
  its findings, and after its `ok` line when it has no findings: a suggestion never changes the exit code. It is
  dropped the way a finding is, by `gates.acknowledged` or the baseline `--all --write` records.
- Nothing decorative: no banners, colours, progress bars or blank lines. `--json` prints structured data instead.
- In GitHub Actions (`GITHUB_ACTIONS=true`), `check`, `gate` and `lint` print each finding as an annotation instead,
  still one line: `::error file=<path from the repository top>,line=<n>,title=intersite <gate or rule>::<the line>`.
  A suggestion is a `::notice`, which shows on the pull request and fails nothing.
- `check --json` prints one object and nothing else: `{ ok, stages: [{ name, ok, code, findings: [{ file?, line?,
  target, message }], suggestions?, output? }], skipped, upgrade? }`. `suggestions` has the shape of `findings` and
  is there when a gate made any; `gate --json` carries it the same way, and `ok` is about the findings alone. A lint finding's `target` is its rule; `output` is what a
  project check or replay printed; `skipped` holds the `skip …` lines. Gate findings carry `file` (relative to the
  project) and `line` wherever the gate knows them, in `gate --json` too.
- Exit 0 pass, 1 findings, 2 usage or setup error. A setup error is one line on stderr that says what to do. An
  unexpected error is also one line and exit 2; `INTERSITE_DEBUG=1` prints the stack.
- `check` prints only its stages' findings and its own line; `skip <stage>: <why>` lines may come before it, and so
  may one `upgrade intersite: <tag> is out and this is v<version>; …` line when a newer release is tagged. The tags
  are read with `git ls-remote` at most once a day per project (cached in `node_modules/.cache/intersite`), never in
  CI, never prompting for credentials, and a failure says nothing. `INTERSITE_NO_UPDATE_CHECK=1` turns it off.

## Config: `intersite.yml`

One optional file at the project root, described by `intersite.schema.json`, loaded with `loadConfig(cwd)` from
`shared/config.mjs`, which fills defaults. With no file every default applies and the project is named after its
package, so each command works in a fresh checkout. `intersite.json` is still read, since JSON is valid YAML.
Commands other than `init` use the nearest folder at or above the working directory that holds the config, no
higher than the repository top. `captureOptions(cwd)` returns `{ project, ...capture }` for `createCapture`. Secrets are never in it; it names the environment variables that hold
them, and `collectorTokens(config)` reads them, falling back to `local-read` and `local-ingest`, the tokens the
local collector accepts.

## Case (v1)

Defined in `shared/case.mjs` (`Case` typedef, `caseProblem`). `response.shape` comes from `shapeOf` and is compared
with `shapeDiff`; `response.ids` comes from `idsOf` (all in `shared/shape.mjs`). A case never holds cookies, tokens,
`Authorization` or API-key headers, or a raw user identifier. Response bodies are not stored, only their shape and IDs. `response.ids` holds only the IDs the scrubber would keep
under the same key, so a secret shaped like an ID is never stored.
Request path, query and body values are scrubbed by `capture/scrub.mjs`: a string is kept only when it is an ID, a
short digit string, an ISO date under a date-like key, or a short lowercase code under a structural key (or one in
`capture.keepKeys`); every other string becomes a stable fake of the same form, such as `text-1a2b3c4d`.

A **session** is every case with the same `session` value, ordered by `seq`. With no caller session and no
`x-intersite-session` header, a request is a session of its own, so sampling takes about `sample` of signed-out
requests. Capture samples whole sessions, and
always records a case whose outcome is not `ok`. An `ok` request of an unsampled session costs one small hash: nothing
is cloned or read. Cases are sent in batches of up to 50 per request. On Cloudflare Workers, create the capture
inside the request handler, because a Worker may not carry I/O from one request into another.

### Actions

An **action** is a named thing a user does in the UI, such as `program.save`. Names are written by developers,
match `ACTION_NAME`, and are never derived from page text. They are the stable link between the UI and the tests:
markup can change freely as long as the element keeps its name.

- In markup: `data-intersite="program.save"` on the element the user clicks or the form they submit.
- `track/` notes the most recent action and stamps the requests that follow it. Capture stores it as
  `case.action = { name, page }`, where `page` is the browser path with every segment that is not an ID or a short
  lowercase word (`a` to `z`, at most 20 letters) replaced by `_`: `reducePage` in `shared/case.mjs`. Capture applies
  it again on the server and never trusts the client's value. A name in a path (`/u/maria`) looks like any short
  word, so an app whose paths can hold one passes the tracker `page: () => <route template>` (`/u/:handle`).
- A client-side error or warning with no API call is stored as a **UI case**: `request.method` is `UI_METHOD`,
  `request.route` and `request.path` are the page, `response.status` is 0, and `response.errorCode` is the error's
  name (never its message).

### Steps

With `createTracker({ steps: true })` the tracker also reports what the user does, so a session can become a flow.
Each step goes to `onUi` as `{ page, outcome: "ok", session, step }`, and the app passes it to capture's `recordUi`
like an error; capture samples it with the session and stores it as a UI case with `case.step` (`UiStep` and
`stepProblem` in `shared/case.mjs`). `step.n` counts the tab's steps in order, kept in `sessionStorage` across reloads.

- `nav`: `how` is `load`, `reload`, `pop` (back or forward) or `push` (the app changed the route; noticed at the next
  step or on back/forward). A loaded page's nav carries `env`, the connection and device in buckets: `rtt` (ms, one
  of `RTT_MS`, rounded up), `down` (Mbit/s, one of `DOWN_MBPS`, rounded down), `cpu` (a slowdown of 1, 2, 4 or 6,
  guessed from cores and memory), `viewport` ([width, height] to 10 px) and `mobile` (a coarse pointer). Latency and
  bandwidth come from Navigation and Resource Timing, else `navigator.connection`.
- `click`: `name` is the nearest `data-intersite` around the element; `nth` the list item (`LIST_ITEM`: `li`, `tr`,
  `listitem`, `row`, `option`) clicked inside it, by position; `role` and `label` the clickable element inside those
  when it has no name of its own. A label keeps a sentence-case first word and lowercase words; every other word is
  `_` (`reduceLabel`), and a list item's text is never kept. Clicks on form fields are not steps.
- `fill`: `field` is the control's `name` or `id`, and `name` the named element around it. What was typed is never
  sent; a flow takes the value from the scrubbed body of the write that followed.
- Every step but a nav has `ms`, the time since the page loaded or the route changed, to 100 ms.

Requests carry `x-intersite-step`, the tab's latest step number; capture stores it as `case.step = { n }`, linking
each request to the step that caused it. A malformed step is dropped by the tracker, capture and the collector.

### Headers

| Header | Set by | Meaning |
| --- | --- | --- |
| `x-intersite-action` | `track/` | Action name for this request |
| `x-intersite-page` | `track/` | Page path, already reduced as above |
| `x-intersite-session` | `track/` | Random per-tab ID; capture uses it as the session when the caller gives none |
| `x-intersite-step` | `track/` with `steps: true` | The tab's latest step number; stored as `case.step.n` |
| `x-intersite-replay` | replay | The case ID being replayed. Capture skips these; a server may use it to stub outside calls |
| `x-intersite-time` | replay | The case's recorded `at`. A server may pin its clock to it |

## Collector HTTP API

JSON in and out. `Authorization: Bearer <token>`. Two secrets: `INGEST_TOKEN` may only `POST /v1/cases`;
`READ_TOKEN` may do everything else. Errors are `{ "error": "<message>" }` with a 4xx/5xx status.
`POST /v1/cases` answers CORS preflight and allows any origin, so a browser can send UI cases; no other route does.

| Method and path | Token | Body or query | Returns |
| --- | --- | --- | --- |
| `GET /health` | none | | `{ ok: true }` |
| `POST /v1/cases` | ingest | `{ cases: Case[] }`, at most 50 | `{ accepted: number, dropped: { id: string, reason: string }[] }` |
| `GET /v1/sessions` | read | query below | `{ sessions: { session: string, cases: Case[] }[] }` |
| `GET /v1/cases/:id` | read | `project` | `{ session: string, cases: Case[] }`: the case and the earlier cases of its session |
| `POST /v1/cases/:id/pin` | read | `{ project, pinned: boolean }` | `{ pinned: boolean }` |
| `POST /v1/results` | read | `{ project, release, results: { session: string, pass: boolean }[] }` | `{ recorded: number }` |
| `GET /v1/actions` | read | `project`, optional `since` | `{ actions: { name, page, ok, warn, rejected, error, lastAt }[] }`, one row per name and page with a count per outcome |

`GET /v1/sessions` query: `project` (required), `outcome` (repeatable), `route` (exact route template), `action`
(exact action name), `since` (ISO timestamp), `known_good=1`, `sample` (how many sessions, default 20, at most 200),
`seed` (integer; same seed and same data give the same sample).

Rules the collector enforces:
- Every case passes `caseProblem`; a failing one is dropped with its reason, the rest are stored.
- A duplicate `(project, id)` is ignored, so capture may retry.
- Each case expires `ttlDays` after `at`. A scheduled run deletes expired cases that are not pinned.
- `GET /v1/sessions` draws its sample from the 5,000 most recently active sessions matching the filters.
- A daily cap per project and outcome class (`ok` versus everything else) drops the overflow with reason `cap`.
- `known_good=1` returns only sessions whose latest result passed. A session that failed last time, or has never
  been replayed, is left out. So the nightly run on the main branch replays without `known_good` and with `--mark`,
  and pull requests replay with `--known-good`.

All SQL lives in `collector/store.mjs`, written against the D1 interface. Locally, `intersite collector` runs the
same routes and store in Node over `node:sqlite` through a small D1-shaped wrapper, listening on 127.0.0.1 only and
accepting the tokens `local-ingest` and `local-read` unless the token environment variables are set. Its database is
`.intersite/cases.db`. A command that reads cases (`check`, `replay`, `actions`, `pin`) serves that file itself, on a free port of its own, for
the length of the command when the configured collector is local and nothing is listening.

## Gates

Each gate looks at the change between `gates.base` and the working tree (uncommitted work included). The default
base falls back from `origin/main` to `origin/HEAD`, `origin/master`, `main`, `master`; with no commits the change
is compared with an empty tree. Untracked `node_modules` and `.intersite` are never part of a change.

A gate's world is the project: the folder holding the config, or the working directory when there is none, minus
any nested folder whose own config loads (that is another project). Changes outside it are not its changes. Paths
in findings, `--json`, `gates.acknowledged` targets and every `gates` glob are relative to the project folder, as
lint's are. Gates read wider only where that is the point: `duplicates` and `similar` look for the original in the
whole repository and name it relative to the project (`../../packages/ui/x.ts`); `unused` counts a mention anywhere
in the repository as a use; `sql` reads every migration for the indexes a new foreign key may have; `regex` compares a
validator with those of the same name anywhere; `style-drift` offers tokens from the project's own package, packages above it and
shared ones; `value-drift` reads every constant and string in the repository, so an app's copy is checked against a
shared package's pricing; `new-deps` also checks the workspace root's `package.json` for a project in a subfolder;
`auth` reads every endpoint in the repository to learn each package's convention, and follows a router mounted elsewhere.
`fails-on-base` and `mutation` use a worktree of the whole repository and run `gates.testCmd` in the project's
folder inside it, each run limited to `--timeout` seconds (120 by default). `coverage` runs `gates.testCmd` once in the
working tree itself, limited the same way. What a failed run proves is read from the end of its output
(`core/src/outcome.rs`): a failed assertion, a runner's own per-test timeout, or an error the code threw is a test's
verdict; a run that stopped because the code did not compile or load (a type error from a compiling runner,
`SyntaxError`, an import of a name or relative file that is not there), because it could not run (a missing command,
script or package, a refused connection, no memory or disk, a signal) or because the time limit stopped it is not, and
never counts as proof. `check` names the first two kinds on a failing project check's line, `(does not compile or load:
…)` or `(could not run: …)`.

`check` runs the gates that only read side by side in worker threads (up to six, one fewer than the cores) and prints
their findings in `gates.run` order; each worker reads git's diff and file list once for all the gates it runs, since
the working tree does not change during a check. `fails-on-base`, `mutation` and `coverage` run the tests, so they
run one at a time after the others.
`intersite gate <name> [--base <ref>]` runs one; `intersite check` runs those in `gates.run`.

| Gate | Fails when |
| --- | --- |
| `test-integrity` | A test file was deleted, or has fewer tests or fewer assertions (`expect`, `assert`, `t.is`…, fast-check's `fc.assert`) than on base, or gained a test that will not run as written: skipped, todo, `fixme`, focused (`.only`, `fit`, `fdescribe`: every other test stops running), skipped on a condition (`skipIf`, `runIf`) or inverted (`it.fails`) |
| `tamper` | A changed file that judges the code is weakened. `tsconfig*.json`: a strict-family option (`strict`, `strictNullChecks`, `noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `checkJs`, …) on before and off or gone now (gone with an `extends` left is not known to be off), or a source folder added to `exclude` (build output, tests, stories and configs are not). Lint configs (`.oxlintrc*`, `eslint.config.*`, `.eslintrc*`, `biome.json(c)`, `.swiftlint.yml`): a rule's severity lowered, a configured rule removed, a new rule entry set to off, a new ignore pattern, an `extends` or plugin dropped, a SwiftLint rule disabled or no longer opted in, the config deleted; an override whose `files` are only vendored primitives (`components/ui`), build output or config files is not judged. `intersite.yml`: a gate gone from `gates.run` or a pack from `lint.packs` (a missing list means the defaults), a rule turned off, `lint.typeAware` or `lint.ownRules` turned off, a non-test path added to `gates.testPaths`, a `gates.protected` rule or a project check removed or made slow; added `gates.acknowledged` entries are not judged. The lint and gates baselines: more findings recorded. Test runners (`vitest`/`vite`/`jest`/`playwright`/`stryker` configs, package.json `jest`): new `exclude`/`testPathIgnorePatterns`/`coveragePathIgnorePatterns` entries (end-to-end suites left to their own runner are not), `include`/`testMatch` entries lost, a coverage threshold lowered or removed, `passWithNoTests` turned on, `retry`/`retries` raised. package.json scripts named test, check, lint, typecheck, ci, verify or validate (with `npm run` steps expanded): gaining `\|\| true`, `; exit 0` or `--passWithNoTests`, a flag that runs fewer tests or files (`--changed`, `--onlyChanged`, `--findRelatedTests`, `--lastCommit`, `--testNamePattern`, `--grep`, `--exclude`, `--ignore-pattern`) or hides warnings from a limit (`--quiet`), becoming an echo, losing a path or `--max-warnings`, or removed. CI workflows: a step that ran tests, lint, a type check or `intersite` removed or made `continue-on-error`/`if: false`, a workflow that ran one deleted, `pull_request`/`push` triggers dropped. Source: more coverage-ignore pragmas (`istanbul`, `c8`, `v8 ignore`) across the change, and `process.exit(0)` added to a test setup or teardown file. Target is `<file>:<key>` |
| `special-case` | Added production code (not tests, fixtures, scripts, configs or test setup) answers the tests instead of solving the problem: a line branches on running under a test runner (`NODE_ENV` compared with `"test"`, `VITEST`, `JEST_WORKER_ID`, `typeof jest`/`vi`, Swift's `XCTestConfigurationFilePath` or `NSClassFromString("XCTest")`), unless another environment is named beside it (a "not production" switch), the file is an env or config module, or it is `import.meta.vitest`; or an `if`, `case` or `?:` on one of a changed test's input literals returns exactly the value that test expects for it (`expect(price("abc-123")).toBe(4200)` and `if (id === "abc-123") return 4200`). Literals of three characters or fewer, 0, ±1, 2, 10, 100, 1000 and HTTP statuses are ignored, as are functions that map literals to literals in two or more branches (a lookup table) and answers that respell the input (`"email"` → `"EMAIL"`) |
| `duplicates` | An added block of `gates.duplicateLines` or more lines already exists elsewhere in the repository |
| `similar` | An added function, component, hook, class or type already exists under another name: the same structure once local names and literals are set aside. Or added lines hold 80% or more of an existing function's structural features (one of 30 or more names and literals) inside a function at least half again its size: a helper pasted instead of called. Exact pasted blocks are left to `duplicates`. Target is `file:Name` A copy left behind is a suggestion, which fails nothing: the change edits a function (of 32 normalised tokens or more) in what it says, and another function, which the change neither adds nor edits, says what that one said before. What a function says is its shape with each literal and each of its module's own names as written; a formatter's commas, parentheses and quotes and the names of locals are left out, so a reformat or a renamed variable is not an edit, and two functions that already differed by a string or a helper are not copies. Edited the same way in one change, the two are still one. Target is `<file>:<name>:copy` |
| `naming` | The change adds a file or folder whose casing, shared suffix (`*.service.ts`) or test pattern differs from what a clear majority of its siblings keep, or whose main export is named unlike the file where its siblings match theirs. Conventions are inferred per folder and file kind, never configured |
| `style-drift` | The change adds a styling value that is nearly one the project already has (a colour within the just-noticeable difference, a size a pixel off its scale), a literal equal to a token's value, a value off a closed font-size, weight or radius scale, or a token that nearly duplicates another in its family |
| `value-drift` | A string, JSX text or comment states a money figure (a percentage, basis points, cents, or dollars under $100) in a sentence with a money word, and the `const` sharing two or more of its words, one of them a money word, holds a different value once its unit word (`Bps`, `Percent`, `Rate`, `Cents`, `Dollars`) is applied; or one money rate is set to two values in two files. Either side being changed counts. Sentences with an example marker (`for example`, `e.g.`, `if`, `say`) or code (`{`, `}`, `=`), input bounds (`between`, 0%, 100%), zeros, `let`s, Markdown, tests, seeds, fixtures and scripts are left out |
| `sql` | Added SQL (in `.sql` files, or in code: tagged `sql`/`$queryRaw` templates, `pool.query("…")`, and strings that read as statements) that locks or breaks a live table: a column added `NOT NULL` with no default, `CREATE INDEX` without `CONCURRENTLY`, a foreign key added without `NOT VALID`, `SET NOT NULL`, a column type change, a dropped or renamed column or table (a table created in the same file is not live yet); a foreign key no index starts with (indexes, primary keys and unique constraints are read from every migration), or whose column type differs from the column it references (`text` pointing at `uuid`, `integer` at `bigint`); a `text`/`varchar` column filled by `gen_random_uuid()`, and a Prisma `String @default(uuid())` field without `@db.Uuid` (new tables included); in code only, `UPDATE`/`DELETE` with no `WHERE`, `TRUNCATE` (a string starting `TRUNCATE ` in capitals or `truncate table`), a Supabase or knex `.delete()`/`.update()` on `.from("t")` with no filter in its chain (`.eq`, `.in`, `.match`, `.where…` and the like; a builder kept in a variable unawaited is filtered later and is not reported; Prisma and Drizzle wipes are lint's `no-unscoped-write`), `SELECT *`, `ORDER BY random()`, `OFFSET` by parameter or of 50 or more, `LIKE '%…'`, `NOT IN (subquery)`, a function around an indexed column in a comparison; a database call (`prisma.x.findMany`, `db.select`, `pool.query`, `supabase.from`, an awaited `sql\`…\``) inside a loop or a per-item callback, one finding per loop, unless the line above it or the loop says `no-await-in-loop -- <why>`. With `INTERSITE_DATABASE_URL`, each new query in code is prepared and its generic plan explained (never executed, in a read-only transaction rolled back); a sequential scan with a filter over 10,000 rows or more is reported with the `CREATE INDEX CONCURRENTLY` it needs. In migrations, `DELETE` with no `WHERE` and `TRUNCATE` (data deletion, judged like a lock: history under `--all`). A command that empties a database (`prisma migrate reset`, `prisma db push --accept-data-loss` or `--force-reset`, `drizzle-kit push --force`, `supabase db reset --linked` or `--db-url`, `DROP DATABASE`, `dropdb`) added where it runs unattended: a Dockerfile, Procfile or deploy config (`vercel.json`, `netlify.toml`, `fly.toml`, `render.yaml`, `railway.*`, `nixpacks.toml`), a `package.json` script named for a build, start, install, deploy or release (or one such a script runs with `npm run`/`pnpm`/`yarn`/`bun`), CI that starts no database of its own (no `services:`, no `localhost`), or a shell script or Makefile target not named for local work (`dev`, `local`, `test`, `qa`, `reset`, `seed`…) that does not work on a local container. In Supabase projects (`supabase/migrations/` or `supabase/schemas/`), migrations applied in order: a table created in the public schema that row level security is never enabled on (a migration that enables it on every table in a loop counts for all); `DISABLE ROW LEVEL SECURITY`; a permissive policy still in force whose `USING` or `WITH CHECK` is `(true)` for `UPDATE`, `DELETE` or `ALL` to `public`, `anon` or `authenticated`, or for `INSERT` to `public` or `anon`. These three are the schema left behind, so `--all` reports them too. Statements are parsed one at a time (sqlparser), so one it cannot read hides nothing else: as MySQL when written in MySQL's own syntax (backquoted names, `ENGINE=`, `AUTO_INCREMENT`, `UNSIGNED`) or when only MySQL's parser reads it, else as Postgres. In a MySQL project (a Prisma schema or migration lock with `provider = "mysql"`, a Drizzle config with `dialect: "mysql"` or `"singlestore"`, `mysqlTable(`) and for MySQL statements, Postgres' lock advice is not given: building an index, adding a column or a foreign key are online in InnoDB, a NOT NULL column added takes the type's implicit default, InnoDB indexes a foreign key itself, and there is no uuid type; dropping or renaming what running code reads, data deletion and the query checks still apply. With `--all`, a migration already in the repository is history: its locks and breaks are not judged (the summary counts them), only the schema the migrations leave behind (foreign keys and their indexes and types, UUID columns, as the latest migration declares them) and the queries in code |
| `regex` | An added regular expression (a literal or `RegExp("…")`) whose backtracking doubles with each character on a crafted input: an unbounded repeat inside an unbounded repeat where what else the group needs is optional or can be matched by the inner repeat (`(\w+\s?)+`), or a repeated choice whose alternatives can start the same way (`(a\|aa)+`). Linear-run patterns (`\s+$`) are quadratic too but need very long input, and are not reported. Also a full-string validator (`^…$`) for email, phone, UUID, URL or IP, named only for that (`EMAIL_RE`, `isValidPhone`), that another file writes differently in meaning (`\d` and `[0-9]` are one pattern) |
| `decisions` | The change adds a read of a decision three or more files of one package make on their own: an environment variable (`process.env.X`, `import.meta.env.X`, `Bun.env.X`, `Deno.env.get`) read outside an env module (`env`, `config`, `settings` files or folders; `NODE_ENV`, `DEV`, `PROD`, `MODE` and the like are exempt), a feature flag (`isEnabled("x")`, `useFlag("x")`…), or a comparison or `switch` over a `kind`, `type`, `variant`, `mode`, `tier` or `plan` property against two or more of the same values in the same files (one value per file is a caller handling a result, and is not reported). Target is `decisions:<env\|flag\|branch>:<key>` A constant is a suggestion, which fails nothing: a top-level `const` named in capitals (`DAY_MS`) whose value is a number (literals multiplied, added, subtracted or divided count as their result) or one word of text, declared with one value in three or more product files of the repository, across its packages; a colour or a list of classes is the style checks', and a name with two values each in three files is two rules that share a name. The message names a file that gives the name another value. Target is `decisions:constant:<NAME>` |
| `renames` | A replaced line differs from the line it replaced by one identifier swapped for another (four characters or more, several words or eight characters), that old name appears in no file's code any more, and it is still written in a string, comment or text file (Markdown, YAML, JSON, HTML…; changelogs, lockfiles and migrations are history and left out). Target is `renames:<old name>` |
| `columns` | The database the migrations and schemas declare (SQL migrations applied in path order with a schema dump beside them never undoing them, Prisma models, Drizzle tables, `pgTable(...)` or a named schema's `appSchema.table(...)`; Prisma and Drizzle win over the SQL they generate, and Prisma's implicit `_A_to_B` tables are Prisma's) disagrees with the code that uses it. Writes are Prisma `create`/`createMany`/`update`/`updateMany`/`upsert` data keys (nested writes follow relations and set the foreign keys they imply), Drizzle `.insert(t).values`, `.update(t).set` and `onConflictDoUpdate({ set })`, Supabase and knex `.from("t").insert/upsert/update`, and SQL anywhere (`INSERT INTO t (cols)`, `UPDATE t SET`, `COPY`, function bodies included, `NEW.col :=` in triggers). A write whose keys are not a literal (a variable, a spread), a table named in a string some other way (`const TABLE = "t"`, a `/rest/v1/t` path, or passed to a call when some `.from(x)` takes a variable), a table a file in another language names, and an auth library's own tables (user, account, session, verification… when `better-auth`, `next-auth`, `@auth/` or `lucia` is used) hide which columns are set, so those tables are never reported unwritten. Fails when the change adds a column that is nullable, has no default, is not generated, identity, serial, `@updatedAt` or set by a trigger, and no code writes, on a table code writes with literal keys (`adds t.c, but no code writes it`); adds a table nothing reads or writes; names, on an added line, a table or column the schema does not have: Supabase/knex table names, select strings (embedded tables too), filters, match and insert keys, raw SQL tables and `INSERT`/`UPDATE` columns, Prisma `data` and `where` keys, Drizzle insert and set keys (Postgres catalogs, other schemas, CTEs and tables in a generated Supabase types file are known; a table or column is reported only with a near name to suggest, one edit with neighbours swapped counting as one, or when 90% of the tables, or 80% of a table's columns, the code names are known); or removes the last write of such a column (one finding for a table no code writes any more). With `--all`: every such column nothing writes, and every table nothing reads or writes. Tests never count as writes (seeds and scripts do), and names in fixtures, mocks and stories are not checked. Target is `columns:<table>.<column>`, `columns:<table>`, `<file>:unknown:<table>[.<column>]` or `columns:last-write:<table>[.<column>]` |
| `data-model` | The data model the schemas declare has a flaw that gets dearer with every row. The model is the one `columns` reads (SQL migrations applied in order, Prisma models, Drizzle tables); foreign keys are the union of what SQL declares (parsed, and read as text too, since a guarded migration adds one inside `DO $$ … $$`) and Prisma's relations. Reported: a column named for another table (`store_id`, `storeId` for `store` or `stores`) whose type can hold that table's one-column key, with no foreign key (`open-link`; not on a table of records, known by a word of its name such as `log`, `event`, `audit` or `queue`, not beside a `…_type` column, and not when the type differs, which is an outside system's id); a boolean and a timestamp of one name in one table, `is_paid` or `paid` beside `paid_at`, where the name is of something that happened and not of a state (`is_active` beside `active_date` is two facts), or a boolean named for a value the table's own enum or CHECK list has, `active` beside `status = 'active'` (`twice-told`); an array or JSON column named `…_ids` (`id-list`); a name that links tables or holds money whose type differs from the one most tables give it, when two or more agree (`two-types`); a plain index whose columns start another index, unique constraint or primary key of the same table, in a Prisma schema (`covered-index`; an index with a type, order, operator class or predicate is left alone); a timestamp without a time zone where four in five of the schema's timestamps have one, on Postgres (`bare-timestamp`; a schema that keeps none is its own convention); a floating-point column named for money (`float-money`); a table with the same six or more columns as another (`same-columns`); a table no statement gives a primary key, a copy a migration set aside (`…_backup_…`) apart (`no-key`); a JSON column with no CHECK on its `jsonb_typeof` and no typed-JSON comment above its Prisma field, where a quarter or more of the schema's JSON columns have one (`loose-json`; a schema that says it of fewer does not make a practice of it); an enum type no column has, from Prisma where it declares the schema, else from SQL less the dropped and renamed (`idle-enum`). Tables in a platform's schema (`auth`, `storage`…), a tool's bookkeeping and a migration's `TEMP` tables are not judged, a Drizzle table's keys and foreign keys are the ones its SQL migrations declare, and where two Prisma files declare one table, the project's own wins over another package's and over a copy kept under docs or a dated path. Each finding is a fact about the schema; the message says what acting on it would be, and a link left open on purpose is acknowledged. `open-link`, `two-types`, `covered-index`, `bare-timestamp`, `float-money` and `no-key` are findings: slips with one fix, cheapest in the change that makes them. The rest are suggestions, which fail nothing: a matter of design, a tidying, or a reading of the data, where the owner knows what the schema cannot say. With `INTERSITE_DATABASE_URL` set, `--all` also reads the planner's statistics (`pg_stats` and `pg_class` in a read-only transaction: no row of a table, and no query against one) and suggests, for tables of a thousand rows or more: a column NULL in every row that is not a time (`never-filled`; a column almost nothing fills is not named, since it is as often a new column as a dead one); a column with one value in every row, a boolean, a time or a column under an enum or CHECK apart (`one-value`); a text column with two to twelve values that read as labels, with no enum or CHECK to hold it to them, in the schemas or in the database itself, whose catalog is asked (`few-values`; not one named for an identifier, free text, a model or a campaign); and, on a `twice-told` pair, the shares of rows where the two already disagree. The planner samples a large table, so a message says what its sample holds. A value is printed only where it reads as a label. A change never opens a connection. The change is judged on the columns, tables and indexes it adds; `--all` judges the schema as it stands. Target is `data-model:<rule>:<table>.<column>`, `data-model:covered-index:<table>(<columns>)`, or the table's or enum's name |
| `states` | Code and schema disagree on the values a column may hold, or one rule about them is written in many places. A column's values are a closed set where a Prisma enum types it, a Postgres enum does (`CREATE TYPE … AS ENUM`, with the values added and renamed since), or one CHECK holds it to a list (`status IN (…)`, `status = ANY (ARRAY[…])`, either after `status IS NULL OR`, and each side of an AND); constraints are read as the migrations leave them and by their words, so one dropped and added again inside `DO $$ … $$` is seen, and a column under two lists is left alone. Code is read where the table is certain. A Prisma call on the model: `where` (through `AND`, `OR`, `NOT`, `in`, `notIn`, `not`, `equals`; a relation's filter is another table's) and `data`, `create`, `update` (and `set`). SQL in a string, read as Postgres: a column is its qualifier's table when that names one table (not a CTE or a subquery), or the only relation the statement has; an UPDATE's SET, an INSERT's VALUES and each branch of a CASE are writes. Prisma code writes an enum member's name and SQL the value stored (`@map`), and a value a migration added that the Prisma schema lacks is one SQL may hold. Reported: a value written or tested that the set does not have (`unknown`: the database refuses the write, the test is never true; scripts and seeds are held to it, tests are not read); one list of two or more values tested together in three or more product files of a package (`list`; the message names the same list one value longer or shorter, when there is one). The list is read in plain code too, where no table is named: a property that ends in `status`, `state`, `stage` or `phase`, compared with strings in one `||` chain of `===` or one `&&` chain of `!==`, or passed to an array literal's `includes`; its target names the property (`.status`); one value set by an UPDATE in four or more functions across three or more product files of a package (`step`). `unknown` is a finding; `list` and `step` are suggestions, which fail nothing: whether to gather the copies is their owner's call. A change is judged on the lines it adds, so a list or step is suggested where the change writes one more copy; `--all` names each once. Target is `states:unknown:<table>.<column>=<value>`, `states:list:<table>.<column>:<values>`, or `states:step:<table>.<column>=<value>` |
| `schema-drift` | An interface or object type alias (no `extends`, no type parameters, four keys or more, all static) has exactly the keys of a zod, valibot, yup or TypeBox object schema or a Drizzle table declared as a variable in the same package, and either side is changed. The finding names the derived type (`z.infer<typeof X>`, `typeof table.$inferSelect`) |
| `imports` | An import names something that is not there. Every JavaScript and TypeScript file of the repository is parsed once and each specifier resolved as TypeScript and bundlers would (`oxc_resolver`: tsconfig `paths`, `baseUrl`, `extends` and references, package `exports`, workspace packages, `.js` written for `.ts`; then tsconfig/jsconfig `paths` read directly, React Native platform suffixes, SvelteKit `$lib`). It fails on: a relative or alias import of a file that does not exist (one in a folder a build writes, `.next`, `generated`, `+types` and the like, or one git ignores, is left alone); an import whose case differs from the file's; a named or default import a project module does not export, through `export *` chains (a CommonJS or script module, `export =`, JSON, styles and modules that re-export from a package are not judged); a bare import of a package no package.json between the file and the repository top declares (nor its `@types`, nor a workspace package, nor one declared by the packages that import a shared folder), that nothing installed provides, outside a `try`, and that is not a builtin, a runtime's module (`bun:`, `cloudflare:`, `k6`), a framework's virtual module (`virtual:`, `astro:`, `$app/`, `#imports`), an ambient `declare module`, or a word a bundler config's aliases name. Lines the change added are judged, and also an unchanged import of a file the change deleted or moved, or of a name the change removed from its module. Fixtures are left out. Target is `imports:<file>:<specifier>[#<name>]` |
| `boundaries` | An added import, on the same graph, crosses a line: a relative import from a workspace package's product code into another named package's code (tests, scripts, configs and tooling may); a value import of a workspace package the importing package's `package.json` does not declare; a new `index` file made only of re-exports that its package does not publish (`main`, `exports`, its root `index`) and that `gates.entryPaths` does not name, or `export *` added to one, unless the project already keeps three or more; a `"use client"` module whose value imports reach, through modules that are neither `"use client"` nor `"use server"`, one that imports a server-only package (database drivers and ORMs, `server-only`, `next/headers`, secret-holding SDKs, Node's system modules) or reads a non-public environment variable when it loads (`NEXT_PUBLIC_X \|\| X` is a fallback; t3-env's `createEnv` is built for this), reported on the added import on that path with the chain; with `gates.layers` (highest first), an import of a higher layer; with `gates.features` (a glob with one `*`), an import of another feature's files |
| `routes` | The change adds a link or navigation (JSX `href`, `to` on `Link`/`NavLink`/`Navigate`, an `href` in a menu object, `router.push`/`replace`, `redirect`, `navigate`, `goto`) to an internal path no page or route of its package answers, an API call (`fetch`, `axios.<method>`, `ky`, `$fetch`, `useSWR`) to a path no handler answers while the package serves API routes under that first segment and no other server in the repository could, or a call or link whose method the matching routes do not handle (`POST /api/x: the route handles only GET`). Routes come from Next.js (app router pages and `route` files with their exported methods, pages router), React Router and Remix flat routes or `app/routes.ts`, SvelteKit, Nuxt and Astro files, and from routes declared in product code: React Router `<Route>` nesting and route objects, TanStack `createFileRoute`, Express, Hono, Fastify and Elysia handlers placed under the prefixes their routers are mounted at, next.config rewrite and redirect sources, vercel.json. A `${…}` part matches one segment (a trailing one, several); query and hash are ignored; paths to files (`/logo.png`) and `public/` files are not checked. A client router's root `*` route is its not-found page and matches nothing. What cannot be read is unknown and never reported: a router mounted from a file that cannot be followed makes its prefix unknown, a route list built at run time or a computed rewrite source makes the package's paths unknown, and a middleware that rewrites, a `basePath`, `i18n` or `pageExtensions` turns page links off. Target is `routes:[<METHOD> ]<path>` |
| `env` | When the project lists its environment variables (an `.env.example`, `.env.sample`, `.env.template`, `.env.defaults`, `.dev.vars.example` or committed `.env`, `.env.development`, `.env.production` at or above the file; a t3-env `createEnv`, envalid `cleanEnv`, or a schema object of two or more UPPER_CASE keys in an env module), the change adds a read (`process.env.X`, `process.env["X"]`, destructuring, `import.meta.env.X`, `Bun.env.X`, `Deno.env.get("X")`) of a name no env file, schema or deployment file in the repository (wrangler, turbo, Dockerfile, compose, CI workflows, fly, render, netlify, vercel, railway) declares. Platform and tooling variables (`NODE_ENV`, `CI`, `PORT`, `VERCEL_*`, `GITHUB_*`…) and `SUPABASE_*` in Supabase Edge Functions are exempt; a read with a fallback (`?? x`, `\|\| x`, `?.`) is reported only when it is one or two letters off a declared name the file does not also read. The finding names the closest declared name. Test-runner configs and setup files are left out. Target is `env:<NAME>` |
| `new-deps` | A `package.json` gained a dependency. Each new npm package (not `workspace:`, `file:`, git or URL specs, `npm:` aliases by their real name, not scopes `.npmrc` maps to a registry) is looked up in the registry (`.npmrc`'s `registry`, or `INTERSITE_NPM_REGISTRY`; `INTERSITE_OFFLINE=1` asks nothing) in parallel, 4 s per request: a 404 is its own finding, target `npm-missing:<name>`, saying the name is invented; a package first published under 60 days ago or with 3 versions or fewer says so. A registry that does not answer changes nothing |
| `secrets` | An added line of any text file (code, env files, YAML, JSON, Markdown, shell, Dockerfiles, Terraform…) holds a credential of a known format: AWS, GitHub, GitLab, Slack (tokens and webhooks), Stripe live and webhook secrets, OpenAI, Anthropic, OpenRouter, Groq, xAI, Replicate, Hugging Face, Linear, SendGrid, Twilio, Shopify, PlanetScale, npm, Supabase (secret keys, access tokens, and JWTs whose payload has `"role":"service_role"`, except the local stack's `supabase-demo` ones), private key blocks, and Postgres/MySQL/Mongo/Redis/AMQP URLs with a password of eight characters or more on a host that is not local or a compose service. Placeholders never count (`xxxxxx`, `your_`, `<…>`, `${…}`, `example`, fewer than eight distinct characters). Also an env file (`.env`, `.env.local`, `prod.env`, `.dev.vars`; not example, sample or template) that sets a secret-named variable (`*SECRET*`, `*TOKEN*`, `*_KEY`, `*PASSWORD*`, `DATABASE_URL`…, not public-prefixed) to a real value, and an added keystore or SSH identity (`*.p12`, `*.pfx`, `*.jks`, `id_rsa`…). Lines in JavaScript and TypeScript are lint's (`no-hardcoded-secret`) for the formats it knows; tests, fixtures and mocks are left out. The secret is never printed, only its first characters. Target is `secrets:<file>:<kind>` |
| `auth` | The change adds or edits an endpoint that never checks who is calling, in a package where at least 3 endpoints of its kind exist and at least 70% of them (other than the ones this change adds unguarded) check. Endpoints: Next.js app router `route` handlers and `pages/api` routes, server actions (exported async functions of a `"use server"` file, inline `"use server"` functions) and TanStack `createServerFn` handlers, SvelteKit `+server` handlers and `+page.server` form actions, Remix/React Router `action` and `loader` exports, Express/Hono/Fastify registrations (`app.post("/x", ...handlers)`), tRPC `query`/`mutation` procedures and Convex `mutation`/`query`/`action` exports. A check is a call named for one (`getUser`, `auth`, `requireRole`, `getServerSession`, `verifyToken`…) or a project function that makes one, a middleware or wrapper passed with the handler, a route option (`config: { permission }`), a protected tRPC procedure, a custom Convex builder, a `.use(...)` or `.addHook(...)` before the route on the same app, a router mounted behind one (`app.use("/admin", requireAdmin, adminRouter)`), a Next.js middleware calling one whose matcher (and Clerk route matchers) cover the path, a read of the caller off the request (`req.user`, `locals.session`, `c.get("user")`), or a secret or signature comparison. Left out: paths public by name (auth, login, signup, callback, webhooks, health, cron, og, invite, verify, reset…), endpoints a comment above or route options call public, endpoints that reach nothing outside the request (no await, database or fetch), registrations in a router file none of whose routes checks (it is guarded where it is mounted), development-only routes, and server actions lint's `no-unguarded-server-action` already reports. Target is `auth:<file>:<endpoint>` |
| `structure` | How the change's code knows other code, read from every JavaScript and TypeScript file (tests, stories, fixtures, mocks, declarations and generated files left out), each name resolved by scope and followed through imports and re-exports to where it is declared. Only runtime uses count: a type import is erased when compiled. A module is a file, or a folder with what is in it (its `index` file is the folder's own code). `module-cycle`: modules side by side in one folder of one package that use each other in a circle; the change is judged when one of the circle's ties (all the uses one module makes of another) is made only by its added lines, reported at that tie, and `--all` reports every circle at its cheapest tie. `tangle`: top-level declarations that use each other in a circle, when the circle passes between a folder's own code and a file inside it (which `module-cycle` cannot see) or has more than 7 members. `field-leak`: an added line that assigns, `++`es or `delete`s a public field of a class instance, or calls a mutating method on it (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`, `set`, `delete`, `clear`, `add`, `append`), from outside the class, directly or through a getter that hands the field out; the instance is known from `new C()`, a `C` type annotation on a variable, parameter or class property (constructor parameter properties too), or an imported `export const x = new C()`, through barrels. Only classes that keep at least one field to themselves and have a method that works on their fields, and have no decorators (ORM entities, framework components and observable stores expect outside writes), are judged. `shallow-module`: a folder where one caller outside it (a function, each closure on its own, or a file's top-level code) uses more than 7 of the folder's functions on one thing (a class's methods called on a known instance, or free functions that use one of the folder's types or classes), more than 7 of its functions are used from outside, and it hides no more than it shows; React components and functions that only pass the call on are not counted; the change is judged when it adds one of those functions or one of that caller's uses of them, and the innermost such folder is the one reported. Target is `module-cycle <members>`, `tangle <file>:<name>…`, `field-leak <file>:<Class>.<field>` or `shallow-module <folder> <thing>` |
| `artifacts` | The change adds a leftover file: a backup or versioned copy (`*.bak`, `*_old.*`, `*-v2.*`), a scratch or debug script, a log or dump, or a stray planning document (`PLAN.md`, `SUMMARY.md`, `NOTES.md` and the like) |
| `unused` | The change adds a source file nothing references, adds an export nothing uses, or removes the last reference to a file and leaves the file behind |
| `fails-on-base` | The changed tests do not prove the change: they fail in the working tree (so failing on the base proves nothing), they pass on the base commit, they fail there only in a way that is not a test's verdict (they do not compile or load there, could not run, or did not finish in `--timeout`; a test of a hang gives itself a timeout so its runner reports it), or the base run's failures name only test files the change did not touch. Each finding says which. Needs `gates.testCmd`. `check --full` runs it without being listed when the branch name or a commit message since the base says fix, bug, hotfix or regression |
| `complexity` | A function the change added or edited has a cognitive complexity (SonarSource's definition: +1 per `if`, `else if`, `else`, ternary, `switch`, loop, `catch`, run of like `&&`/`\|\|`/`??`, labelled jump and recursive call, plus the nesting depth for the nesting ones; a function inside another nests) of 25 or more, and is new or grew by 10 or more since the base. An outermost function counts what is nested in it; a function passed straight to a call at the top level is named `<callee> callback`. Its base self is the function with the same name in the file git pairs it with; failing that, one no longer where it was in a file the change touched (moved, not copied) with the same body, the only such one with its name, or one whose body has 60% of the same words (moved, renamed and lightly edited at once). Tests, generated code, scripts and fixtures are left out. Target is `file:name` |
| `mutation` | A deliberate break in changed code leaves `gates.testCmd` passing, after Google's mutation testing: first each changed named function's body removed (`{}`, or `undefined` for an expression body), then one mutant per added line, never inside logging, telemetry or error-reporting calls, thrown errors, text joined with `+`, or types. A semantic mutant comes first on its line: an access guard removed (an `if` with no `else` that throws or returns, on a condition naming the user, session, role, permission, owner or tenant), an access check call removed (an awaited or bare `require*`/`assert*`/`ensure*`/`check*`/`verify*`/`authorize` statement), a tenant filter dropped from a query (a tenant-named key of a `where` object, `.eq("org_id", x)`, Drizzle's `eq(t.orgId, x)` in `and(...)` or alone in `.where`), an idempotency guard removed (a guard on `existing`, `already`, `processed`, `duplicate`…), a state-transition guard removed (on `status`, `state`, `stage`, `phase`), a cache invalidation removed (`revalidatePath`, `revalidateTag`, `invalidateQueries`, `cache.delete`…). Then an operator flip (`===`/`!==`, `<`/`>=`, `&&`/`\|\|`, `+`/`-`, `!` dropped, `true`/`false`, comparisons first), then any other guard removed or a catch that answers with a fallback made to rethrow. Once a function's removed body survives, nothing inside it is tried. A mutant whose run fails only because it does not compile or could not run is invalid, never killed; a timeout counts as killed. At most `gates.mutants` tries, and at most 3 survivors reported per file (that file is not mutated further). Each finding names the mutant and what it protected, and asks for a test that fails on it; the summary gives killed over valid mutants, the invalid count, and each semantic kind's killed over tried |
| `coverage` | A named function the change added or edited runs in no test: `gates.testCmd` runs once in the working tree with `NODE_V8_COVERAGE` set, and a function counts as run when V8 recorded a call to one of its name in its file (so transpiled TypeScript matches too). Tests, configs, scripts and fixtures are left out. A run that covered none of the project's code is a setup error. Target is `file:name` |

A deliberate exception is an entry in `gates.acknowledged`: `{ "gate", "target", "why" }`, where `target` is the file
path or dependency name. It silences that one finding and shows up in review. For one change only, a commit since
the base carries an `Intersite-Ack: <gate>: <why>` trailer: it accepts that gate's findings in this change and
never a later one. Every gate's failure line ends by
saying so, because an agent with no honest way out will find a dishonest one.

## Edit hook

`intersite hook` is a Claude Code `PreToolUse` hook for Edit, Write and MultiEdit, which `init` adds to
`.claude/settings.json` at the repository top (merged, keeping the project's hooks, never twice). It reads the hook's
JSON on stdin, builds the file as the edit would leave it, and judges the edit as `tamper` judges a change for an
evaluator file, and as `test-integrity` does for a file under `gates.testPaths`. A weakening edit exits 2 with one line
on stderr: what weakened, to fix the code instead, and that a human can make the edit or acknowledge it under
`gates.acknowledged` (the same targets as the gates', which let the edit through). Anything else exits 0 silently,
including bad input and an engine that was never built: the hook never builds the engine and never blocks on its own
failure. Shell edits (`sed`, `rm`) bypass it, which is why the gates stay.

## Stats

Every `check` in a git repository appends one line to `.intersite/ledger.jsonl`: `{ at, head, branch, base, findings:
[{ stage, target }], acknowledged: [{ stage, target }] }`, where a lint finding's stage is its rule and its target its
file, and `acknowledged` lists findings an acknowledgment let through. `intersite stats [--json]` prints one line per
gate and lint rule, `<stage>: N raised, F fixed (x%), A acknowledged (y%)`, most acknowledged share first; with no
data, one `ok stats:` line. A finding is fixed when an earlier run of a branch raised it and the branch's latest run
neither raises nor acknowledges it; acknowledged when a run let it through, `gates.acknowledged` lists it, or a
commit's `Intersite-Ack:` trailer names its gate (one per commit). It measures only: Google turns off an analyzer whose
findings developers mark not useful more than 10% of the time, and this is the number that decision needs. The
counting is in `core/src/stats.rs`.

## Search

`intersite search <file>[:<line>[-<line>]] | - [--max <n>] [--json]` finds the functions in the repository that contain
a piece of code: the function around a line, a range of lines, a whole file read as a snippet, or code on stdin. It
follows Aroma (Luan et al., OOPSLA 2019): each file is parsed into a simplified tree, every name and literal yields
features (itself, its place in up to three ancestors, the next name or literal, and a local variable's consecutive
uses), local names become `#VAR`, and a named function's features are its leaves'. Candidates are the 100 functions
sharing the most features with the query; each is pruned to the part that matches and ranked by the share of the
query's features that part holds. A match holds at least half and is not scattered (its lines span at most twice the
query's, plus ten); the query's own lines never match. Each match is one line, `path:line name: N% of the query, at
lines A-B`; with none, one `ok search:` line. Feature sets are cached per file content in
`node_modules/.cache/intersite/features-rust.bin`. Test files (`gates.testPaths`) and generated code are left out.

## Twins

`intersite twins [<file>:<line>] [--all] [--base <ref>] [--min <0-1>] [--max <n>] [--json]` finds functions that do
the same job in different code, which `similar` (same structure) misses. A named function's meaning is the words in it:
its name (counted twice), and every identifier, property, call and short string inside, split at case and underscores,
stemmed, and with synonyms folded (fetch, load, read, find and query are all "get"; add, insert and make are "create").
Words are weighted by TF-IDF across the repository, so words every function has count for little, and two functions
are alike by the cosine of their weighted words. Candidates come from an index of each function's eight strongest
words. With a line it lists the functions most like the one around it; otherwise each function the change added or
edited (or with `--all`, every one) is paired with the most alike function in another file, at 80% or more (`--min`;
below that, functions in one domain share words without doing one job).
Each pair is one line naming the words they share most. Functions under ten distinct words or three lines, tests,
fixtures, scripts and generated code are left out. It is advice, not a gate.

## Trace

`intersite trace` runs something and reports every project function it touched (`--touched` lists them with call
counts) and where its time went: own time per function, slowest first, time with what each calls, and time inside
each dependency. It reads V8's own records: the coverage files `NODE_V8_COVERAGE` writes and the `.cpuprofile` files
`--cpu-prof` writes (both set through `NODE_OPTIONS`, so every Node process a command starts is covered), or, for a
server, the inspector of every Node process it starts (`--inspect=127.0.0.1:0`): coverage is reset and the profiler
started before each request and read after it, so each request's trace holds only what it ran.

- `-- <command>`: a test suite, script or job; `--runs <n>` repeats it and takes medians (default 1, or 3 with `--base`).
- `--server "<command>" --url <origin>` with `--request "<METHOD> <path> [json body]"` (repeatable), `--requests
  <file>` (one per line), or `--replay [--sample <n>] [--seed <n>]` (recorded sessions through the project's adapter;
  ids in paths are folded to `:id`). Each request runs once to warm up, then `--runs` times.
- `--page <url> [--compare <url>]`: a page in Chrome (playwright-core): TTFB, FCP, LCP, CLS, blocking time over long
  tasks, requests and kilobytes, the JavaScript it ran (a dev server's module paths map to project files) and a CPU
  profile.

With `--base <ref>` the same run happens on that commit in a worktree (`--setup` or `gates.setup` installs it), base
and change runs alternating so a machine that warms up or gets busy weighs on both, and a function whose own time grew
by at least 20ms (`--min-ms`) and a quarter is reported as one line, `path:line name takes Nms of its own time, Mms on
the base (+P%)`, exiting 1. With two or more runs a side it must also be slower in its fastest run than in the base's
slowest; a function slower by median whose ranges overlap is listed on one `inconclusive:` line instead, and wall
times show their range, with `ranges overlap: within noise` when they do. With `INTERSITE_DATABASE_URL` set and `pg_stat_statements`
loaded, the queries the run sent are listed slowest first with their calls, each planned for the index it needs.
`--json` prints the report as one object. The crunching is in `core/src/trace.rs`.

## Replay adapter (experimental)

A project supplies the module named by `replay.adapter`. All exports are optional except `signIn`.

```js
/** Headers that authenticate a seeded test user of this role. `other: true` asks for a user of a different account. */
export async function signIn(actorKind, { target, other }) { return { cookie: "…" }; }
/** A seeded record to stand in for an ID the session did not create. Return undefined to skip that step. */
export async function resolveId(id, { target }) { return undefined; }
/** Runs before each session, for example to reseed. */
export async function reset({ target }) {}
/** Extra headers for every replayed request, signed in or not: an API version, an idempotency key per case. */
export function headers({ caseId, method, route }) { return {}; }
/** The application's observable state as JSON, read from the test environment (counts, balances, statuses). */
export async function state({ target }) { return {}; }
/** Checked after each baseline session; return a message when broken. `before` and `after` are `state()` from the
 * start of the session (after `reset`) and from now, when the adapter has `state`. */
export const invariants = [{ name: "ledger balances", async check({ target, fetch, before, after }) { return undefined; } }];
```

## Replay modes (experimental)

UI cases are skipped by every mode except `ui`.

- `baseline`: replay each session in order; a step passes when the status equals the recorded status and
  `shapeDiff(recorded, replayed)` is undefined: a recorded key missing or retyped fails, a key the replay adds passes (a client
  built before it ignores it). A step recorded with a 5xx is the reverse: it fails
  (`still fails as production did`) on a 5xx or no answer, and passes once the answer is below 500. A dropped
  connection is status 0 (`got no answer (<code>)`). `--json --verbose` adds the `recorded` request. A redirect is
  compared as answered, never followed; a `text/event-stream` answer is judged on its status and its body is not
  read; an answer that takes over 30 s is status 0. A refusal recorded with an `errorCode` passes when the replay
  answers the same status and code. In an array, a replayed row shape the recording had not seen passes while
  another replayed row matches a recorded one. A step whose recorded body is `{ $omitted }`, and a session whose
  actor kind `signIn` cannot sign in, are skipped with the reason. Then run the adapter's invariants.
- `twice`: send each non-GET request a second time; the second answer must not be a 5xx. A write whose first send
  got a 5xx or no answer is skipped: baseline reports it. A write that must repeat safely (PUT, DELETE, a route with a
  `webhook`/`webhooks` segment, since providers deliver at least once, or any write the adapter's `headers` give an
  `Idempotency-Key`) must also leave `state()` as the first send left it, when the adapter has `state`: `the second
  send changed the state again (<pointer> <before> → <after>): a repeated <method or webhook> must apply once`.
- `race`: send each write that must repeat safely twice at once, as a retrying client or a provider would. Neither
  answer may be a 5xx or no answer, and two successful answers may not hold different created IDs (`sent twice at
  once, it created two records (<id> and <id>): only one may apply`). Other requests are sent once, unjudged.
- `cross-tenant`: send each request that names an ID as `signIn(kind, { other: true })`; the answer must be 400, 401, 403,
  404 or 422 (many APIs validate before they check access). A request names an ID when its path or body holds one;
  a GET whose only ID is in the query gets the list check. A request with no ID (a create in the caller's own account) is not checked, and `anonymous` cases are
  skipped. A GET that names no ID (a list, search or dashboard) is sent as the other account too, once the session
  has created something, and fails when its answer holds an ID this session's writes created earlier. Only IDs first
  seen in the answer to one of the session's writes count, so shared records both accounts see (a catalogue, plans)
  pass; records the session did not create are not checked. Each checked request is then sent as its owner so the
  session's state keeps moving. A route in `replay.crossTenantIgnore` (`{ route, why }`) is public by design: it is
  not sent as the other account, so neither check reports it. Each FAIL line ends with the entry that would accept it.
- `contract`: lint the API's wire format across every route. Evidence is each sampled case's recorded request body
  and route and the production status and shape, plus, for each replayed case, the local server's body and headers.
  A convention is whatever at least 5 units and 90% of all units share (fields per route and pointer, routes, error
  answers, list routes); with less, nothing is reported. Findings are per method and route, one line each:
  `FAIL contract <METHOD> <route>: <pointer and what is wrong>; <n of m in this API do X>: <what to do> (case <id>)`,
  ending with the rerun command and the `replay.contractIgnore` entry that would accept it. Three or more findings
  with the same check, route, parent pointer and remedy are one group: one line on the parent pointer with the count
  and up to three examples; `--json` keeps every finding with its `group`, and an ignore entry on the parent
  silences the group. With `--id` it replays
  that case's session and takes the conventions from the seeded sample, so `--id` needs `--seed`. With `baseline`
  in the same run it reads the baseline answers instead of sending again. `--openapi <file>` (JSON, with
  `--mode contract` only) lints a documented contract with no server and no traffic. `check` in an ignore entry is
  one of casing, types, envelope, errors, status, values, exposure, size, requests, routes.
- `ui`: needs `replay.uiTarget`. It runs in the flows' engine in intersite-core (see "Flows"), one browser context
  per session, with Node sending each session's actions already signed in, its IDs resolved and its dates shifted. It
  drives Chrome Headless Shell when Playwright has installed one, else the installed Chrome; with
  `replay.browser: lightpanda` it starts `lightpanda serve` from PATH on a local port
  (exit 2 with an install line when it is missing) and runs one session at a time; with `replay.browserUrl` it connects
  over CDP to that running browser and leaves it running. Images are answered with a 1x1 GIF and fonts and media with
  an empty body, never fetched; stylesheets load, because the visibility checks need layout. For each distinct
  `action` in the session, in order: open `uiTarget + action.page` (IDs remapped as below) signed in with the
  adapter's headers (a `cookie` becomes browser cookies for the `uiTarget` and `target` origins only; other headers
  go only to those two origins); fail on a page error, a console error, or a 5xx from the API during load; fail when no element
  carries `data-intersite="<name>"`. When every recorded case of that action is a GET, click the element and fail on
  the same three things. An action with exactly one write case (POST, PUT, PATCH, DELETE) whose body is a JSON object
  or empty is filled and submitted: its form is the element or its closest `<form>`; each top-level body key fills the
  control with that `name` or `id` (IDs remapped, dates shifted; nested values left alone); then the form is
  submitted. It passes when a request with the recorded method to a path matching the route template was answered
  with the recorded status and none of the three checks fired. IDs the answer created are mapped for later actions.
  When a key has no control, or there are several write cases, only presence is checked and the step carries
  `checked: "presence"`.
  A page with a `_` segment cannot be rebuilt and is reported `skipped`. IDs in a page go through `resolveId`.

IDs: an ID the recorded response created (in `response.ids`) maps to the ID at the same pointer in the replayed
response, and later requests in the session are rewritten with it. An ID the session did not create goes to
`resolveId`; with no answer the step and everything after it in that session is reported `skipped`, not failed.

Dates: with `replay.shiftDates`, every ISO date or timestamp in a request's query and body is moved forward by the
time between the case's `at` and now, so "starts tomorrow" is still in the future. Each value keeps its format, and a
date without a time moves by whole days. `replaySessions` takes `now` as an option so this is exact in tests.

Metrics: a server may report per-request counters in `Server-Timing` as entries whose `desc` is a number, alone
or followed by a unit word (`queries;desc=7`, `db;desc="7 trips"`); entries with only `dur` are ignored, since durations vary and counts do not.
`--metrics-out <file>` writes `{ "_meta": { seed, sessions }, "<caseId>": { "<counter>": n } }` from the baseline
mode. `--metrics-base <file>` fails a case whose counter is higher than in that file (`FAIL metrics …`), and is a
setup error when the run replays other sessions than the file's; without `--seed` it reuses the file's seed. Compare
two local runs on the same data, never against production.

Snapshots: `--snapshot-out <file>` writes `{ "_meta": { seed, sessions, startedAt }, "<caseId>": { status, body } }` from the
baseline mode, with each body normalised so two runs of the same code on the same data are identical: an ID first
seen in the answer to one of the session's writes becomes `<id:n>`, an ISO timestamp within ten minutes of the run
becomes `<now>`, a string under a `requestId`, `traceId` or `correlationId` key becomes `<request-id>`, and one under a key ending
in secret, token or password becomes `<secret>`;
everything else is kept. `--snapshot-base <file>` fails each case whose status or values differ
(`FAIL snapshot <caseId> <METHOD> <route>: <pointer> <before> → <after>`, at most three per line), comparing arrays
by position, or by `id` when every row has a distinct one, so a reorder is one difference. Pointers matching a
`replay.snapshotIgnore` glob are left out. The seed rules are those of `--metrics-base`. The file holds response
bodies from the local server: keep it under `.intersite/`. Two timestamps whose offsets from their own run's
`startedAt` differ by under a minute are the same value, so `now + 7 days` matches across runs and 7 days becoming
14 does not. A file without `startedAt` still loads; its timestamps are compared as written.

## Flows (experimental)

A flow is a browser test as JSON (`Flow` in `replay/flow.mjs`, checked by `flowProblem`), kept in
`.intersite/flows/`. `intersite flow --from <caseId> [--out <file>]` writes the session up to that case as one
(`toFlow`); agents and people write them by hand too.

```json
{ "as": "member", "env": { "rtt": 600, "down": 1.5, "cpu": 4, "viewport": [390, 844], "mobile": true },
  "steps": [
    { "open": "/ads" },
    { "click": { "in": "nav", "role": "link", "label": "Paid ads" } },
    { "click": { "in": "ads.list", "nth": 0 } },
    { "click": "ad.new" },
    { "reload": true },
    { "fill": { "headline": "Spring sale", "budget": 50 }, "at": 2300 },
    { "click": { "in": "ad.form", "role": "button", "label": "Save" }, "expect": "POST /api/ads 201", "ids": { "/ad/id": "ad_123" } },
    { "see": "Spring sale" }
  ] }
```

Each step has exactly one verb. `open` goes to a path on `replay.uiTarget` (IDs remapped as replay does; after a
click that already navigated there, it does not load the page again). `reload` reloads. `click` takes a
`data-intersite` name or `{ in, nth, role, label }`: inside the named element, its nth list item, then the element
with that role and accessible name (`_` matches one word). `fill` sets each named control (`name` or `id`) as the
`ui` mode does. `see` waits up to 5 s for visible text. A click's `expect` (`"METHOD /route status"`) waits for that
request's answer and fails on another status (a recorded 5xx passes once the answer is below 500); `ids` maps the
JSON pointers of IDs it created to the recorded IDs, for later steps. `at` is the step's recorded time after its page
loaded. `as` signs in through the adapter.

`intersite flow [<file>...]` plays every flow (default `.intersite/flows/*.json`) in intersite-core
(`core/src/flow.rs`), which drives one browser over the DevTools protocol with no automation library: Chrome
Headless Shell when Playwright installed one, else the installed Chrome (or `replay.browserUrl`, or Lightpanda). Each
flow gets its own browser context. The engine reads its options from the first stdin line, prints `{"ready": true}`
once the browser is up, and takes each job as a `{"run": <i>, "flow": {...}}` line until stdin closes. Before a job
sent without `prepared`, it prints `{"prepare": <i>}` and Node answers with the adapter's reset, sign-in and resolved
IDs, since the adapter is the project's JavaScript. Flows run
`--concurrency <n>` at a time (one when the adapter has `reset`, which runs before each flow, or with Lightpanda). A flow stops at its first failed or skipped step, and fails on a page error, a console error or a 5xx
from the app or API, at that step or after the last. `--network recorded` (the default) plays a flow with `env` on
that connection and device: Chrome's network and CPU throttling, the viewport, touch and mobile, and each write's
answer delayed by `rtt`; `none` plays it unthrottled. `--timing fast` (the default) acts as soon as each element is
there; `recorded` acts at each step's `at` after the page commits, as the user did. Output: one line per failed or
skipped flow, `FAIL flow <file> step <n> <verb>: <reason>; rerun: npx intersite flow <file>`, then
`ok flow: <passed> of <n> flows passed`; exit 1 when one failed. Non-local targets need `--allow-remote`.
