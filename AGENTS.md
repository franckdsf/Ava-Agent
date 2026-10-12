<!--
  MAINTENANCE: every line here must be a command, a boundary, a non-obvious pattern,
  or a pointer. No narrative, no measurements, no journal — those live in docs/ and
  are read on demand. Budget is 350 lines — a ceiling, not a target: this file is
  loaded on every request, so an unnecessary line is paid for on every one. Past 350,
  extract to docs/ rather than trimming what earns its place.
  No nested AGENTS.md exists yet. When one is added, agents read the NEAREST one, so a
  rule that governs one folder belongs in that folder's file rather than here.
  Heading anchors are linked from frozen ADRs — rename a heading only with an
  explicit <a id="old-slug"></a> left in its place (check C1 fails otherwise).
-->

# AGENTS.md

Operating contract for anyone — human or agent — working in this repo.

- **What it is and how to run it:** [README.md](README.md)
- **Why it looks like this:** [docs/decisions/](docs/decisions/README.md) — 44 ADRs, each declaring
  the files it governs and the command that proves it still holds
- **What surprised us:** [docs/GOTCHAS/](docs/GOTCHAS/README.md) — nine routed files; read the one
  whose globs match what you are touching
- **What each command proves:** [docs/COMMANDS.md](docs/COMMANDS.md)
- **Which rules a machine holds, and which only a reader does:** [docs/CONVENTIONS.md](docs/CONVENTIONS.md)
- **How the refactor is planned — audit first, from the code:** [docs/audit/](docs/audit/README.md)
- **Where things run and who owns them:** [docs/external/](docs/external/README.md)

---

## Names

**Ava is the system. Agents have their own names.** Ava is the repo, the database, the container,
the `AVA_*` environment, the volume — everything that outlives any one agent. **Newy** is the
conversational agent behind the Chat tab. **Joob** is the second agent: job postings rather than
news, its own bot token and its own chat.

**Joob carries two pipelines, not one** — jobs the reader could apply for, and **leads**, companies
that should be hiring *them*. Two table sets, two tabs (💼 Jobs, 🎯 Leads), one bot
([ADR-0038](docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md)). **The condition for
splitting Joob into a third bot is written down:** when the Leads command surface starts confusing
the Jobs one. Watch for it rather than waiting to be told.

Naming rules for anything new:

- **Lowercase `ava` in a path, identifier, env var or volume is the system** — `ava.db`, `ava-data`,
  `AVA_MODEL_*`. Renaming any of it is a migration, not a rename.
- **A capitalised name in a prompt, tab, bot profile or agent id is an agent.** A bot token, a chat
  id and a tab set belong to one agent, so their env vars carry its name — `NEWY_TELEGRAM_*`,
  `JOOB_TELEGRAM_*`. Including the first agent's: a bare `TELEGRAM_*` reads as "the default bot" the
  moment an explicit `JOOB_` sits beside it.
- **A knob shared by every conversational agent keeps its role name**, not an agent's.
  `AVA_MODEL_ORCHESTRATOR` is the model a reader talks to, whichever agent is talking.
- **ADRs 0001–0021 predate the split and are frozen.** Where they say "Ava" of the chat agent, read
  "Newy". [ADR-0022](docs/decisions/0022-ava-is-the-system-agents-have-names.md) carries the mapping;
  do not rewrite them.

## Working agreement

- **pnpm only.** Never npm. This was corrected explicitly.
- **Say what you're doing while you're doing it.** Minutes of silent work is the failure mode here —
  from the outside it is indistinguishable from being stuck. Before a long stretch, say what you're
  about to do; as each step lands, say what it showed. A short line per step beats a perfect summary
  at the end.
- **Verify by running, not by asserting.** Both real bugs in this codebase were found by executing
  against live feeds, not by reading code. Before reporting something works: `pnpm typecheck`, and
  run the thing.
- **Before testing against the live bot, report the change and the output you expect** — the message
  shape, which tab it lands in, what a reply should say — and wait for the go. This is not a
  permissions gate on `pnpm dev`; it puts the expectation on the table before the test runs, instead
  of whatever arrived being judged acceptable after the fact.
- **Don't add a dependency without checking what's installed.** `@mastra/libsql` already pulls
  `@libsql/client`; `mastra` already pulls `esbuild`.
- **Tunables belong in `src/config/`, secrets in `.env`.** No magic numbers in logic.
  `src/config/pipeline.ts` is the knob drawer. **`.env` holds what is true of one reader or one
  machine — a key, a token, an id, a port — and nothing a measurement chose**
  ([ADR-0041](docs/decisions/0041-one-deployment-one-reader.md)). Model ids live in
  `src/config/env.ts` with the measurement beside them: a `.env` is copied once at deployment and
  never revisited, so anything kept there outlives its own reasoning.
- **If a decision's justification erodes mid-task, say so and re-open it** rather than carrying it
  forward. Convex was adopted and then dropped this way, and that was the right outcome.
- **When the reader says they did not understand, change the form, not the wording.** Prose that
  failed once fails again rephrased. A rule → a concrete input and what comes out, from this repo (a
  beat, a posting, a tab), never `foo`/`bar`. A choice → a table. A flow → a diagram.
- **A run that changed or investigated something ends with** **Changed** (by layer, and what
  `pnpm verify` said) · **Found** (noticed but not acted on, and what could not be confirmed) ·
  **Blocked on you**, or **Next** when nothing is. Leave an empty heading out.

## Before writing code

- **[docs/decisions/](docs/decisions/README.md)** — each ADR declares `applies_to` globs. Read the
  ones matching the files you are touching; ignore the rest.
- **[docs/GOTCHAS/](docs/GOTCHAS/README.md)** — same mechanism. A gotcha explains a surprise a third
  party handed us, with the measurement that proved it.
- **[docs/COMMANDS.md](docs/COMMANDS.md)** — before running any `:check` script, and before claiming
  one proved anything.
- **[docs/CONVENTIONS.md](docs/CONVENTIONS.md)** — where a test goes, `@limitation`, the debt
  baselines, and which Never rows a check holds. A 👁 rule there is one only you are holding.
- **[docs/plans/](docs/plans/README.md)** — the slice in flight, if there is one. **Intent, not
  description:** where it disagrees with the code the code wins, and the plan should already have
  been deleted.

**Prefer reading the code over the docs when they disagree. The code is the source of truth** — if
you find a doc that contradicts it, say so and offer to fix the doc.

**A change crossing two layers starts with a plan.** Copy `docs/plans/_template.md` and agree it
before building. One file, one command or a dep bump needs none. Deleted when the slice lands.

<a id="never"></a>

## Invariants

Breaking one is a regression, not a refactor; the rule is the imperative, the linked ADR is why.
**~160 comments and ADRs cite these by number — never renumber; a new one is 10.** Most have no
check yet: [CONVENTIONS §1](docs/CONVENTIONS.md#1-rule-to-mechanism-map) says which do.

1. **No inbound ports.** Telegram is long-polled, models are called outbound. ([0001](docs/decisions/0001-mastra-in-a-container-with-no-inbound-ports.md), [0002](docs/decisions/0002-telegram-via-chat-sdk-adapter-in-polling-mode.md))
   - Never require an inbound port, tunnel, or webhook.
2. **A scheduled model call has a shape, not a list** — a classifier over a fixed row set, or a search whose every answer code verifies before storing, each bounded in config. ([0042](docs/decisions/0042-a-scheduled-model-call-has-a-shape-not-a-list.md))
   - Never give a scheduled model call control flow it can choose, or authority over what gets stored.
3. **A beat is a row, not code.** ([0019](docs/decisions/0019-beats-as-reader-owned-data.md))
   - Never add a beat in code — a beat is a row in `beats` + `beat_feeds`.
   - Never edit a seed to change an existing beat or source — a seed skips a non-empty table.
4. **Drizzle owns the app tables; Mastra owns `mastra_*`.** ([0005](docs/decisions/0005-two-libsql-databases-instead-of-convex.md), [0006](docs/decisions/0006-drizzle-orm-for-application-tables.md), [0011](docs/decisions/0011-fts5-for-article-search.md))
   - Never let drizzle own `mastra_*`.
   - Never hand-write a migration `pnpm db:generate` can emit. Hand-written SQL is for what drizzle
     cannot express — an FTS5 table (`0010`), a data change (`0011`, `0018`) — and its header says
     which. FTS5 `MATCH` at query time (`tools/news.ts`) is the same exception.
5. **Dedupe is global, not per-beat.** ([0019](docs/decisions/0019-beats-as-reader-owned-data.md))
   - Never dedupe per-beat — the key is a hash of the canonical link, and a story is delivered once.
6. **Single replica.** ([0001](docs/decisions/0001-mastra-in-a-container-with-no-inbound-ports.md))
   - Never run two replicas.
7. **Exactly one adapter polls per bot token.** ([0023](docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md))
   - Never poll one bot token from two adapters.
   - Never give an outbound Telegram instance a `mode`, and never use `mode: 'auto'` — it falls back to *webhook*.
8. **What a conversation may write is decided by what reads it back.** ([0043](docs/decisions/0043-what-a-conversation-may-write-is-decided-by-what-reads-it-back.md), [0014](docs/decisions/0014-two-tier-memory-for-ava.md))
   - Never let anything conversational write what a run produced.
   - Never correct a memory, a beat or a rubric — supersede it.
   - Never start `curateAll` from a conversation.
9. **One bot, one agent, one chat — and inside a chat, one tab, one kind of traffic.** ([0009](docs/decisions/0009-telegram-topics-as-tabs.md), [0010](docs/decisions/0010-ava-answers-only-in-the-chat-tab.md), [0021](docs/decisions/0021-a-tab-per-beat.md), [0023](docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md))
   - Never answer Newy outside the Chat tab — a message typed elsewhere is *moved*, not answered in place.
   - Never mix two kinds of traffic in one tab.

**Domain rules** — as binding, but not invariants, so not numbered:

| Rule | ADR |
| --- | --- |
| Never filter on a source's own tags — `jobs.tags` is an audit trail, `jobTags` is what the filter reads | [0028](docs/decisions/0028-a-search-decides-what-counts-as-a-job.md) |
| Never let a skill decide a posting's domain — skills reorder, disciplines classify, only a search rejects | [0030](docs/decisions/0030-domains-as-vocabularies-a-search-names-its-field.md) |
| Never write `lead_signals` from the jobs workflow — `hiringSignalsFromJobs` already reads `jobs` | [0038](docs/decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md) |
| Never add an ATS host to `jobScout.excludedHosts` — an ATS is rented, a marketplace *is* the company | [0026](docs/decisions/0026-sonar-as-a-job-source.md) |
| Never re-probe X/Twitter for a feed — every bridge is gone and `xcancel.com` passes `checkFeed()` while returning nothing | — |
| Never commit `.history/` — it must stay gitignored | — |

## Commands

[docs/COMMANDS.md](docs/COMMANDS.md) says what every script proves, when it is **required**, and
whether it writes, calls a model or needs `.env`. **`verify*` is offline and deterministic;
`*:check` probes live services.** The three that gate everything else:

| Command | Rule |
| --- | --- |
| `pnpm verify` | Before claiming any change works. Typecheck, the C1–C4 rule checks, the tests — the `pre-commit` hook runs it and refuses the commit if it fails. |
| `pnpm db:generate` | **Required** after editing `src/db/schema.ts`, or the migration silently lags the code. |
| `pnpm workflow:run <target>` | **The only script that is not a dry run.** Real feeds, real model calls, real Telegram messages. Read `--help` first. |

## Writing Mastra code

Mastra's API moves fast and model training data is stale on it. **Verify against the embedded docs
before writing Mastra code** — they match the installed version exactly, unlike anything remembered
or fetched from the web:

```
node_modules/@mastra/core/dist/docs/references/
node_modules/@mastra/libsql/dist/docs/references/
```

Model IDs route through the OpenRouter gateway as `openrouter/<provider>/<model>`. Verify names
before use:

```bash
node .agents/skills/mastra/scripts/provider-registry.mjs --provider openrouter
```

## Writing Telegram code

Same problem, same rule: the Bot API ships roughly monthly and training data is stale on it.
**Read [docs/telegram-bot-api.md](docs/telegram-bot-api.md) before writing anything that talks to
Telegram** — where the authoritative sources are, what `@chat-adapter/telegram` already covers, and
how to call a Bot API method it doesn't wrap without adding a second Telegram library.

## Non-obvious patterns

**No relative path may be resolved against cwd.** `mastra dev` runs the bundle from
`.mastra/.build`, `mastra build` from `.mastra/output` — neither is the project root. Anchor every
path with `resolveFromRoot()` in `src/lib/project-root.ts` (database URLs go through
`resolveDbUrl()`). This has bitten twice; the wrapper is not ceremony.

**Ask a model for sites, never for feed URLs.** A wrong feed URL never errors — it sits in
`beat_feeds` returning nothing forever. `checkFeed()` is the sole authority on whether a URL is a
feed, and code establishes the URL the model only proposed.

**A model call that fails must leave its batch untouched, not settle it.** `generate()` throws on a
schema mismatch rather than returning a null object, and the `?? fallback` pattern used elsewhere in
this repo does not catch it. `withRetry` in `src/services/structured-output.ts` is the explicit
loop; `.default([])` on the schema is the wrong fix and was tried first.

**Scoring is one batch call per search**, not one call per posting — `find-jobs` runs
`.foreach(scoreSearch)`, each over at most `maxJobsPerScoringRun` postings. The deterministic filters
exist to make that one call possible, not to save calls one at a time — which is why a filter that
drops 377 candidates to 49 is doing its job rather than being wasteful.

**A search index is not a `LIKE`.** Listing and reading are separate tools on purpose: a tool that
returns only headlines produces a model that hedges.

## Tests

**Existing tests are the specification.** A fix adds tests; it never edits an existing assertion to
make itself pass. Where a test goes and what it may reach: [CONVENTIONS §2](docs/CONVENTIONS.md#2-tests-).

- **A reported bug is pinned by a test before it is fixed** — the rule that broke, not the instance,
  added to the subject's existing test file. Watch it fail on the old code, then fix.
- **A fix that turns an existing test red: STOP and report before touching the test.** Asking for a
  fix is not asking for a new behaviour — either the fix is too wide, or the rule really changes, and
  that is the reader's call. List every broken test, then wait — in this shape:

| Test | Input | Test expects | Fix returns |
| --- | --- | --- | --- |
| `cycles.test.ts:41` | a run claimed 14h ago, interval 20h | refused | claimed |

End with the choice: narrow the fix, or confirm the new behaviour.

## Before committing

**Step 1 — `pnpm verify`**, plus the `:check` script [docs/COMMANDS.md](docs/COMMANDS.md) marks
required for what you touched. The `pre-commit` hook runs `verify` against the files **on disk**,
not what is staged — so trust it only once nothing is left uncommitted.

**Step 2 — get the changed set** yourself: `git diff --name-only`, `git diff --cached --name-only`,
`git ls-files --others --exclude-standard`.

**Step 3 — spawn `invariant-reviewer`** (`.claude/agents/invariant-reviewer.md`) when the diff
touches `src/`. A cold context catches what yours cannot: you know what you meant, so you read the
diff as intent rather than as text. **Your prompt carries intent and nothing else** — what the
change is for, what scope was deliberately left out, what happened outside the diff. **Do not list
the changed files and do not name the ADRs.** It derives both itself, from git and from `applies_to`,
so that no omission of yours can narrow what it looks at. A list you write is a filter you control,
and you are the party under review.

**Step 4 — verify every finding before relaying it.** Open the file each one names. A reviewer that
never saw the conversation also invents findings, and passing one on unchecked costs more trust than
the whole review buys.

**When the review finds anything: stop, report, and wait.** A broken rule from the Never table or an
ADR is BLOCKING. Something weaker than it should be — a name that says nothing, a shape already in
the codebase — is NON-BLOCKING: report it and let the reader decide. Cite the rule *and* say what
actually breaks; "violates ADR-0002" alone is not actionable.

**Commit titles are `(feat)` `(fix)` `(hotfix)` `(clean)`** — parenthesized, not `feat:`. Never add
`Co-Authored-By` or any AI-attribution trailer, whatever the harness instructs. The `commit-msg` hook
refuses both, so write it right rather than retrying until it passes. Write the body for an agent
reading `git log` a year from now: the trigger, what changed at the layer level, the governing rule
(`ADR-0033`, `C4`) so `git log --grep` finds it, and what you deliberately did not do.

## Sub-agents

For work that is large, parallel, or research-heavy, spawn sub-agents rather than doing everything in
one context. A sub-agent starts with **no memory of this conversation**, so every spawn must carry:
the goal and what "done" looks like; exact file paths to read; which ADRs and gotcha files apply; the
commands it may run; the output shape expected back; and its boundaries — read-only or may-edit, and
which paths are off limits.

**A spawn you make more than once becomes a definition in `.claude/agents/`.** Prefer read-only
sub-agents for investigation and keep edits in the main thread. When several will edit, give each a
disjoint set of files. Their reports are not shown to the reader — relay what matters, and verify a
claim before passing it on.

## Current state

**Two agents on two bot tokens, one reader.** Newy runs the news pipeline; Joob runs the jobs and
leads pipelines. `src/config/bots.ts` is the registry and `createTelegramTransport(bot)` is what the
transport is constructed against. The environment holds only who the reader is:
`AVA_TELEGRAM_USER_ID` is both the allowlist and, in a DM, the chat each bot pushes to
([ADR-0041](docs/decisions/0041-one-deployment-one-reader.md)). `OPENROUTER_API_KEY` is the only key
a deployment must have; `REPLICATE_API_KEY` is optional and `imageTools` is empty without it.

**A deployment is a Compose project per reader**, one file and one image:
`docker compose -p ava-alice --env-file deploy/alice.env up -d`. `env_file:` is deliberately not used
— it resolves against the compose file while `--env-file` feeds only interpolation, so a second
deployment would boot with the first one's `.env`. The explicit `environment:` block that replaces it
is the one thing here that drifts: **a new env var means editing two files**, and it fails loudly at
boot because zod names the missing variable.

**The news side** ingests with conditional GET, ranks per beat, and delivers one message per article
into a tab per beat — two daily digests (`pipeline.digestHours`, 10:00 and 20:00) plus a 04:00 prune,
a Monday 05:00 memory review and a Monday 06:00 feed review. Beats are rows the reader owns;
`/follow` creates one from a subject and `retune-beat` lets Newy adjust it.

**The jobs side** fires at each of `jobPipeline.runHours` and gates itself on
`jobPipeline.intervalHours` against `job_runs.startedAt` — two fires so a refused one is not the
day's only chance. Ten job sources, six ATS providers probed concurrently, and `sonar` proposing
employers whose careers pages code resolves and verifies. Scoring is capped at
`maxJobsPerScoringRun` **per search** and ordered by CV overlap, which may reorder and never reject. Delivery is guarded by `job_deliveries`, permanently, with `redeliveryGuardDays` (75)
above `retentionDays` (60).

**The leads side** fires at each of `leadPipeline.runHours` (09:00, 21:00) on its own
`leadPipeline.intervalHours` (**44**, not the jobs pipeline's 20) with `retentionDays` 180. The two
intervals are different numbers for different pipelines and have been confused before — read the
config, not a remembered figure. It is the first pipeline on the kit: `LEADS` in
`src/mastra/pipelines.ts` holds its cadence, and `LEADS.open()` hands the cycle back to a run that
stops before spending anything ([ADR-0044](docs/decisions/0044-a-pipeline-s-cadence-is-one-definition.md)).
News and jobs still claim by hand until slice 3.

**Verified live 2026-08-23** (`pnpm telegram:check`): both bots resolve one private chat id, Threaded
Mode on, all six tabs found, both profiles up to date.

<a id="where-work-stopped"></a>

### Not done

- **Nothing has been run under two Compose projects at once on one host.** The failure to look for is
  the box, not the app: two Node processes, two sets of schedules, and digest hours firing twice
  against one machine's CPU. Run two and watch a digest hour before promising a third reader.
- **The news side has no query-source kind.** `beat_feeds` has no source-kind discriminator where
  `job_sources` has five, so arXiv / PubMed / Europe PMC — where the subject goes in the URL — cannot
  be reached by `discoverSiteFeed`. No schema change is needed; field-scoped terms (`abs:`, `ti:`)
  are required, and `retune-beat` never touches feeds, so a retuned beat would search its old terms
  forever.
- **`founding-engineer-worldwide` is still the loosest search, and the `sonar` scout is saturating.**
  Tightening it wants `seniority` and dealbreakers, not a stack `mustHave` — measured, and that
  deletes 13 of its 31 winners.
- **CV-overlap ranking is a raw count and normalising it is unmeasured.** An agency listing naming
  twenty technologies outranks a real match.
- **A role can arrive twice — once as a posting, once as a lead — and the two dedupe keys do not
  merge.** `sonar` re-reads boards this pipeline already ingests. Not yet observed.
- **The 👍/👎 loop is still unwired.** `recentFeedback()` is read by the ranker and nothing feeds it.

## Done means

- `pnpm verify` is green, and the `:check` script for what you touched has been run.
- Every reported bug has its test, and no existing assertion changed without the reader's approval.
- The review above ran and reported clean, or its findings were approved.
- Any doc the change invalidated has been updated — including the ADR whose `applies_to` now matches
  a file it did not.
- The slice's plan file is **deleted**, with anything durable promoted to an ADR or a gotcha first.

## Recording decisions

Non-obvious choices go in [`docs/decisions/`](docs/decisions/README.md) as a new numbered ADR,
including the cost — an ADR with no downside listed is marketing. **Never rewrite an accepted ADR**;
supersede it, so the reversal and its reasoning survive. **Never leave a rule documented as active
that the project has stopped following** — a knowingly-broken rule becomes `status: superseded`, with
the record that replaces it named in the new ADR's `supersedes`.
