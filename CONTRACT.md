# Intersite contract

What every part of this package agrees on. Change it here first, then in code.

## Parts

| Folder | Runs in | Does |
| --- | --- | --- |
| `lint/`, `cli/lint.mjs` | Node, inside oxlint | Slop rules, mostly declared in JSON; baseline that only shrinks |
| `gates/`, `cli/gate.mjs` | Node, local or CI | Each gate's git work (the diff, the files, the config's globs) and its output; the judging is in `core/` |
| `core/` | Rust, built by cargo the first time a check needs it (and again when its source changes) | The analysis engine, called with one JSON request per check: similar (lexer, k-grams, Aroma features), duplicates, unused, naming, style-drift, value-drift, sql (with planning against a database), regex, artifacts, test-integrity, new-deps, mutation's choice of mutants, routes, env, search, twins, trace reports |
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
- Node code is plain ESM `.mjs` with `// @ts-check` and JSDoc types. No TypeScript files: the package is installed
  straight from GitHub (`"intersite": "github:<owner>/intersite#<tag>"`), and Node refuses to strip types under
  `node_modules`. Node stays where it must: the CLI entry, git and process orchestration, the oxlint rule plugins,
  `capture/` and `track/`, the collector, and replay (adapters are the project's JavaScript).
- One runtime dependency, `yaml`, used only where config and rule files are read (never in `capture/` or `track/`).
  `oxlint` and `@oxlint/plugins` are optional peers that `lint` needs (a package that only imports
  `intersite/capture` or `intersite/track` installs neither); `playwright-core` is an optional peer used only
  by the `ui` replay mode and `trace --page`; `wrangler` is a dev dependency, and `oxc-parser` one only for search's recall test.
- `capture/`, `track/`, `shared/case.mjs` and `shared/shape.mjs` use only web-standard APIs.
- Tests are `node --test` files under `test/<part>/`. Test behavior through the part's public entry, not its internals.
- A deliberate shortcut gets a `// ponytail: <ceiling>, <upgrade path>` comment.
- The package passes its own `npm run lint` with an empty baseline.

## CLI output (every command)

Agents read this output, and every line costs them context.

- Success is one line: `ok <command>: <counts>`.
- A finding is one line: what and where, then `| rerun: <exact command>` when a narrower rerun exists.
- Nothing decorative: no banners, colours, progress bars or blank lines. `--json` prints structured data instead.
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

### Headers

| Header | Set by | Meaning |
| --- | --- | --- |
| `x-intersite-action` | `track/` | Action name for this request |
| `x-intersite-page` | `track/` | Page path, already reduced as above |
| `x-intersite-session` | `track/` | Random per-tab ID; capture uses it as the session when the caller gives none |
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
shared package's pricing; `new-deps` also checks the workspace root's `package.json` for a project in a subfolder.
`fails-on-base` and `mutation` use a worktree of the whole repository and run `gates.testCmd` in the project's
folder inside it, each run limited to `--timeout` seconds (120 by default): for `fails-on-base` a run that does not
finish is stopped and counts as failing on the base, like any other failure there.
`intersite gate <name> [--base <ref>]` runs one; `intersite check` runs those in `gates.run`.

| Gate | Fails when |
| --- | --- |
| `test-integrity` | A test file was deleted, or has fewer tests or fewer assertions than on base, or gained a skip |
| `duplicates` | An added block of `gates.duplicateLines` or more lines already exists elsewhere in the repository |
| `similar` | An added function, component, hook, class or type already exists under another name: the same structure once local names and literals are set aside. Or added lines hold 80% or more of an existing function's structural features (one of 30 or more names and literals) inside a function at least half again its size: a helper pasted instead of called. Exact pasted blocks are left to `duplicates`. Target is `file:Name` |
| `naming` | The change adds a file or folder whose casing, shared suffix (`*.service.ts`) or test pattern differs from what a clear majority of its siblings keep, or whose main export is named unlike the file where its siblings match theirs. Conventions are inferred per folder and file kind, never configured |
| `style-drift` | The change adds a styling value that is nearly one the project already has (a colour within the just-noticeable difference, a size a pixel off its scale), a literal equal to a token's value, a value off a closed font-size, weight or radius scale, or a token that nearly duplicates another in its family |
| `value-drift` | A string, JSX text or comment states a money figure (a percentage, basis points, cents, or dollars under $100) in a sentence with a money word, and the `const` sharing two or more of its words, one of them a money word, holds a different value once its unit word (`Bps`, `Percent`, `Rate`, `Cents`, `Dollars`) is applied; or one money rate is set to two values in two files. Either side being changed counts. Sentences with an example marker (`for example`, `e.g.`, `if`, `say`) or code (`{`, `}`, `=`), input bounds (`between`, 0%, 100%), zeros, `let`s, Markdown, tests, seeds, fixtures and scripts are left out |
| `sql` | Added SQL (in `.sql` files, or in code: tagged `sql`/`$queryRaw` templates, `pool.query("…")`, and strings that read as statements) that locks or breaks a live table: a column added `NOT NULL` with no default, `CREATE INDEX` without `CONCURRENTLY`, a foreign key added without `NOT VALID`, `SET NOT NULL`, a column type change, a dropped or renamed column or table (a table created in the same file is not live yet); a foreign key no index starts with (indexes, primary keys and unique constraints are read from every migration), or whose column type differs from the column it references (`text` pointing at `uuid`, `integer` at `bigint`); a `text`/`varchar` column filled by `gen_random_uuid()`, and a Prisma `String @default(uuid())` field without `@db.Uuid` (new tables included); in code only, `UPDATE`/`DELETE` with no `WHERE`, `SELECT *`, `ORDER BY random()`, `OFFSET` by parameter or of 50 or more, `LIKE '%…'`, `NOT IN (subquery)`, a function around an indexed column in a comparison; a database call (`prisma.x.findMany`, `db.select`, `pool.query`, `supabase.from`, an awaited `sql\`…\``) inside a loop or a per-item callback, one finding per loop, unless the line above it or the loop says `no-await-in-loop -- <why>`. With `INTERSITE_DATABASE_URL`, each new query in code is prepared and its generic plan explained (never executed, in a read-only transaction rolled back); a sequential scan with a filter over 10,000 rows or more is reported with the `CREATE INDEX CONCURRENTLY` it needs. Statements are parsed one at a time (sqlparser, Postgres dialect), so one it cannot read hides nothing else. With `--all`, a migration already in the repository is history: its locks and breaks are not judged (the summary counts them), only the schema the migrations leave behind (foreign keys and their indexes and types, UUID columns, as the latest migration declares them) and the queries in code |
| `regex` | An added regular expression (a literal or `RegExp("…")`) whose backtracking doubles with each character on a crafted input: an unbounded repeat inside an unbounded repeat where what else the group needs is optional or can be matched by the inner repeat (`(\w+\s?)+`), or a repeated choice whose alternatives can start the same way (`(a\|aa)+`). Linear-run patterns (`\s+$`) are quadratic too but need very long input, and are not reported. Also a full-string validator (`^…$`) for email, phone, UUID, URL or IP, named only for that (`EMAIL_RE`, `isValidPhone`), that another file writes differently in meaning (`\d` and `[0-9]` are one pattern) |
| `decisions` | The change adds a read of a decision three or more files of one package make on their own: an environment variable (`process.env.X`, `import.meta.env.X`, `Bun.env.X`, `Deno.env.get`) read outside an env module (`env`, `config`, `settings` files or folders; `NODE_ENV`, `DEV`, `PROD`, `MODE` and the like are exempt), a feature flag (`isEnabled("x")`, `useFlag("x")`…), or a comparison or `switch` over a `kind`, `type`, `variant`, `mode`, `tier` or `plan` property against two or more of the same values in the same files (one value per file is a caller handling a result, and is not reported). Target is `decisions:<env\|flag\|branch>:<key>` |
| `renames` | A replaced line differs from the line it replaced by one identifier swapped for another (four characters or more, several words or eight characters), that old name appears in no file's code any more, and it is still written in a string, comment or text file (Markdown, YAML, JSON, HTML…; changelogs, lockfiles and migrations are history and left out). Target is `renames:<old name>` |
| `schema-drift` | An interface or object type alias (no `extends`, no type parameters, four keys or more, all static) has exactly the keys of a zod, valibot, yup or TypeBox object schema or a Drizzle table declared as a variable in the same package, and either side is changed. The finding names the derived type (`z.infer<typeof X>`, `typeof table.$inferSelect`) |
| `routes` | The change adds a link or navigation (JSX `href`, `to` on `Link`/`NavLink`/`Navigate`, an `href` in a menu object, `router.push`/`replace`, `redirect`, `navigate`, `goto`) to an internal path no page or route of its package answers, an API call (`fetch`, `axios.<method>`, `ky`, `$fetch`, `useSWR`) to a path no handler answers while the package serves API routes under that first segment and no other server in the repository could, or a call or link whose method the matching routes do not handle (`POST /api/x: the route handles only GET`). Routes come from Next.js (app router pages and `route` files with their exported methods, pages router), React Router and Remix flat routes or `app/routes.ts`, SvelteKit, Nuxt and Astro files, and from routes declared in product code: React Router `<Route>` nesting and route objects, TanStack `createFileRoute`, Express, Hono, Fastify and Elysia handlers placed under the prefixes their routers are mounted at, next.config rewrite and redirect sources, vercel.json. A `${…}` part matches one segment (a trailing one, several); query and hash are ignored; paths to files (`/logo.png`) and `public/` files are not checked. A client router's root `*` route is its not-found page and matches nothing. What cannot be read is unknown and never reported: a router mounted from a file that cannot be followed makes its prefix unknown, a route list built at run time or a computed rewrite source makes the package's paths unknown, and a middleware that rewrites, a `basePath`, `i18n` or `pageExtensions` turns page links off. Target is `routes:[<METHOD> ]<path>` |
| `env` | When the project lists its environment variables (an `.env.example`, `.env.sample`, `.env.template`, `.env.defaults`, `.dev.vars.example` or committed `.env`, `.env.development`, `.env.production` at or above the file; a t3-env `createEnv`, envalid `cleanEnv`, or a schema object of two or more UPPER_CASE keys in an env module), the change adds a read (`process.env.X`, `process.env["X"]`, destructuring, `import.meta.env.X`, `Bun.env.X`, `Deno.env.get("X")`) of a name no env file, schema or deployment file in the repository (wrangler, turbo, Dockerfile, compose, CI workflows, fly, render, netlify, vercel, railway) declares. Platform and tooling variables (`NODE_ENV`, `CI`, `PORT`, `VERCEL_*`, `GITHUB_*`…) and `SUPABASE_*` in Supabase Edge Functions are exempt; a read with a fallback (`?? x`, `\|\| x`, `?.`) is reported only when it is one or two letters off a declared name the file does not also read. The finding names the closest declared name. Test-runner configs and setup files are left out. Target is `env:<NAME>` |
| `new-deps` | A `package.json` gained a dependency |
| `artifacts` | The change adds a leftover file: a backup or versioned copy (`*.bak`, `*_old.*`, `*-v2.*`), a scratch or debug script, a log or dump, or a stray planning document (`PLAN.md`, `SUMMARY.md`, `NOTES.md` and the like) |
| `unused` | The change adds a source file nothing references, adds an export nothing uses, or removes the last reference to a file and leaves the file behind |
| `fails-on-base` | The changed tests pass on the base commit, so they do not test the change. Needs `gates.testCmd`. `check --full` runs it without being listed when the branch name or a commit message since the base says fix, bug, hotfix or regression |
| `mutation` | A small deliberate break on a changed source line leaves `gates.testCmd` passing. At most `gates.mutants` tries |

A deliberate exception is an entry in `gates.acknowledged`: `{ "gate", "target", "why" }`, where `target` is the file
path or dependency name. It silences that one finding and shows up in review. For one change only, a commit since
the base carries an `Intersite-Ack: <gate>: <why>` trailer: it accepts that gate's findings in this change and
never a later one. Every gate's failure line ends by
saying so, because an agent with no honest way out will find a dishonest one.

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
/** Checked after each session; return a message when broken. */
export const invariants = [{ name: "ledger balances", async check({ target, fetch }) { return undefined; } }];
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
  got a 5xx or no answer is skipped: baseline reports it.
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
- `ui`: needs `replay.uiTarget` and `playwright-core`. It drives Chrome Headless Shell when Playwright has it installed,
  else the installed Chrome; with `replay.browser: lightpanda` it starts `lightpanda serve` from PATH on a local port
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
