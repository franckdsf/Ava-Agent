# AGENTS.md

Operating contract for anyone — human or agent — working in this repo.

- **What it is and how to run it:** [README.md](README.md)
- **Why it looks like this:** [docs/decisions/](docs/decisions/README.md)
- **This file:** the rules that aren't obvious from the code, and where work stopped.

---

## Names

**Ava is the system. Agents have their own names.** Ava is the repo, the
database, the container, the `AVA_*` environment, the volume — everything that
outlives any one agent. **Newy** is the conversational agent behind the Chat tab,
formerly called Ava, renamed 2026-08-03
([ADR-0022](docs/decisions/0022-ava-is-the-system-agents-have-names.md)).
**Joob** is the second agent: job postings rather than news, its own bot token
and its own chat ([ADR-0023](docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md),
[ADR-0024](docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)).

The rule for reading this repo, and for naming anything new in it:

- **Lowercase `ava` in a path, an identifier, an env var or a volume is the
  system** — `ava.db`, `ava-data`, `ava-storage`, `AVA_MODEL_*`, `ava-agent`.
  Leave it alone. Renaming any of it is a migration, not a rename.
- **A capitalised name in a prompt, a tab, a bot profile or an agent id is an
  agent** — `Newy` and `Joob`. A bot token, a chat id and a tab set belong to
  one agent, so their env vars are prefixed with its name — `NEWY_TELEGRAM_*`,
  `JOOB_TELEGRAM_*`. **Including the first agent's:** Newy's were bare
  `TELEGRAM_*` while she was the only bot and were renamed 2026-08-03, because a
  bare name reads as "the default bot" the moment an explicit `JOOB_` sits
  beside it.
- **A knob shared by every conversational agent keeps its role name**, not an
  agent's. `AVA_MODEL_ORCHESTRATOR` is the model a reader talks to, whichever
  agent is doing the talking; retuning it is a decision about the surface, and
  one variable moving all of them together is the intent.
- **ADRs 0001–0021 predate the split and are frozen.** Where they say "Ava" of
  the chat agent, read "Newy". ADR-0022 carries the mapping; do not rewrite them.

## Working agreement

- **pnpm only.** Never npm. This was corrected explicitly.
- **Say what you're doing while you're doing it.** Minutes of silent work is the
  failure mode here — from the outside it is indistinguishable from being stuck.
  Before a long stretch, say what you're about to do; as each step lands, say
  what it showed. A short line per step beats a perfect summary at the end.
- **Verify by running, not by asserting.** Both real bugs in this codebase were
  found by executing against live feeds, not by reading code. Before reporting
  something works: `pnpm typecheck`, and run the thing.
- **Before testing against the live bot, report the change and the output you
  expect** — the message shape, which tab it lands in, what a reply should say —
  and wait for the go. This is not a permissions gate on `pnpm dev`; it puts the
  same expectation on the table before the test runs, instead of whatever
  arrived being judged acceptable after the fact.
- **Don't add a dependency without checking what's installed.** `@mastra/libsql`
  already pulls `@libsql/client`; `mastra` already pulls `esbuild`. grammy was
  installed and removed once the Chat SDK adapter turned out to cover both
  directions.
- **Tunables belong in `src/config/`, secrets in `.env`.** No magic numbers in
  logic. `src/config/pipeline.ts` is the knob drawer.
- **If a decision's justification erodes mid-task, say so and re-open it** rather
  than carrying it forward. Convex was adopted and then dropped this way, and
  that was the right outcome.

## Commands with rules attached

The full list is in the [README](README.md#commands). These three carry obligations:

| Command | Rule |
| --- | --- |
| `pnpm typecheck` | Run before claiming any change works. |
| `pnpm db:generate` | **Required** after editing `src/db/schema.ts`, or the migration silently lags the code. |
| `pnpm feeds:check` | Run after adding or changing a feed. It reads `beat_feeds`, so it needs `.env` now — it used to need nothing. |
| `pnpm discovery:check "<subject>"` | Dry-runs `/follow` end to end — names the beat, searches, verifies every feed, renders the report — writing and sending nothing. Run before believing any change to the namer, the scout, or feed resolution. |
| `pnpm review:check` | **Required** after touching `verdictForBeat` or `src/config/feed-review.ts`. It is the only exercise the weekly feed review gets: a guard with no case here is a guard that silently stops applying, and the failure is a beat quietly losing good sources. Also prints what a run *today* would do to the live beats. |
| `pnpm jobs:check` | Run after touching a job source, an adapter, or `job-identity.ts`. Fetches every seeded board for real, prints per-source field coverage, and runs the identity function over everything so the cross-board dedupe is a measured number rather than an assumption. Writes nothing, calls no model. |
| `pnpm sonar:check "<slug or free text>"` | Run after touching the job scout's prompt, careers-page resolution or `jobScout`. Dry-runs the `sonar` source end to end — proposes companies, resolves and verifies every careers page, builds the rows ingest would store and runs the real filter over them — writing and sending nothing. **It calls a model, unlike `jobs:check`**, which is why it is a separate command. Read the FILTER block first: a lead survives only if its careers page carries the reader's must-haves in real text, so a low survival rate means the design is failing, not that the week is quiet. Run it **three times** — company sets vary run to run, and the ±10 discipline applies. Free text touches no database; a slug-shaped argument opens one and applies migrations. |
| `pnpm portfolio:check` | Run before believing anything about job scoring, and after any change to the portfolio endpoint. It is the one input to that scoring living outside this repo, and a wrong endpoint **never errors** — a protection wall answers 200 with an HTML login page, an empty deploy answers 200 with nothing. Prints the size, the estimated per-run token cost, the headings and the first lines. Read-only. |
| `pnpm catchup:check` | **Required** after touching `decideCatchup`, `src/config/catchup.ts`, `pipeline.digestHours` or `jobPipeline.intervalHours` — the last two because the staleness bars are set against those cadences and nothing enforces the relationship. The boot catch-up runs once, unattended, on a path that is invisible when it decides right and expensive when it decides wrong. Every guard needs a case here. Also prints what a boot *right now* would do to both live pipelines. Read-only; fires nothing. |
| `pnpm finder:check "<topic>" [--against <url>…]` | **Run before adding a source to a beat that is meant to be timely.** `feeds:check` reports health, and a late blog is perfectly healthy — measured 2026-08-06, all 20 subscribed feeds passed while `ai-model-releases` sat on a weekly newsletter and a feed with no dated entries in 45 days. This races candidates against each other and reports median hours behind the first publisher ([ADR-0031](docs/decisions/0031-a-race-decides-which-sources-are-early.md)). **Always pass `--against` with the beat's existing feeds** — a lag is measured against other sources, not in the abstract, and a thin pool produces "too few" for everything. Read the *stories* line before the table: if the tokens are not recognisable releases, the filters have drifted and the ranking below them is noise that will still look plausible. |
| `pnpm rssfinder:check "<subject or domain>"` | **Read the output with `--verify` or not at all.** It queries a third party's index, which answers with feed URLs directly — the one thing [the gotchas](#gotchas) say never to accept from a search, because a wrong feed URL never errors. Measured 2026-08-06 on `ai images models`: 7 feeds returned, **3 alive** — two 404s, a 403 and a page that isn't a feed. Nothing here writes, calls no model and needs no `.env`; `checkFeed()` remains the sole authority on whether a URL is a feed. |
| `pnpm workflow:run <target>` | **The only script here that is not a dry run — read `--help` before the first use.** It starts a real scheduled workflow against a running `pnpm dev`: real feeds, real model calls, real Telegram messages, and for `jobs` the scoring call that is this system's single most expensive request. Every target's cost is printed before it fires. Three traps it exists to close, all documented in the [gotchas](#gotchas): the route takes the *registry key* while schedule rows take the workflow id; `initialState` is mandatory for `curateAll` alone; and **a 504 does not stop the run**, which is why the script supplies its own `runId` and polls rather than reading the response — re-firing is how two runs end up delivering at once. Exercise it with `news --beats <a slug that does not exist>`: `activeBeats` returns nothing, `ingest` returns early, and both notice guards are false, so it proves the whole path end to end while fetching nothing and sending nothing. |
| `pnpm youtube:check [url]` | **Run first whenever Newy says she cannot read a video, and after any `pnpm update`.** It is the early-warning system for a dependency that scrapes another company: the caption route is behind anti-bot measures that move, and when they move the failure is total and silent — she simply starts refusing every video. Prints the parsed id for ten URL shapes (two of which *must* fail) and fetches five real transcripts covering each outcome: a 19-second clip, a 19m talk with manual captions, a 1h56m talk with auto captions, a music video that must come back `no-speech`, and a dead id that must come back `unavailable` rather than `no-captions`. Read-only, needs no `.env`, and **calls no model** — it stops at the transcript. Every video failing at once means the route is blocked, not that the videos changed; `pnpm update youtube-caption-extractor` is the first thing to try. |
| `pnpm telegram:check [bot]` | Run before debugging a missing tab. Reports whether BotFather's Threaded Mode is on — the one prerequisite no code can set — plus any profile field the next boot would push. Read-only, safe against a running bot. Covers **every** bot with no argument, because Threaded Mode is per token and a check that silently skipped one would be worse than none; name a bot (`newy`) to narrow it. |

## Invariants

Breaking one of these is a regression, not a refactor. Read the linked ADR before
changing any of them.

1. **No inbound ports.** Telegram is long-polled; models are called outbound.
   Nothing may require a public URL, tunnel, or webhook.
   ([0001](docs/decisions/0001-mastra-in-a-container-with-no-inbound-ports.md), [0002](docs/decisions/0002-telegram-via-chat-sdk-adapter-in-polling-mode.md))
2. **A scheduled model call must have control flow it cannot choose, and no
   authority over what gets stored.** The rule is not "no models on a schedule",
   and it is deliberately a *shape* rather than a list — the list version of this
   invariant said "only ranking, composing and the weekly memory review", and it
   had been false since the weekly feed review's top-up started calling the
   `sonar` scout on a cron. A list goes stale silently; a shape does not. Two
   shapes qualify, and nothing else does:

   - **A classifier over a fixed row set** — fixed control flow, a set handed to
     it, and the answer validated against that set on the way back. The news
     ranker, the digest writer, the weekly memory reviewer, the job scorer and
     the job writer. Every one of them discards an id it was not given.
   - **A search whose every answer is verified before it is stored** — a bounded
     loop over rows, a model that proposes, and *code* that establishes whether
     what it proposed is real. The feed scout behind the weekly top-up
     ([0020](docs/decisions/0020-feed-discovery-from-a-subject.md)) and the job
     scout behind the `sonar` source
     ([0026](docs/decisions/0026-sonar-as-a-job-source.md)). Neither may write a
     URL it was handed: `checkFeed()` decides there, careers-page resolution
     decides here, and an unverifiable proposal is dropped.

   What is actually forbidden is a scheduled job that lets an LLM choose its own
   control flow, because that is what produces surprise bills and duplicate
   messages. **A search shape therefore needs a bound in config**, or its loop is
   only fixed until the reader adds another row — `jobScout.maxSearchesPerRun` is
   that bound, and it is load-bearing rather than a tuning knob.

   Ingest, dedupe, cluster and delivery remain deterministic. Inbound,
   human-triggered calls are a separate category governed by invariant 8 instead —
   Newy, the translator behind `/translearn` / `/translate`, and the summarizer
   behind `/summarize`. The distinction there is who decides to spend: a cron fire
   nobody watches, or a person typing.
   ([0015](docs/decisions/0015-weekly-memory-review.md), [0017](docs/decisions/0017-translation-commands.md), [0018](docs/decisions/0018-summarize-command.md), [0020](docs/decisions/0020-feed-discovery-from-a-subject.md), [0026](docs/decisions/0026-sonar-as-a-job-source.md))
3. **A beat is a row, not code.** Adding a beat means inserting into `beats` and
   `beat_feeds`. Needing to touch agent or workflow code means the abstraction is
   wrong — and needing to *restart* means something is still being derived at
   module load, which is the bug this replaced. There is one ranker and one
   article writer for every beat, and the rubric arrives in the prompt.
   `src/config/seed-beats.ts` is a seed applied once to an empty table, not
   configuration: editing it does not reach a beat that already exists.
   ([0008](docs/decisions/0008-categories-as-configuration.md), [0019](docs/decisions/0019-beats-as-reader-owned-data.md))
4. **Drizzle owns app tables; Mastra owns `mastra_*`.** One database, one shared
   connection, neither aware of the other. **One exception, and only one:**
   `articles_fts` and its three triggers are hand-written in
   `drizzle/0010_articles_fts.sql` because drizzle-kit cannot express a virtual
   table. Anything else belongs in `src/db/schema.ts`.
   ([0005](docs/decisions/0005-two-libsql-databases-instead-of-convex.md), [0006](docs/decisions/0006-drizzle-orm-for-application-tables.md), [0011](docs/decisions/0011-fts5-for-article-search.md))
5. **Dedupe is global, not per-beat.** Keyed on a hash of the canonical link. A
   story matching several beats is stored **once** in `articles` and linked to
   each of them in `article_beats`, where it is scored separately — and it is
   **delivered once**, by whichever beat scored it highest among those clearing
   their own threshold (`articles.deliveredBeat`). The losing beats keep their
   score and their reason, which is what makes "why didn't you send me that?"
   answerable. ([0019](docs/decisions/0019-beats-as-reader-owned-data.md))
6. **Single replica.** Two would double-send digests and double-poll Telegram.
7. **Exactly one adapter polls per bot token.** The mechanism is what matters:
   two adapters on *one* token share a `getUpdates` offset and consume each
   other's updates. Two tokens are two independent queues, which is what lets
   Newy and Joob both poll from one process — the rule used to read "exactly one
   adapter polls", which named the mechanism correctly and generalised wrongly.
   `src/services/telegram.ts` is outbound-only for **every** bot and never
   initializes a `ChatInstance`; no outbound instance may carry a `mode`. Never
   use `mode: 'auto'` — it falls back to *webhook* when it can't verify
   `getWebhookInfo`, which silently breaks invariant 1 for whichever bot it
   happens to.
   ([0009](docs/decisions/0009-telegram-topics-as-tabs.md), [0023](docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md))
8. **What a conversation may write is decided by what reads it back — and
   nothing conversational may ever write what a run produced.** This has now been
   restated twice, and each restatement removed a list. It began as "read-only
   over the pipeline" with
   `memories` as its one exception, which could not survive the reader creating
   beats by talking to Newy. It then became *configuration* versus *run output*
   over an enumeration of three tables — and `beat_revisions` broke that within a
   day of it being written, because a superseded rubric is neither. The invariant
   said "a principle is better than a growing list" and then gave a list; this is
   the third attempt, and the criterion is now **what reads the table back**:

   - **Input to a future run** — `memories`, `beats`, `beat_feeds`. One-way and
     asynchronous: a note, a new beat or a retuned rubric changes what the *next*
     scheduled run does, never the one in flight.
   - **Read by no run at all** — `beat_revisions`. Write-only history, kept for a
     human and never fed back into anything. This category is safe by
     construction rather than by discipline: a table no run reads cannot reach a
     run in progress however carelessly it is written, which is a stronger
     guarantee than the first category has.
   - **Never: anything a run produced.** `articles`, `article_beats`, `feedback`,
     any score, any `deliveredAt`. Nothing conversational may reach a run in
     progress, mark anything delivered, or write a verdict. An agent that could
     re-send a digest would eventually re-send a digest.

   Both permitted categories are additive in the same way: **a fact, a beat and a
   rubric are all superseded rather than corrected.** `memories` never rewrites a
   fact ([0014](docs/decisions/0014-two-tier-memory-for-ava.md)) and a retune
   never discards the rubric it replaced, for one reason — the change is the half
   worth keeping, and the ranker's ±10-point noise floor means a rubric that
   quietly made a beat worse is not visibly worse for days. A write from a
   conversation that destroys its own predecessor is the thing to refuse, whatever
   table it lands in.

   **Newy may retune a beat, and only when asked in those words.** `retune-beat`
   rewrites `beats.rubric` and `beats.subtopics` and appends the old pair to
   `beat_revisions`. It supplies `buildRubric()`'s *slots*, never freehand prose,
   so the shape the ranker was tuned against survives an author who is not the
   namer ([0020](docs/decisions/0020-feed-discovery-from-a-subject.md)) — and the
   discipline `/pause` follows applies here too: the tool is called because the
   reader asked, never because a model inferred a preference from a sentence.

   This is what keeps invariant 2 true now that an LLM sits on an inbound path.
   `read-article` may fetch a page the feed shipped no body for — an outbound GET
   is not a write — but it must not store what it gets back.

   **Starting a workflow is allowed, and only for the config side.** Finding
   feeds for a new beat takes minutes, so it belongs in a background run rather
   than a turn. That run may write `beats` and `beat_feeds` and report to Chat;
   it may not touch the news tables, and nothing conversational may start
   `curateAll`. A reader-triggered run is governed by invariant 2's own
   distinction — a person typing, not a cron fire nobody watches.
   ([0009](docs/decisions/0009-telegram-topics-as-tabs.md), [0014](docs/decisions/0014-two-tier-memory-for-ava.md), [0016](docs/decisions/0016-reader-notes-in-the-ranker.md), [0019](docs/decisions/0019-beats-as-reader-owned-data.md))
9. **One bot, one agent, one chat — and inside a chat, one tab, one kind of
   traffic.** The outer half is new: an agent owns a token, a chat and a tab set,
   so "which tab does this belong in?" is only ever asked within one bot's chat
   and no message crosses between them
   ([0023](docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md)). The
   inner half is unchanged. Newy answers in Chat and nowhere else —
   messages typed in any other tab are *moved* there, not answered in place.
   Translations go to Translations. **A digest goes to its own beat's tab**, and
   News is now only the fallback for a beat tab that could not be made — a
   message landing there is a report that something failed, not routine
   ([0021](docs/decisions/0021-a-tab-per-beat.md)). Breaking this means the tabs
   stop meaning anything. **The criterion is length, not "is it a command"** —
   `/summarize` answers in Chat alongside `/start` and the unknown-command reply,
   because one short message is what Chat is for, while a translation is several
   thousand characters over several messages and would bury the conversation. A
   new tab per command is the misreading to avoid; a tab per *beat* is not the
   same thing, because a beat is a stream of traffic rather than a verb.
   ([0010](docs/decisions/0010-ava-answers-only-in-the-chat-tab.md), [0017](docs/decisions/0017-translation-commands.md), [0018](docs/decisions/0018-summarize-command.md), [0021](docs/decisions/0021-a-tab-per-beat.md))

## Writing Mastra code

Mastra's API moves fast and model training data is stale on it. **Verify against
the embedded docs before writing Mastra code** — they match the installed version
exactly, unlike anything remembered or fetched from the web:

```
node_modules/@mastra/core/dist/docs/references/
node_modules/@mastra/libsql/dist/docs/references/
```

Model IDs route through the OpenRouter gateway as `openrouter/<provider>/<model>`.
Verify names before use:

```bash
node .agents/skills/mastra/scripts/provider-registry.mjs --provider openrouter
```

## Writing Telegram code

Same problem, same rule: the Bot API ships roughly monthly and training data is
stale on it. **Read [docs/telegram-bot-api.md](docs/telegram-bot-api.md) before
writing anything that talks to Telegram** — where the authoritative sources are,
what `@chat-adapter/telegram` already covers, and how to call a Bot API method it
doesn't wrap without adding a second Telegram library.

## Gotchas

- **No relative path may be resolved against cwd.** `mastra dev` runs the bundle
  from `.mastra/.build`, `mastra build` from `.mastra/output` — neither is the
  project root. This has bitten twice: stray databases under
  `src/mastra/public/`, then `AVA_MIGRATIONS_DIR=drizzle` failing with "Can't
  find meta/_journal.json". Anchor every path with `resolveFromRoot()` in
  `src/lib/project-root.ts` (database URLs go through `resolveDbUrl()`, which
  wraps it). Absolute paths pass through untouched, which is what Docker sets.
- **Feeds serve their entire history.** Figma returns 437 entries, OpenAI 1051.
  `pipeline.maxItemAgeDays` exists for this reason; removing it means paying to
  rank years-old news.
- **A prolific feed is a different problem from a historical one, and the age
  window only solves the second.** arXiv `cs.AI` publishes 258–693 papers a day,
  every one of them hours old, so all of them clear the window: 951 of 1,084
  articles in a week, ~92% of ranking input tokens, for a **2% hit rate**.
  `pipeline.maxItemsPerFeedRun` is the general bound and
  `scopeArxivFeed()` narrows arXiv specifically, rewriting a category listing
  into an API query built from the beat's subtopics — applied in **both** add
  paths (`/addfeed` and discovery's `attach`), verified with `checkFeed()`, and
  reverted to the plain category if the query returns nothing.
- **Subtopics are ranking labels, not search terms, and they only sometimes
  survive the change of job.** Measured 2026-08-06 on `computer-science`
  (`ai-research`, `ai-models`): the scoped query returned 60 papers spanning
  **38 days with 1 of 60 from that day's batch**, and the titles were not
  visibly more on-beat than the unscoped 287. A label naming a *thing* works as
  a phrase search (`figma`, `design systems`); one naming a *field* does not.
  The cost saving is real either way — most results fall outside
  `maxItemAgeDays` and never ingest — but do not read the reduction as evidence
  that the right papers were chosen. `arxiv.uselessTerms` exists because
  `benchmarks` and `capabilities` match a large slice of every AI category.
- **A rubric mostly names no subjects, and the one time it looked like it did,
  that was a bug.** `termsFromRubric` reads proper nouns out of the HIGH half.
  Measured across all four live beats: it helps **one** — `design` yields
  `google, ui, css` and goes from 0 to 16 papers inside the ingest window —
  and yields *nothing* for `computer-science` and `ai-model-releases`, whose
  rubrics describe the **shape** of news wanted ("actually shipped", "primary
  sources outrank commentary") rather than any subject. That is the correct
  answer for them, not a gap to paper over. The first implementation skipped only
  the first word of each *line*, so `Primary` in "…benchmark delta. **Primary**
  sources outrank commentary" was taken as a proper noun; it matched a fifth of
  cs.AI and lifted `computer-science` from 9 usable papers to 40. **That looked
  exactly like the feature working.** Sentence-initial capitals are skipped now
  and the gain correctly vanished.
- **drizzle-kit generates a `NOT NULL` add that only works on an empty table.**
  `ALTER TABLE … ADD COLUMN … NOT NULL` with no default is rejected by SQLite the
  moment the table has one row — "Cannot add a NOT NULL column with default value
  NULL". This is exactly what it emitted for `feedback.title`/`source`, and it
  passed only because that table has never had a row. `0006` is hand-edited into
  a table recreate for that reason (the end state matches drizzle's snapshot, so
  `db:generate` stays quiet — check that after any hand-edit). Always apply a
  generated migration to a *populated* copy before trusting it: every repository
  function awaits `migrate()`, so a migration that throws takes down the whole
  app, not just the table it touches.
- **A migration whose `when` is older than the newest *applied* one is silently
  skipped, and this repo is currently primed to do it.** Drizzle applies only
  migrations whose `_journal.json` `when` exceeds the latest `created_at` in
  `__drizzle_migrations`. The hand-written `0010_articles_fts` and
  `0011_reset_feed_state` were given timestamps of **2026-07-30T08:26:40**, which
  was ~18 hours in the *future*, so `0012` generated on 2026-07-29 landed below
  them and was treated as already applied. There is no error and no warning:
  `db:generate` writes the file, `migrate()` reports nothing to do, and the app
  dies later on `no such column`. Until wall-clock passes that timestamp, **check
  the new entry's `when` against every other entry after every `db:generate`**
  and bump it above the maximum if it is lower. `0012` was fixed this way — it is
  the one legitimate reason to hand-edit `_journal.json`.
- **Copying a live libsql database means copying `-wal` and `-shm` too — this
  bit again on 2026-08-03, exactly as described below.** With `pnpm dev` running,
  `.data/ava.db` was stamped 16:51 while `ava.db-wal` held **3.4 MB** of writes
  from 17:19 — a `/target` and an entire workflow run. A copy of the `.db` alone
  produced `activeSearches()` → `[]` and a script that failed on `undefined`,
  which reads as a code bug and is not one. Copy all three files, then check a
  row count you know.
- **Copying a live libsql database means copying `-wal` and `-shm` too.** The
  main `.db` file only holds what has been checkpointed: on 2026-07-29 `ava.db`
  was 4.3 MB from 14:17 while `ava.db-wal` held 5 MB of writes from 15:32, so a
  `cp .data/ava.db` copy was missing an entire beat and five feeds — and looked
  perfectly valid. Every "verified against a copy of the live database" claim in
  this file was made that way; none of them was wrong in the end, but the next
  one could be. Copy all three files, then check a row count you know.
- **`--> statement-breakpoint` is split on as a plain string, comments and all.**
  The migrator does `raw.split('--> statement-breakpoint')` with no idea what a
  SQL comment is, so writing the marker *inside* a comment cuts the file there
  and executes the fragment. A file must also end on a real statement — a
  trailing marker leaves an empty string to run. Both fail identically and
  uselessly: `SQLITE_UNKNOWN_0: not an error`, `extendedCode: SQLITE_OK`, and a
  `statementIndex` counted across *every pending migration at once* with no file
  name. Both were hit writing `0010`. To find it, re-split the pending files and
  print each fragment's length with comments stripped; the empty one is the
  culprit and the index will not match your count of statements.
- **drizzle-kit needs a TTY when a table is dropped and another created in the
  same diff.** It asks "renamed or new?" through `promptNamedWithSchemasConflict`
  and dies with "Interactive prompts require a TTY terminal" under any piped or
  non-interactive shell — there is no flag for it in 0.31. The way through is to
  make the diff unambiguous: generate the *drops* first, from a schema with the
  old tables removed, then restore the full schema and generate the *creates*.
  Two clean migrations, correct snapshots, no hand-edited `_journal.json`. This
  is how `0008` and `0009` were produced.
- **Renaming a table strands its FTS index, and drizzle cannot see it.**
  `items_fts` is a virtual table with no snapshot entry, so a generated
  `DROP TABLE items` leaves it orphaned — queryable, permanently stale, invisible
  to every later migration. Drop the triggers and the virtual table by hand
  *first*, in the same migration. Statements drizzle doesn't track are safe to add
  there for the same reason `0005` was safe; check `db:generate` still says
  "nothing to migrate" afterwards. The FTS5 shadow tables (`_data`, `_idx`,
  `_docsize`, `_config`) go with the virtual table on their own.
- **Dropping the article table without clearing `feed_state` makes the next run
  ingest nothing.** The etags survive — that table is keyed by URL and its shape
  didn't change — so every feed answers 304 and the run reports zero errors and
  zero articles. This is the conditional-GET gotcha below, self-inflicted.
  `0011_reset_feed_state.sql` exists for exactly this and is a no-op on a fresh
  database.
- **A beat that starts following an already-polled feed must be backfilled from
  the database, not by re-fetching.** Same 304, different symptom: ingest fetches
  the URL, gets nothing back, and the new subscription is linked to nothing until
  that feed's content actually changes — minutes on Hacker News, days on WebKit,
  and the beat looks broken the whole time. Clearing `feed_state` to force a 200
  is the obvious fix and the weaker one, because it recovers only what the feed
  *currently serves*: fifteen items on HN, nothing at all from a dormant feed.
  The articles are already in `articles`; link them (`articleIdsFromFeed` →
  `linkToBeats`) and let the ranker do the rest. Use `maxItemAgeDays`, not
  `retentionDays` — retention keeps 30 days but ingest only accepts 7, so a
  full-retention backfill hands a new beat three-week-old stories to deliver as
  news. `/addfeed` does this; `create-beat` must too.
- **`retentionDays` and `maxItemAgeDays` may not be tuned independently.**
  Deleting an item frees its id, and the id *is* the dedupe — so a pruned story
  its feed still serves would be re-ingested with a null `deliveredAt` and
  **re-sent**. The only thing preventing that is the ingest window rejecting it
  on age first, which needs retention (30d) to stay well above the window (7d).
  Moving either number toward the other re-sends old news.
  ([0012](docs/decisions/0012-thirty-day-retention-on-items.md))
- **A single newline is a soft wrap, not a line break.** Telegram messages are
  parsed as markdown, so `heading\nbullet` renders as one run-on line — this
  shipped once and looked like an adapter bug. Separate blocks with a blank
  line. Verify format changes against the converter offline rather than by
  eyeballing the phone: `adapter.formatConverter.toAst(text)` returns the block
  structure without sending anything.
- **`content:encoded` needs declaring.** rss-parser silently drops unknown
  fields, so the full article body is invisible unless it is listed in
  `customFields.item`. Without it the summarizer sees a 400-char excerpt and
  writes a summary that just restates the headline.
- **Conditional GET hides schema changes.** Items ingested before a new column
  existed keep it null until their feed actually changes, because a 304 skips
  re-ingest entirely — and `insertDiscovered` ignores conflicts, so even a
  re-fetch won't backfill an existing row. `content` and `imageUrl` were null
  for every pre-existing item long after their migrations ran. New items fill
  in normally; a backfill is a deliberate one-off, not something ingest does.
- **A leading `/` never reaches the agent.** The adapter routes any message
  whose first entity is a `bot_command` to `processSlashCommand` and skips the
  message path entirely — and with no handler registered, the Chat SDK drops it
  without a trace. `/start` did nothing for a while. `src/mastra/channels.ts`
  registers a *catch-all* so no command can be swallowed again.
- **On an inbound message, `formatted` beats `text`.** Mastra builds the model's
  input as `stringifyMarkdown(message.formatted) || message.text`, and the
  adapter always sets `formatted` — so anything injected into `text` alone is
  silently dropped. That is the whole trick to `withQuotedMessage`
  ([0013](docs/decisions/0013-swipe-to-reply-as-article-context.md)): the note
  goes into the AST, and `text` is kept in step only so the two don't disagree.
  Copy the message rather than editing it — `handleIncomingMessageUpdate` calls
  `cacheMessage` on the object *before* handing it to the handler.
- **Escape only what opens inline markup.** MarkdownV2's escape set is wider
  than what Telegram's rich markdown needs. Escaping `.` and `-` inline shipped
  `kotlinx\.atomicfu`, `50\.7` and `platform\-ui` into real messages. Those
  characters are only meaningful at the start of a block.
- **og:image is as often the site banner as the post's art.** WebKit serves
  `/wp-content/themes/webkit/images/preview-card.jpg` on every post. Two guards
  in `resolveImage()`: reject paths that look like site chrome, and reject any
  URL already on a sibling item from the same feed. The repeat check alone can't
  catch the first occurrence, which is exactly the one that shipped.
- **Only 3 of 16 feeds publish images.** DeepMind (`media:content`), Smashing
  (`enclosure`) and Android Developers (`media:thumbnail`); WebKit has them
  inline in about half of posts. arXiv, Hacker News, Willison, OpenAI, Figma,
  CSS-Tricks and NNG have none. An image is the exception — never lay out a
  message assuming one is there.
- **Tab order is Telegram's, not ours.** The client sorts tabs by most recent
  message, so the order of `TOPICS` only decides creation order and no Bot API
  method reorders them. Chat was created first and still sat under News until a
  reply landed in it (verified 2026-07-28). A request to "put that tab first" has
  no code answer — the only thing that moves a tab up is traffic in it.
- **A search index is not a `LIKE`.** `search-news` matched the reader's entire
  phrase as one contiguous substring, so `fine tune` could not find `fine-tune`
  and every multi-word question missed. It now goes through `items_fts`
  ([0011](docs/decisions/0011-fts5-for-article-search.md)). Two things bite when
  touching it: punctuation is FTS5 *match syntax*, so terms must be quoted or
  `fine-tune` throws `no such column: tune`; and the `AFTER UPDATE` trigger is
  scoped `OF title, excerpt, content` because the pipeline writes `score` and
  `deliveredAt` on every run and would otherwise reindex the table each time.
  Verify the index against `items` with
  `INSERT INTO items_fts(items_fts) VALUES('integrity-check')`.
- **A tool that returns only headlines produces a model that hedges.** The
  original `search-news` returned title/source/link/score and nothing else, so
  even a *successful* search left Newy unable to say anything about an article —
  she hedged, and it read as a search failure. It returns `excerpt` and `reason`
  now, and `read-article` returns the body for one item at a time.
- **Listing and reading are separate tools on purpose.** `search-news` matches
  on the full body but returns excerpts; `read-article` returns one body in full.
  Putting bodies in the search result is the obvious-looking change and is the
  wrong one twice over: at the 8k cap fifteen results is ~30k tokens a search,
  and it buries the article the reader asked about under fourteen others. Both
  tools return `id` so the model can go from one to the other — if that field
  is ever dropped from `articleShape`, reading breaks silently and Newy goes back
  to answering from excerpts.
- **Telegram feeds carry no body worth having, so `read-article` fetches.**
  Hacker News items store the HN boilerplate as their excerpt — `Article URL: …
  Points: 180 # Comments: 48` — and 15 of 288 items had no `content` at all.
  `read-article` falls back to `fetchArticleText` for exactly those, and
  deliberately does **not** write the result back: that would make it the one
  tool on the conversational surface that writes to the pipeline's tables, and
  invariant 8 is worth more than a free cache. Verified against Android
  Developers, which ships no `content:encoded`: 7999 chars fetched live, 568 of
  them nav chrome before the article starts.
- **The reply is invisible until it's finished, unless streaming is on.**
  `streaming` defaults to false for every adapter except Slack, and the
  orchestrator takes ~25s over three round trips on a question that hits a tool.
  The typing indicator does not cover the gap: the adapter sends
  `sendChatAction` once, Telegram expires it after ~5s, and Mastra only re-sends
  when the status *string* changes — which it doesn't while the model thinks.
  `streaming: true` on the adapter entry streams through Telegram's draft API
  and posts one real message at the end. It is a no-op in a supergroup:
  `stream()` returns null unless `isDM`, i.e. a positive chat id.
- **A reply that starts mid-word is the model, not the transport.** minimax-m3
  intermittently closes its `</think>` tag *inside* the answer it has already
  started writing, so OpenRouter routes the opening of the reply into the
  reasoning channel and only the tail reaches Telegram. Seen twice in one real
  session: the reader got `'as d'autres questions !` and a bare `✨`. It looks
  exactly like broken streaming, and it isn't — check
  `mastra_messages` before touching the adapter:

  ```
  reasoning: "…No tools needed.De rien 😄 N'hésite pas si t"
  text:      "\n\n'as d'autres questions !"    ← all Telegram is given
  ```

  `reasoning: { enabled: false }` does not suppress it — verified against the
  live API, m3 emits the think block regardless. The only real fix is a
  different orchestrator model; measured alternatives, same conversation, three
  runs each: `anthropic/claude-haiku-4.5` ($1/$5 per M) 1.0–1.8s and no think
  block at all, `google/gemini-3.6-flash` ($1.50/$7.50) 1.3–1.6s cleanly split,
  `deepseek/deepseek-v4-flash` ($0.14/$0.28) cleanly split but one run in three
  took 12s. Staying on m3 ($0.30/$1.20) is a deliberate cost call — the
  truncation is the price.
- **A workflow *can* be started from a slash handler — verified 2026-07-29.**
  The gotcha below is about a *script*, and it was read for a while as "nothing
  can start a workflow but a schedule". `mastra.getWorkflow('discoverFeeds')
  .createRun()` then an un-awaited `run.start()` works from inside
  `sdk.onSlashCommand`, because the handler runs in the Mastra server and the
  server owns the pubsub loop the evented engine needs. `/follow` does this and
  both its messages arrived. Don't await it — `start()` resolves when the
  *workflow* finishes, minutes later, and the acknowledgement has to go out
  first.
- **A search-native model is how this repo searches the web, and it needed no
  dependency.** `openrouter/perplexity/sonar` routes through the same gateway and
  key as everything else. Before reaching for a search SDK or a scraper, check
  whether a model can do it. `sonar` over `sonar-pro` is measured on *verified
  feeds*, not proposed sites — 18/24 vs 16/24 over three subjects, faster and
  cheaper, and sonar-pro invented a domain (`chefpjacooks.com`) where sonar
  returned the real one.
- **Ask a model for sites, never for feed URLs.** A wrong feed URL never errors:
  it is stored as a source that silently returns nothing forever. The homepage
  goes to `discoverSiteFeed()`, which reads `<link rel="alternate">`, then tries
  well-known paths, then follows one link to a feed-listing page — and
  `checkFeed()` decides. Same discipline as templating an article's link rather
  than letting the summarizer write it.
- **Search in English even when the reader doesn't.** `"actualité de la formule
  1"` returned 3 sites with 1 usable feed; the English phrasing of the same
  subject returned 8 with 7. It costs the reader nothing — a source's language
  never reaches them, since the digest is summarized and `/summarize` and
  `/translate` answer in their language. The namer emits a `searchQuery` for this
  and it is deliberately not stored.
- **For a general outlet, hand the resolver the section page, not the root.**
  `bbc.com` yielded nothing on a real run; `bbc.com/sport/formula1` resolved 3 of
  3. A front page advertises no feed, and the section feed is the one worth
  having anyway. Same for `espn.com` and `skysports.com`.
- **The homepage fetch uses a browser User-Agent, and only that fetch.** With
  `pipeline.userAgent`, `autosport.com` and `motorsport.com` answer **403** and
  `racefans.net` answers **429** — three of the best sources for that subject.
  Worth 4/10 → 7/10 on the first probe. The *feeds* those sites serve accept the
  honest UA happily, so every feed fetch and every later poll keeps it; it is the
  CDN in front of the page that objects. Don't "simplify" this to one UA.
- **A feed's `<title>` is often not a name.** PlanetF1 ships 200 characters of
  marketing copy, and that string would be the attribution under every article it
  ever delivers. `sourceLabel()` takes the first segment before a dash and falls
  back to the hostname past `pipeline.sourceMaxChars`. Note the dash class holds
  en-dash *and* em-dash — a class with only one left `Contexte – Politiques
  françaises et européennes` unsplit.
- **`checkFeed()` cannot tell a feed from a sitemap.** `grandprix247.com`
  declares a Google News sitemap as `application/rss+xml`; it parsed as 306
  entries and was accepted. Unfixed.
- **A dry-run script that rebuilds the workflow's own mapping will drift from
  it.** `check-discovery.ts` had its own copy of the result mapping for one
  commit, and the copy skipped `sourceLabel` — so the dry run showed a
  47-character source name the real run would never produce. `describeSite` is
  exported for this reason; import it rather than re-deriving it.
- **A workflow written for one caller lies to the second one.** `discoverFeeds`
  had exactly one caller — `/follow`, on a brand-new beat — and its report read
  `results` for "feeds attached" and the run's `activate` flag for "is it
  running". Both are correct only on that path. The weekly review's top-up is the
  second caller: it runs on a beat *already near* `maxFeedsPerBeat`, so `attach`
  keeps the first few and the report named every feed it had found, including the
  ones it dropped on the floor; and it passes `activate: false` so as not to
  un-pause anything, which made the report tell the owner of a **running** beat it
  was paused. Neither was visible from `/follow`, where room is always 8 and
  `activate` is always true. The fix is the shape to copy: `attach` now emits
  `attachedFeeds` — what it actually wrote — and the report reads the beat's own
  `archivedAt` rather than the caller's intent. **A step that reports on itself
  must return what it did, not the inputs a caller can re-interpret.**
- **"Feeds this beat has" means the archived ones too, when the question is
  whether to add one.** Discovery excluded what `feedsForBeats` returned, which
  is live-only — right for ingest, wrong for an exclusion list. `addBeatFeed`
  upserts `archivedAt` back to null, so any re-proposed archived feed simply
  returned. Two ways that bites, and the second is the bad one: a feed dropped
  with `/removefeed` comes back on its own, defeating the whole point of
  `archivedReason = 'reader'`; and the weekly review, which runs
  `restore → prune → topUp` in **one** pass, archives a feed and re-adds it in
  that same run — pruning is what puts the beat under the cap that makes the
  top-up fire, and the scout proposes on-topic sites first, which is exactly what
  the feed it just dropped is. `trials` never advances, the 30-day rest never
  happens, and the backoff silently does nothing. `subscribedFeedUrls` is the
  exclusion list; verified against a copy — `/removefeed` took `computer-science`
  from 9 live feeds to 8 while the exclusion list stayed at 9, and re-proposing
  `blog.google` probed 1 site under the old list and 0 under the new one.
- **A workflow *can* be triggered from a terminal — over HTTP, not from a script.
  Verified 2026-07-30.** The gotcha below is about `run.start()` in-process, and
  it was read for a long time as "Studio is the only way", which is false and
  costs an agent a browser it does not have. `POST` to the running dev server
  instead; it owns the pubsub loop, so the evented engine is satisfied.
  **`pnpm workflow:run` now wraps all four of the traps below** — reach for it
  first, and read this only when it is the script itself that needs changing:

  ```powershell
  Invoke-RestMethod -Uri "http://localhost:4111/api/workflows/curateAll/start-async" `
    -Method Post -ContentType "application/json" `
    -Body '{"inputData":{},"initialState":{"feedsFetched":0,"discovered":0,"linked":0,"feedErrors":[]}}'
  ```

  Four things bite, in the order they bit:

  - **`npx mastra api workflow run start curateAll '{"inputData":{}}'` fails with
    `INVALID_JSON` under PowerShell.** PowerShell strips the inner double quotes
    passing the argument to a native exe. Use `Invoke-RestMethod`, or the `--%`
    stop-parsing token. The CLI is still the way to *discover* the contract:
    `npx mastra api workflow run start --schema` prints the route and body shape.
  - **The route needs the `/api` prefix.** `api-schema` reports the path as
    `/workflows/:workflowId/start-async`; the server mounts it under `/api`, and
    without the prefix it is a bare 404 with no hint.
  - **`initialState` is required and is not defaulted.** `curateAll` declares a
    `stateSchema` whose four fields have no defaults, so an empty body is a 500
    listing them — `feedsFetched: expected number, received undefined`. Studio
    fills this in from the schema, which is why it never comes up there.
  - **A 504 does not stop the run.** `start-async` waits for completion and the
    server's gateway timeout fires first on anything long; the workflow carries
    on regardless. Deliveries here landed up to 6 minutes *after* the 504.
    **Never retry on a 504** — poll
    `GET /api/workflows/:id/runs/:runId` for `status`, or read the database.
    Re-firing is how two runs end up delivering at once.

- **A workflow can't be run from a plain script.** `createRun()` resolves fine
  and `run.start()` then hangs forever with "unsettled top-level await" —
  schedules are "only supported on the evented engine", and the evented engine
  needs the pubsub loop the Mastra server owns. Nothing is wrong with the
  workflow when this happens. Test a *step's* logic by calling the functions it
  calls (that is how retention was verified, against a copy of the database), and
  test the *workflow* from Studio. `mastra.listWorkflows()` and
  `workflow.getScheduleConfigs()` do work in a script, which is enough to prove
  registration and fire times.
- **A schedule row is keyed by the workflow's own id, not the key it is
  registered under — and it can be read from a script.** `curateAll` is
  registered in `index.ts` under `curateAll` and declares
  `createWorkflow({ id: 'curate-all' })`; the persisted rows are
  `wf_curate-all__digest-0800` and friends, whose `target.workflowId` is
  `curate-all`. Every lookup — `mastra.schedules.list({ workflowId })`,
  `mastra.schedules.run(id)` — takes the kebab-case one, and the registry key
  silently matches nothing: no error, an empty list, and a caller that concludes
  there are no schedules. Read `workflow.id` rather than spelling either by hand.
  Unlike *running* a workflow, *reading* the rows needs no server —
  `storage.getStore('schedules')` then `listSchedules({ workflowId })` works in a
  plain script, which is how `pnpm catchup:check` reports real fire times without
  booting the bots. Verified 2026-08-04 against a copy of the live database.
- **Firing a schedule publishes an event; a *different* worker runs it.** The
  scheduler's tick only claims a due row and publishes `workflow.start` — the
  orchestration worker consumes it. Both are started by the server's
  `startWorkers()`, which happens *after* `src/mastra/index.ts` is evaluated, so
  anything firing a run at module load must wait for
  `mastra.getWorker('orchestration')?.isRunning`. Publishing into a pubsub nobody
  has subscribed to yet is dropped with no error, and the trigger row still says
  `published` — a silent failure that looks exactly like success. `catchUpOnBoot`
  waits for that worker for this reason
  ([ADR-0025](docs/decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md)).
- **Clustering is empirically tuned.** Before changing
  `clusterSimilarityThreshold` or the token filter, re-run ingest and inspect the
  actual merges. ([0007](docs/decisions/0007-lexical-clustering-instead-of-embeddings.md))
- **Model IDs need the `openrouter/` prefix.** Mastra's registry lists `deepseek`
  and `minimax` as *direct* providers too, so a bare `deepseek/deepseek-v4-flash`
  is valid — it just bills DeepSeek and demands a `DEEPSEEK_API_KEY`. `env.ts`
  rejects unprefixed IDs at startup; don't weaken that guard to "make it work".
- **A JSON schema is a request to OpenRouter, not a guarantee.** `structuredOutput`
  sends the schema as `response_format`, and the gateway routes to whichever
  provider is cheapest — some of them answer with well-formed JSON under a key
  of their own choosing. `deepseek-v4-flash` returned the ranker's whole batch,
  every item correctly shaped, wrapped as `{"scores":[…]}` for a schema that
  names `rankings` (2026-08-07), and Mastra threw the step. **Name the envelope
  key in the prompt as well as in the schema** — the ranker's instructions do —
  and keep the retry, because the key a provider picks varies per call.
- **A model call that fails must leave its batch untouched, not settle it.**
  `rankBeat` writes a zero verdict for every article the ranker did not score,
  which is right for a cluster duplicate and catastrophic for a failed call: the
  zeros are saved, the articles never re-enter the queue, and a beat silently
  loses a run's worth of news. It now returns early when nothing usable comes
  back, the same trade `scoreBatch` makes. "The model failed" and "none of these
  are any good" must never be the same value.
- **A memory is never rewritten, and that is not an oversight.** The obvious
  change to `memories` is to update a fact in place when it stops being true.
  Doing it deletes the only thing that makes the table more than a key-value
  store: "dark hair (2025-01)" followed by "blond hair (2026-01)" is what lets
  Newy answer *"blond, since January — dark before that"*. Verified against the
  live model, which said exactly that. `forget-memory` is for a fact that was
  never true, not for one that changed.
  ([0014](docs/decisions/0014-two-tier-memory-for-ava.md))
- **The memory reviewer's prompt was calibrated backwards on the first try, and
  a plausible prompt is not evidence.** Told to drop borderline notes, it
  returned an *empty list* on three runs out of three — which would have deleted
  a new job and a named sister. The asymmetry runs the other way: a wrongly kept
  note costs one line, a wrongly deleted one is gone silently. Then, told to drop
  duplicates, it returned the duplicate *with a reason saying it should be
  dropped* — the reason field is a scratchpad unless the prompt says everything
  returned is kept regardless of what its reason says. Re-run the fixture set
  three times after touching that prompt or changing `AVA_MODEL_MEMORY_REVIEWER`;
  one green run proves nothing.
- **The ranker moves ±10 points on identical input, so a prompt A/B without a
  control is worthless.** Adding the reader-notes block
  ([0016](docs/decisions/0016-reader-notes-in-the-ranker.md)) moved 11 of 14
  scores on the first measurement, which looks like a working feature and was
  nearly reported as one. Running the *same* prompt three times showed a mean
  max-min spread of **10.0 points per item** — almost every delta was inside it,
  and the two that weren't pointed the wrong way. Any claim about a ranking
  prompt needs both conditions run at least three times and the within-condition
  spread reported next to the between-condition delta. To measure whether the
  model acts on something at all, don't A/B *presence* — flip the input's
  *direction* and watch the items it names: `+80.0` on those against `+5.3` on
  the rest is a mechanism, `+15` on everything is weather.
- **French is a facade on Newy's replies, and nowhere else.** A memory may record
  that the reader writes in French and expects `vous`. That note is now in the
  *ranker's* prompt too, where obeying it would produce French `reason` strings
  in `items` — read later by `search-news`, by the article writer, and by
  whoever opens the database. Every stored string, every prompt, every note is
  English; only the text Telegram shows a human follows the reader's language.
  Both prompts say so explicitly (`curator.ts` for reasons, `newy.ts` for notes)
  because neither model infers it — verified across six ranking runs carrying a
  lasting "writes in French" note, all reasons English.
- **`decide` and `apply` are separate steps so a bad model response can't
  delete.** `reviewMemories` throws when the response has no parsed object rather
  than returning `[]`, because the caller deletes everything not promoted —
  "the model returned junk" and "nothing was worth keeping" must never be the
  same value. Promotion also runs *before* the sweep, and the sweep matches
  `tier = 'short'` only, so a note rescued this run cannot be deleted by it.
- **Newy's instructions are a function now, and the notes go in a second system
  message.** Concatenating them into the one string would change the whole
  prompt every turn and lose the cacheable prefix. The block also carries today's
  date — without it every date in the notes is an opaque string and the
  supersession reading doesn't happen at all.
- **A slash command still carries the swipe.** `handleSlashCommandUpdate` passes
  the untouched Telegram payload through as `event.raw` (verified in
  `@chat-adapter/telegram` 4.35), so a reply the reader typed `/translate` into
  reaches the handler with `reply_to_message` intact. That is the whole reason
  the translation commands work on a swipe without a second inbound path —
  `quotedSource()` is the same parser and the same link-to-item lookup the
  message path uses. Don't add a message-path special case for a command.
- **A prompt rule obeyed 99% of the time is a bug at this volume.** Densely
  glossing an article asks the model for hundreds of small judgements in one
  response, so "never gloss a proper noun" still shipped
  `OlmoEarth (OlmoEarth)`, and "never gloss a grammatical word" still shipped
  `sont (are)` and `dans (in)`. Strengthening the prompt moved density from 47
  glosses per 100 words to 29 and eliminated neither. `pruneGlosses` in
  `translator.ts` strips exactly the two cases that need no judgement — an echo
  of the word in front of it, and a bare English function word. Anything needing
  taste stays in the prompt and stays imperfect. Note the elision split in there:
  without it `L'API (API)` is not an echo, and in French the article fuses to the
  noun constantly.
- **`htmlToText` used to space out every tag, which destroyed code.**
  `<code>WebAssembly</code>.<code>compileStreaming</code>()` was stored as
  `WebAssembly . compileStreaming ()` — invalid, and invisible for the life of
  the project because a summary never quoted code. The translation commands put
  code in fenced blocks, where it is unmissable. Inline tags are now stripped
  rather than replaced with a space, and `td`/`th` had to join the block-closer
  list so table cells still separate. **Only new items benefit** — a conditional
  GET means an existing row keeps its mangled body forever, which is why the
  translator's prompt *also* repairs code spacing. Don't remove one fix on
  finding the other.
- **`translation.readerLevel` is the lever, not the gloss wording.** Both
  commands filter by CEFR level before anything else. Set to B2 the model glosses
  `raffinement` and `s'emboîtent`; with no level at all it glossed
  `vous n'avez (don't have)` and `petit (small)`, which is the feature failing
  while appearing to work. The two commands separate on the *same* axis —
  `/translearn` at the level and above, `/translate` only above it — and when
  that distinction was left to words like "dense" and "sparse" they converged to
  within two glosses of each other. Re-measure `minGlossesPer100Words` after
  changing the level; it went from ~27 per 100 words unlevelled to ~7.4 at B2,
  and a floor left at the old value retries every good run.
- **Telling a model to drop boilerplate makes it announce that it did.** The
  fetch fallback in `read-article` carries nav chrome, which a summary tolerates
  and a *translation* renders verbatim — a real run opened with
  `Retour aux Articles (Back to Articles)` and the CSS fragment `a]:hidden`.
  Adding a "drop page furniture" rule fixed that and produced a run whose first
  paragraph was a bulleted note listing what it had removed. Both rules are
  needed: drop it, **and** never describe the drop.
- **A YouTube caption URL from the watch page answers 200 with an empty body.**
  The page still advertises its `captionTracks` and every one of those URLs is
  dead without a proof-of-origin token — a `200`, a `content-length` of zero, and
  no error anywhere. The route that works is InnerTube's `player` endpoint called
  with a **mobile client profile**, which is what `youtube-caption-extractor`
  does. Measured 2026-08-06, of the three profiles it tries **only iOS is alive**:
  Android VR answers `LOGIN_REQUIRED` and Web answers `UNPLAYABLE`. So its
  "fallback chain" is one working profile, and the day that one goes, every video
  fails at once. `pnpm youtube:check` is how that is noticed and
  `pnpm update youtube-caption-extractor` is the fix — not this repo's code.
  ([0032](docs/decisions/0032-a-youtube-link-summarizes-itself.md))
- **A YouTube title is not *the* title — YouTube A/B tests them per viewer, so
  the one fetched here is very likely not the one the reader clicked.** This came
  out of a real session: the reader asked why the speaker said he was wrong, the
  summary said nothing about it, and the title we fetch is `Shadcn UI? in 2026?`
  — no reversal anywhere in it, and grepping the spoken text for "was wrong",
  "mistaken" and "take it back" returns **zero** hits. The reversal was in the
  variant *they* were served, and the "I was wrong" framing most likely lives in
  the **thumbnail**, which is an image and reachable by nothing here. So the
  title is passed to the summarizer as context and the prompt requires the claim
  to be *addressed* while forbidding the title to be *quoted* — writing
  `the video, titled "…", never explains` tells a reader looking at a different
  title that the wrong video was summarized. The description's first line is
  passed alongside it and is the steadier of the two: written once by the author
  rather than tuned per viewer. Here it is *"Should you still Shadcn UI or are
  you better off using another 'traditional' UI library?"*, which is what the
  video is actually about, and it now frames the opening paragraph of every run.
  Only the first paragraph — the other 600 characters of that description are
  course plugs, affiliate links and five social profiles.
- **A transcript is ten times the length of an article, and the article cap
  silently truncates it into a plausible lie.** Speech runs ~940 characters a
  minute, so `summary.maxSourceChars` (8,000) is the first *eight and a half
  minutes* of a video. Measured: Karpathy's "Let's build GPT" is 1h56m and
  **108,990 characters** — the article cap would have summarized 7% of it and
  produced something that reads exactly like a correct summary. `youtube.maxTranscriptChars`
  is a separate number (120,000) for this reason, and the two must never be
  merged "for consistency". When it does bind, the tool reports the cut **in
  video time** (`the first 2h07m of 2h45m`) and Newy is required to pass that on;
  a percentage is not something a reader can act on.
- **Only the summary's *relay* goes through Newy, and that is the one place she
  copies text instead of writing it.** `summarize-video` returns finished blocks
  from the summarizer, and her prompt tells her in blunt terms to reproduce them
  verbatim. This deliberately re-enters the risk ADR-0018 avoided by keeping
  `/summarize` off her — m3 closing `</think>` mid-answer truncates long replies —
  so if a video summary ever arrives starting mid-word, that is the known cause
  and the fallback is `postMessage` like the commands use, not an adapter change.
- **A prompt rule written in English gets applied to English.** `/summarize`
  was told never to write about the article, only about its subject — the usual
  "no 'This article covers…'" rule. Four live runs on one article: both English
  runs obeyed it and both non-English runs broke it, with
  `Cet article détaille une conversation…` and
  `Este resumo aborda um painel de discussão…`. The model was matching the
  *strings* the rule named rather than the shape of sentence it described. The
  fix was to quote the observed non-English openers verbatim and say outright
  that the rule is about the sentence, not about the English words — zero of
  four on a re-run of the same article. **So test a multilingual prompt in the
  languages it will actually run in**; an English pass proves nothing about the
  others, and this is the same class of failure as the reasons-must-be-English
  rule in the ranker, seen from the other side.
- **"Code goes in backticks" over-applies to proper nouns.** The same command
  came back with `Claude Code`, `Claude Tag` and `Fable` fenced as code
  throughout, which reads like a config file. Adding an explicit "a name is not
  code — backticks are for things you would *type*" cut it to three instances in
  one run of four (`Bun`, `Rust`, `Slack`) and did not eliminate it. Left in the
  prompt deliberately: a deterministic backtick-stripper would corrupt the real
  code spans the rule exists to produce.
- **`deepseek-v4-flash` has a latency range, not a latency.** Ten runs on one
  1556-character chunk: 9s, 11.6s, 21.1s, 25.7s, 52.8s, 68s, 107s, 160.8s,
  207.7s, 282.8s — a factor of thirty, uncorrelated with output length. Two runs
  will tell you whatever you want to hear, in either direction; the first pair
  measured here said 68s/107s and nearly justified switching models on it. Don't
  quote a number for this model, and don't tune a timeout against one.
- **`pnpm-workspace.yaml` is a build input, and the Dockerfile has to copy it.**
  pnpm 10+ refuses to run a dependency's install script unless it is approved in
  that file, and it **errors** rather than warning — `ERR_PNPM_IGNORED_BUILDS`,
  exit 1. The only entry here is `esbuild`, whose postinstall fetches the native
  binary `mastra build` needs, so the file is not optional decoration. The
  Dockerfile copied `package.json` and `pnpm-lock.yaml` into the install layer
  and nothing else, which meant **`docker compose up --build` had never worked**;
  found 2026-07-30 by running it. Anything else that install reads belongs in
  that same `COPY`, before `pnpm install`, not with the source afterwards.
- **Pin `packageManager`, or corepack picks the pnpm of the day.** With no pin,
  `corepack enable` fetched **11.18.0** into the image against a lockfile written
  by **11.0.3** — same major by luck, and the next major would arrive just as
  quietly. `package.json` now pins it and the Dockerfile sets
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, since the download is not a decision
  anyone is present to make.
- **`environment:` beats `env_file:` in compose, and that is what makes the
  container's paths safe.** `.env` is written for the dev machine — copying
  `.env.example` verbatim brings `AVA_MIGRATIONS_DIR=drizzle` with it — so the
  three path variables are overridden explicitly in `docker-compose.yml`. The
  relative value does resolve in the container (the bundle ships a package.json
  for `resolveFromRoot()` to anchor on), but leaning on that walk is how "Can't
  find meta/_journal.json" happened the first time.
- **An empty `ava-data` volume against a chat you already use is not a clean
  start — it is a fork.** The container's database has no `telegram_topics`, and
  the persisted id is the only authority on whether a tab exists, so
  `resolveTopics()` creates a **second** Chat, News and Translations in the same
  chat; `createForumTopic` is not idempotent and `deleteForumTopic` is not wired,
  so that cleanup is manual. It also re-seeds `beats` from
  `src/config/seed-beats.ts` — losing every beat made with `/follow`, which lives
  nowhere else — and empties `feed_state`, so the next digest re-ingests
  everything and re-delivers read news. Seed the volume from `.data/` first
  (procedure in the [README](README.md#moving-an-existing-database-into-the-volume)).
  Checked 2026-07-30 against a seeded volume: 3 beats including `formula-1`, 967
  articles, all 5 topic rows, clean FTS `integrity-check`.
- **A bot's own profile is three fields and three *different* nouns.**
  `setMyName` is the chat title, `setMyShortDescription` is the profile page and
  share previews, `setMyDescription` is the empty-chat screen above Start. The
  wire names are not the config names (`short_description`), and each has its own
  getter — so unlike `setMyCommands`, `publishProfile()` reads all three back and
  pushes only what drifted. That is not a micro-optimisation: `setMyName` is
  flood-limited, and a container in a restart loop pushing it every boot would
  lock the bot out of renaming itself for the day. All six methods verified
  against the live bot 2026-07-30, including the writes — probe them with
  `language_code: 'eo'`, which exercises the real method against a locale nothing
  will ever request and leaves the default profile untouched.
- **A private chat's `chat_id` is the user's id, so two bots see the same one.**
  Telegram user ids are global, not per-bot, and for a private chat `chat.id`
  *is* that user id — so `NEWY_TELEGRAM_CHAT_ID` and `JOOB_TELEGRAM_CHAT_ID`
  hold the **same value** (`8401775038` here), which is also the reader's entry
  in both allowlists. The conversations are still distinct in the client because
  the token differs; nothing else distinguishes them. This was asserted the wrong
  way round in the first draft of ADR-0023 and in `.env.example`, both of which
  said the two chat ids must differ.
  Two consequences, and the second one bites:
  - `telegram_topics` is keyed `(botId, chatId, slug)`. Keyed on chat and slug
    alone — which is correct for supergroups, where two groups are two ids —
    both bots write `('8401775038', 'chat', …)`. The second bot then adopts the
    first's thread id, fails to send into a thread that isn't in its
    conversation, and `invalidateTopic` deletes the *other* bot's row; that bot
    recreates it, `createForumTopic` is not idempotent, and a duplicate tab
    appears. Never query that table without a bot id.
  - `TELEGRAM_CHAT_ID` is still not redundant with the allowlist, despite
    holding a value that appears in it. The allowlist says who may *talk*; the
    chat id says where a cron fire — which has no message to reply to — should
    *send*. They diverge the moment there are two allowed users, and on the
    supergroup route the chat id is a `-100…` group that is nobody's user id.
- **A statement above an `import` does not run first, and two scripts here are
  written as if it does.** ESM hoists every `import` above all top-level
  statements, so `process.env.X = …` or `delete process.env.X` written at the top
  of a script executes *after* the imported modules have already loaded and read
  their config. Proven with a probe: a variable set on line 1 reads `undefined`
  inside the module imported on line 3, and a deleted one reads its old value.
  **This cost a live database write on 2026-08-05** — a verification script set
  `AVA_DATA_DB_URL` to a copy above its imports, `env.ts` parsed the default
  first, and migration `0018` applied to `.data/ava.db` instead of the copy. No
  data was lost and the migration was the intended one, but it landed on
  production by accident. `check-discovery.ts` and `check-sonar.ts` both use the
  `delete process.env.*_TELEGRAM_BOT_TOKEN` form and it is equally ineffective;
  invariant 7 survives there only because neither import graph reaches an agent
  that polls — `telegram.ts` is outbound-only and builds its adapter lazily. Do
  not add an import to those scripts without checking that. **The reliable way to
  point a script at another database is the command line**
  (`AVA_DATA_DB_URL=… tsx …`), not an assignment in the file. To exercise a
  migration against a copy, verify with a *fresh connection in a separate process*
  — a client opened before the migration ran reported the stale row count and
  hid the problem for two steps.
- **`.history/` must stay gitignored.** An IDE extension snapshots `.env`
  verbatim into it.

## Where work stopped

*Last updated: 2026-08-09.*

**Duplicates are dropped before the scorer, not after it — `dedupe` in
`src/mastra/workflows/find-jobs.ts`, `advertKey` in `job-identity.ts`,
`employer()` in `job-fetch.ts`, `recentlyDelivered` in `db/jobs.ts`.** Two fixes
for one report ("*I feel like I've seen jobs sent a few days ago*"): the cause,
which is an ATS board filing postings under its token instead of the employer's
name, and the guard, which is that a duplicate now loses its batch slot rather
than a model call. See the two gotchas above for both rules.

**Measured on the live database, 2026-08-09: 1,019 stored postings, 1,017
distinct identities — identity alone was catching nothing.** The advert key drops
**54** of them: 28 `ats-lever-3pillarglobal`, 16 `ats-ashby-owner`, 8
`ats-ashby-peec`, one `jobicy` and one `remotive` (a genuine same-advert repeat
within one board), plus 2 on identity. **Three had already reached the reader
twice**; the other 51 were sitting undelivered, primed to go out twice. After the
`employer()` fix all four live ATS boards agree with `sonar` on the employer name
— `3Pillar Global`, `Owner.com`, `Peec AI`, `Vercel` — so those rows stop being
*created*, and the dedupe is the guard for the next provider that disagrees.

**The existing duplicate rows were deliberately left in place.** They are
suppressed by the guard on the way to the scorer, so no cleanup migration runs
over data the pipeline already handles correctly; `pruneJobs` clears them on its
own schedule.

**The ledger check moved and one stayed.** `assignBest` still checks
`recentlyDelivered`, because `dedupe` runs per search and cannot see a pair split
across two of them — that is exactly how the 2026-08-09 pair went out in the same
second. `duplicates` is now a counter on the run report and is named in the
finish notice, because a run that judged 12 of 90 looks like a thin week and may
instead be one board arriving twice.

**Domains are vocabularies now, and a search names its own field —
`src/config/job-taxonomy.ts` (`DOMAINS`, `domainIds`, `isKnownDomain`),
`jobTags`/`filterJob` in `src/services/job-filter.ts`, `job_searches.domain`,
migration `0021`, and
[ADR-0030](docs/decisions/0030-domains-as-vocabularies-a-search-names-its-field.md).**
Ten vocabularies — `software` and `chemistry` curated properly, seven shallow
recognise-and-reject fields, plus `people`. A posting is tagged `domain:<id>` for
every vocabulary its **title** matches; rejection is a set intersection against
the search's own domain. `NON_TECHNICAL` and `describesSoftwareWork` are deleted.

**A domain declares what it is, never what it is not — that inversion is the
whole change.** The old shape only ever saved a software search, because nothing
recognised an accountant as an accountant; a chemistry search paid full model
price for a board's entire intake. Measured on 300 live postings: 24 rejected by
domain (16 sales, 4 finance, 2 healthcare, 1 legal, 1 people operations, 1
chemistry), each naming both sides — *"looks like a sales role, and you asked for
software"*.

**`pnpm jobs:check` after any vocabulary edit — a term that fails to match is
silent.** It found two misses in the first run that reading the file did not:
`medical` had been dropped for fear of catching "Medical Device Engineer" (the
fear was unfounded — under intersection that title holds both domains), and
`call center` was listed while `contact center` was not. Silence here looks
exactly like a quiet week.

**Domain membership comes from disciplines only, never from skills.** A polymer
advert asking for Python in its body is not a software posting. Skills feed
`rankByCvOverlap`, which may only reorder and never reject — and they are
domain-qualified now (`skill:chemistry.chromatography`), which fixed a silent
no-op: under the flat `tech:` namespace a non-software reader's CV produced an
empty tag set and the whole ranking step quietly did nothing.

**Tagging moved from ingest to filter time, and that is the load-bearing part for
adding fields later.** `jobs.derived_tags` was written once when a posting was
stored, so a vocabulary added on a Tuesday described nothing collected before it
— the `seed-beats.ts` trap ("editing it does not reach a beat that already
exists"). Tags are derived when read now, memoized per batch; the column stays as
the audit trail. **Bare `engineer` is deliberately still in `software`**, so
"Chemical Engineer" carries both domains — harmless under intersection, and
removing it drops real adverts titled only "Engineer".

**Not done: the news side has no equivalent.** `beat_feeds` has no source-kind
discriminator at all, where `job_sources` has five, so a *query* source — arXiv,
PubMed, Europe PMC, where the subject goes in the URL and no homepage advertises
the feed — cannot be reached by `discoverSiteFeed`, which only ever asks where a
site's existing stream lives. Probed 2026-08-06: `export.arxiv.org/api/query`
answers `200 application/atom+xml` with real Atom, so **no schema change and no
new kind is needed** — `rss.ts` does not care that a URL has a query string, and
a query feed is a `beat_feeds` row with a longer URL. The only new code is a
builder plus a small host table, called as a third route in discovery with
`checkFeed()` verifying as usual. Two things measured: `all:"plastic
degradation"` returned 1 relevant paper in 3 (*"Sparsity-Driven **Plasticity** in
Multi-Task RL"* matched on stemming), so field-scoped terms (`abs:`, `ti:`) are
required; and the query is baked into the URL while `retune-beat` never touches
feeds, so a retuned beat would keep searching its old terms forever — silently,
the same failure class as a wrong feed URL.

**Six applicant-tracking providers, and the probes run concurrently —
`src/services/ats.ts` (`PROBE_ORDER`, `PUBLISHES_COMPANY`, `fromWorkable`,
`fromRecruitee`, `fromPersonio`) and
[ADR-0029](docs/decisions/0029-six-ats-providers-probed-concurrently.md).**
Workable, Recruitee and Personio join the original three. Verified end to end:
**66 postings across four boards, zero with a body under 200 characters**, which
is the bar the module exists to enforce. Four of six now publish the employer's
own name, so `companyAgrees` covers Workable, Recruitee and Personio too.

**A board token is not an employer name, and filing postings under one ships
duplicates — `employer()` in `src/services/job-fetch.ts`.** Lever and Ashby
publish no company name anywhere in their posting API, so `ats.ts` fills in
`board.token`. That is a placeholder, not data: `sonar` discovers the employer as
`3Pillar Global` and stores that as the source label, then the board it just
discovered is polled directly and calls the same advert `3pillarglobal`.
`normalizeCompany` cannot see those as one employer, so the two hash to two
identities, and **the reader was sent three adverts twice — measured 2026-08-09**,
two of them in the same second. A source row's `label` is the employer name; a
provider's published name beats it, the token never does. **The old fallback was
`posting.company || source.label`, and the `||` is precisely the bug** — the token
is not empty, so the label never won.

**Same URL is a one-way proof of sameness, and it is the only safe way to use a
link in this pipeline — `advertKey` in `src/services/job-identity.ts`.**
`jobIdentity` refuses to hash links because one role on five boards has five URLs
([ADR-0024](docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md)), and
that argument runs one way only: different URLs prove nothing, but two rows at one
URL *are* one advert. So `advertKey` is a second key, never a replacement — it
catches what identity structurally cannot, including the token duplicates above
and a cross-month repeat.

**The title is in that key because a URL alone silently hides a job.** RemoteOK
serves its own index page, `remoteok.com/remote-jobs/`, as the URL of any posting
it has no permalink for, and two unrelated adverts were sitting behind it — a URL
key alone would have dropped one. Requiring the titles to agree costs nothing: a
duplicate arriving by two paths off one board carries one title, byte for byte.
**`advertKey` returns null when the title normalizes to empty** and the caller
must then skip it — both RemoteOK rows are in that state, their titles being Greek
and Chinese, and a bare-URL fallback would merge exactly the pair this guard
exists to keep apart.

**The selection rule is the answer to "why not add ATS X", and it is not
negotiable by list length.** Keyless, one request, full advert body. Nine
candidates were tested on 2026-08-06 and five failed: Breezy, Rippling and
SmartRecruiters put no description in the list (a fetch per posting), Teamtailor
answers `406` without an API key. **Workday is the one to remember** — the largest
tracker here by headcount, and it fails on a second axis that disqualifies it
outright: its URL needs a datacenter, a tenant *and* a site name, so
`probeAtsBoards` has no question it can ask. **Being a large ATS and being
reachable by this pipeline are independent properties.** Do not re-test the market
from a vendor list; re-read the rule.

**Personio's `429`s were a red herring and cost a provider for a day.** ADR-0027
recorded it as rate-limiting; it answers `200` six times in a row. The real
blocker is that `<jobDescriptions>` comes back **present but empty** without
`?language=en` — which from outside is indistinguishable from a board whose
postings have no bodies. With the parameter, 3,300–5,700 characters a position.
When a provider looks like it has no advert text, check for a content parameter
before concluding the API is useless.

**Probing concurrently is what decouples provider count from run duration.**
Sequentially each miss costs one `pageTimeoutMs`, so six providers would be up to
90s per employer and ~45 minutes across a run — which makes provider count look
like the binding constraint. It is not one. Measured 322–717ms over four live
probes. The trade is the early exit: a Greenhouse hit now always spends six
requests instead of one, ~180 a day worst case across six hosts. `PROBE_ORDER`
still decides which board wins when a token resolves on more than one, so only the
timing changed. **The new three are ordered last because their hit rate is
unmeasured** — those companies were picked *because* they were known to sit on
those boards, so the endpoints are verified and the frequency is not. Re-order
once a real run has produced data.

**A search decides what counts as a job, not the taxonomy —
[ADR-0028](docs/decisions/0028-a-search-decides-what-counts-as-a-job.md),
extended by
[ADR-0030](docs/decisions/0030-domains-as-vocabularies-a-search-names-its-field.md).**
`flag:non-technical` used to reject **unconditionally, before a single search
criterion was read** — so `/target dentist in Lyon` would have had every dentist
rejected with the reason "not a software role", the word `dental` being literally
in the list. It was killing 43 stored rows.

**The principle is worth stating before touching `job-taxonomy.ts`: the taxonomy
describes postings, and only a search may reject them.** A vocabulary may label a
posting a nursing role; it may not decide the reader does not want one. That is
now structural rather than a rule to remember — see the entry below.

**ADR-0028's own fix was reachable through a back door, and that is the finding
worth carrying.** `describesSoftwareWork` judged a search from keyword overlap,
`DISCIPLINES.ml` contained `research scientist`, and `NON_TECHNICAL` contained
`technician` — so `/target research scientist, polymer chemistry` read as a
*software* search and rejected "Lab Technician — Polymer Analysis" as "not a
software role". Exactly the bug ADR-0028 removed, reintroduced by two overloaded
English words. **An inferred category is invisible, so nobody can see or correct
it, and it cannot break a tie between fields that share vocabulary.** Both
functions are gone; the search says which field it is in.

**Real postings come off the employer's ATS board, and verified boards become
source rows — `src/services/ats.ts`, `leadToPostings` in
`src/services/job-scout.ts`, `recordAtsBoards`/`knownAtsCompanies` in
`src/db/jobs.ts`, the `ats*` tunables in `src/config/jobs.ts`, and
[ADR-0027](docs/decisions/0027-ats-boards-as-discovered-sources.md).** A lead's
description used to be its careers *landing page*, which is marketing copy: on the
2026-08-05 run all six leads were rejected by `mustHave` for never naming a stack,
and the one search with no `mustHave` topped the same six out at 40/100. **Raising
`maxPageChars` could never have fixed it — the problem is the kind of text, not
the amount of it.** Measured after: five companies produced 140 real adverts where
they had produced five rows.

**All three routes to a board earn their place, and the cheap ones do not carry
it.** The resolved URL *is* a board: 0 of 6. The careers markup references one,
usually an embed script rather than a link: 1 of 6. Probing the domain label: 4 of
the remaining 5. **Shipping only the first two would have been a feature that
never fired** — which is how the landing-page problem it replaces went unnoticed
in the first place. The probe is a guess that code verifies; a real 200 carrying
real postings is the only thing that counts.

**Boards as `ats` rows are the pipeline's one compounding step, and that is why
they need decay.** Every other cost is paid again every run. A board keeps
answering, so sonar pays once per employer and the row pays off every run after,
with `knownAtsCompanies` stopping the scout re-proposing employers already being
read. The counterweight: silent for `atsIdleDays` (45) → archived and marked
`idle`; `atsForgetDays` (120) more → deleted. **The gap between the two stages is
load-bearing** — while the row exists the scout skips that employer, so deleting
at the first stage would just have the next run rediscover the same empty board. A
row the reader archived by hand is never deleted.

**`listUnscored` had been ordering the scoring queue by fetch order, not recency,
and two sources had therefore never been scored in any run.** `discoveredAt` is
stamped per posting at ingest, so a posting's millisecond was its source's
position in a fetch batch — Himalayas, alphabetically first and collected first,
never entered a scoring window. `listUnscored` (`src/db/jobs.ts`) now orders on
`coalesce(postedAt, discoveredAt)` — the board's own date, with fetch order kept
only as the tiebreak among exact ties — and ingest stamps one `firstSeenAt` per
run rather than per posting (`src/mastra/workflows/find-jobs.ts`). **A timestamp that encodes batch
position rather than time is invisible until something reads it as time**; check
what stamps a column before ordering on it.

**Newy can inspect a beat and retune it — `src/mastra/tools/beats.ts`,
`src/config/retune.ts`, `retuneBeat()` and `beatRevisionHistory()` in
`src/db/beats.ts`, `topVerdictsForBeat()` in `src/db/articles.ts`, migration
`0019` for `beat_revisions`, and the restated invariant 8 above.** No ADR: the
permission was already ADR-0019's, the rubric's fixed shape was already
ADR-0020's, and the append-only argument is ADR-0014's. What was genuinely new
is in the invariant.

**The reading half is the load-bearing one, and it exists because of a specific
failure.** The reader asked why `ai-model-releases` was sending nothing and Newy
could only answer that she could not change a beat. The true answer was that its
three feeds had **never been fetched** — no `feed_state` row at all, `linked: 0`,
the beat created three hours after the last run — and no rubric edit would have
touched that. A tool that only wrote would have let her confidently rewrite a
rubric that was never the problem. So `inspect-beat` returns `neverFetched` per
feed and the *best*-scored articles rather than the worst, because those are what
separate the causes: nothing ranked at all means the beat is not being fed, while
a top score of 58 against a threshold of 62 means it is being fed and the rubric
is turning it away. Only the second is a retune. **Her prompt says outright that
a rubric cannot fix a missing source** — it only re-ranks what ingest already
brought in — because that is the mistake the tool makes easy.

**A retune supplies `buildRubric()`'s slots, never prose.** The template's
justification does not weaken because the author is Newy rather than the namer: a
model writing a rubric freehand can produce one that reads well and scores badly,
and the ±10-point noise floor means nobody will ever run the measurement that
would tell the difference. A retuned rubric is therefore byte-shaped like one
`/follow` produced.

**A no-op retune writes nothing, and that guard is conversational rather than
general.** A slash command sends a definition once; a model re-sends the one it
just read — the reader says "yes, do it" twice, or Newy restates the current
bullets while proposing a change. Every one of those would append a revision
identical to the live row, and a history full of duplicates stops being readable,
which costs exactly what the table is for. Verified: the same call twice returns
`changed: []` and leaves one row.

Exercised against a copy of the live database (all three files), migration
applied there, confirmed from a **separate process on a fresh connection**:
guard rails return sentences rather than throwing, the retune wrote one revision
holding the old rubric and subtopics verbatim, and `articles`, `article_beats`
and `feedback` were unmoved.

**X/Twitter is a dead end, measured 2026-08-05 — do not re-probe it.** Every
bridge is gone: `nitter.poast.org` 403, `nitter.privacydev.net` unreachable,
`rsshub.app/twitter/*` 404, `openrss.org` 503. **`xcancel.com` is worse than
dead, it is a trap that `checkFeed()` cannot catch** — unwhitelisted it returns a
*parseable* feed carrying one entry titled "RSS reader not yet whitelisted!"
dated 1970, so it passes `ok` and would sit in `beat_feeds` returning nothing
forever, exactly like the `grandprix247.com` sitemap. It whitelists by
User-Agent (only `FreshRSS/…` got through of eight tried), which means adopting
it would mean impersonating another product against a volunteer instance's
deliberate load control. Two findings survive the dead end and are worth
keeping: a vendor's own account is mostly *marketing* — `@Kling_ai` posts
showreels ("Tiny Paws, Big Glam"), not releases — and the search endpoint returns
strangers' replies and bare links, so neither could be verified by code the way
`checkFeed()` verifies a feed. The image and video labs publish no usable feed at
all (BFL 404, Midjourney 403, Luma and Stability HTML, ElevenLabs 404), which is
the real reason that beat is hard to source.

**The `sonar` job source ships — measured over three live runs, 2026-08-05.**
`src/mastra/agents/job-scout.ts`, `src/services/job-scout.ts`, `jobScout` in
`src/config/jobs.ts`, `AVA_MODEL_JOB_SCOUT`, `pnpm sonar:check`, and
[ADR-0026](docs/decisions/0026-sonar-as-a-job-source.md). One sonar search per
active `/target` on the scheduled run; code resolves and verifies every careers
page; verified leads flow through the existing filter, scorer and ledger. No
migration — `kind: 'sonar'` has been in the enum since `0015`.

**Invariant 2's enumeration had been false for weeks, and that is the more useful
finding.** It said only ranking, composing and the weekly memory review call a
model on a schedule. The weekly feed review's `topUp` starts `discoverFeeds`,
which calls the `sonar` beat scout — on a cron, since ADR-0020 landed. Nothing
failed and nobody noticed, which is the argument against enumerations in an
invariant. It is now two *shapes* (a classifier over a fixed row set; a search
whose every answer is verified before storage), and the search shape carries a
condition the other does not: **the loop must be bounded in config**, or "fixed
control flow" lasts only until the reader adds another row.
`jobScout.maxSearchesPerRun` is that bound.

**A lead is keyed on its careers URL alone, and the first two attempts were both
wrong.** Keying it like a posting (company + title + location) fails because none
of those is a fact about the world for a lead — the title and company are a
model's phrasing and the location does not exist, so the same lead takes a new
identity every run and the reader is sent it every cycle. Keying on company + URL
was the fix and **was still wrong, caught by running it three times**: one
employer came back as `Apify` and `Apify Technologies s.r.o.` at the identical
resolved URL, hashing differently because `normalizeCompany` strips `technologies`
but has no `s.r.o.`, giving `apify` and `apify s r o`. Do not extend the suffix
list — it is unbounded and it treats a model's word choice as evidence. Verified
after the fix: `www.`, a trailing slash and a query string collapse to one
identity, `/about` does not collide with `/careers`, and the month still rides on
top so `redeliveryGuardDays` is unaffected.

**The careers page's own text is the lead's description, and this is what makes
the feature work at all.** `filterJob` reads `mustHave` from title + company +
description and *"never mentions X"* is already the largest rejection reason (211
of 437). A lead described only by the model's one-line "why" is rejected almost
every time — the source would have delivered nothing while every counter said it
ran. Do **not** "fix" a low survival rate by asking the model for a richer
description: `mustHave` is a hard filter, and a model writing "React" into a field
a hard filter reads lets a lead pass on invented evidence.

Measured across three runs of the same search, and the variance is the point:

```
resolved   5/6, 4/6, 3/6      (~120s per search, six leads)
filter     100%, 100%, 67%    (2 of 3 runs lost nothing at all)
recurring  only 3 of 6 companies appeared in all three runs
```

**The model is `sonar-reasoning-pro`, and that is the opposite of the beat
scout's answer — five models × 3 runs, scoring careers pages that survive the
filter:**

```
sonar-reasoning-pro   16/18   12 distinct companies    90s
sonar                 11/18    6                       49s
sonar-pro             11/18    8                       52s
sonar-pro-search       9/18    8                       13s
sonar-deep-research    9/18    5                      202s
```

The count understates it: reasoning-pro named Vercel, Linear, Supabase, Grafana
Labs, Sentry and Productboard, where plain `sonar` repeated the same six small
names every run and `sonar-pro` twice returned a *description* instead of a
company name (`Unnamed Austrian SaaS platform company`) — which the prompt forbids
and which still "survived" because it resolved to some page. **Survival count does
not capture name quality; read the company lists too.** ADR-0020 chose plain
`sonar` for the beat scout on its own measurement, and neither choice may be
copied to the other — "name sites that publish about X" rewards a smaller model,
"name employers hiring for this stack right now" rewards the reasoning one.

Four things worth knowing before touching it:

- **`yourmail.de` failed to fetch in all three runs.** That is ADR-0024's "sonar
  can invent a company" risk, and resolution caught it every time — which is the
  whole argument for never storing a model's URL.
- **The prompt rule against marketplaces was obeyed 0 times in 6; the denylist is
  what works.** `arc.dev` was proposed *and survived the filter* in every run of
  both models before `jobScout.excludedHosts` existed — `maxPageChars` makes it
  worse, because `mustHave` scans the whole page and a marketplace listing every
  stack passes every stack filter. Textbook "a negative instruction is a hint,
  never a guard". **Never add an ATS host to that list**: `greenhouse.io`,
  `lever.co`, `ashbyhq.com`, `personio.com` are where real employers put real
  careers pages, and a verification run resolved `archlet.jobs.personio.com`,
  which is exactly the best case. The list is hand-maintained and will go stale.
- **Sonar reads job boards, which narrows what this source is for.** Probed
  against the API: it genuinely searches — 10–15 real citations, a json-schema
  `response_format` does *not* suppress the search, and it names today's date and
  live postings correctly. But its citations are `linkedin.com/jobs/view/…`,
  `indeed.com`, `reactjobs.io`, `remoterocketship.com`, `workingnomads.com` and
  **`remotive.com`, which is already one of our nine sources**. So ADR-0024's
  framing — reaching employers who hire only through their own site — is not what
  happens; it reads the boards this pipeline cannot ingest directly, which is
  still real coverage (LinkedIn and Indeed are deliberately out of scraper scope)
  and still surfaces companies the nine boards do not carry. It also explains
  `arc.dev` exactly: LinkedIn carries a posting titled "… at Arc.dev", and the
  model read the intermediary as the employer. Because it re-reads boards we
  ingest, a role can in principle arrive twice — once as a posting, once as a
  lead — and the two dedupe keys do not merge. Not yet observed.
- **A searching model writes its footnotes into structured fields.**
  `sonar-reasoning-pro` returned company names reading `Arc.dev[2]`,
  `Factor Eleven[3]`, `yourMAIL GmbH[10]`. Unstripped that reaches
  `jobs.company`, the attribution line under a delivered posting, and would have
  reached the identity hash before the URL became the key — where `Acme[2]` and
  `Acme[5]` are two employers. `stripCitations` in `agents/job-scout.ts` removes
  bare `[n]` markers only; a bracketed *phrase* like `Acme (Remote)` is content
  and is left alone.
- **`pnpm jobs:check` deliberately skips the sonar row** and still reports
  `undated 0`. Its documented promise is that it is safe at any time and calls no
  model; `sonar:check` is a separate command because it breaks both halves of that.
- **A seed does not reach a database that already has rows, and this nearly
  shipped as dead code.** `seedJobSources()` writes only when `job_sources` is
  *empty*, so adding a tenth entry to the seed array reached no existing
  deployment — the source would have existed in the code and never been fetched
  anywhere real, with no error. `drizzle/0018_seed_sonar_source.sql` is a
  hand-written data migration (the `0011_reset_feed_state` pattern: no snapshot,
  hand-added journal entry) that inserts the row `ON CONFLICT DO NOTHING`. Making
  the seed upsert instead is the tempting alternative and is worse — it would
  resurrect any archived source on every boot, forever.

**Not yet done: a live scheduled run.** Everything above is `sonar:check`, which
calls `proposeCompanies` and `resolveLeads` directly. The assembled path — ingest
routing a `sonar` row, `recordSourceFetch` on it, leads reaching the scorer beside
board postings — has not been exercised by a real `findJobs` run, and the lesson
already recorded on this pipeline is that verifying steps proves the functions and
not the assembly. Check `job_runs` and the `sonar` row's `last_status` after the
first one.

**A boot now catches up a pipeline that has gone quiet — 2026-08-04.**
`src/mastra/boot-catchup.ts`, `src/config/catchup.ts`, `pnpm catchup:check`, and
[ADR-0025](docs/decisions/0025-a-boot-catch-up-for-a-stale-pipeline.md). Past its
bar, a pipeline's soonest schedule is fired through `mastra.schedules.run()` —
unless that fire is under thirty minutes away, or the schedule is paused.

**The bar is per pipeline and the two numbers are not interchangeable:** seven
days for news (three digests a day, so twenty missed fires) and **three** for jobs
(a daily fire gated to every other one, so seven days would be three missed
cycles). One bar for both was the first draft and inverted the intent — it made
the slower pipeline, whose silence is hardest to notice, wait the longest for
help.

**The jobs bar is arithmetic against `jobPipeline.intervalHours`, not a
preference.** A 44h gate against a daily fire runs every *other* fire: 48h apart
on the usual rhythm, and up to `intervalHours + 24` = **68h** after a run that
started off the 08:00 rhythm — which is exactly what a catch-up run produces, so
the pipeline puts itself there. Two days (48h) falls *inside* that, which made an
ordinary restart cost a scoring call; 72h clears the ceiling by four hours. Raise
`intervalHours` past 48 and the ceiling climbs back through 72 with no error
anywhere — `pnpm catchup:check` carries the case that goes red, verified by
raising the gate to 50 and watching it fail.

`decideCatchup` is pure, takes `staleAfterDays` as an argument so both bars go
through one function, and has sixteen cases over it, all passing — including the
two that cost money when wrong (an overdue schedule the tick has not claimed yet
reads as imminent and is left alone; a paused schedule stays paused at 30 days
stale) and the boundary, which is inclusive: at exactly the bar it fires. Live,
against the real database: news 6.1h stale against 168h, jobs 7.6h against 72h,
both correctly left alone. `pnpm typecheck` clean.

**Step 1 of Joob has landed: the surface is per-bot — 2026-08-03.** Nothing
job-related is in the tree yet; this is the refactor that makes a second bot
possible, with Newy unchanged from the reader's side.

`src/config/bots.ts` is the registry — id, env prefix, tab set, profile — and it
is what the transport is now constructed against. `src/config/topics.ts` kept the
shared vocabulary and Newy's three tabs moved to `newy-topics.ts` with their
slugs untouched. `src/services/telegram.ts` became
`createTelegramTransport(bot)`, holding the adapter and both tab caches as
instance state instead of module singletons; `src/services/newy-telegram.ts`
exports the one Newy instance the news pipeline sends through. Every function in
`telegram-topics.ts` takes the bot it acts on. `telegramEnv()` and friends read
under a per-bot prefix and cache per bot.

Two things worth knowing before touching it:

- **`newyTelegram.sendToTelegram(...)` at a call site is the ownership marker.**
  The free `sendArticle(...)` said nothing about which chat it meant while there
  was one bot; a job-side caller reaching for Newy's transport is now visible in
  review rather than at runtime.
- **`TopicSlug` is gone as a global union.** Each bot carries its own slug union
  through `BotDefinition<Slug>`, so `sendToTelegram(text, 'jobs')` is a type
  error in Newy's chat. That generic plumbing is the cost ADR-0023 records; the
  alternative was widening slugs to `string` and losing the system-tab/beat-tab
  distinction `BEAT_TOPIC_PREFIX` exists to protect.

Verified: `pnpm typecheck` clean, and `pnpm telegram:check` run against the live
bot — chat `8401775038` private with Threaded Mode on, profile up to date, all
three tabs resolved (`💬 Chat` #106015, `📰 News` #103659, `📜 Translations`
#104044). That exercises the per-bot env resolution, `callBotApi`, `profileDrift`,
`topicRoute` and the topic list through their new signatures.

**Not yet exercised: the outbound transport and the inbound router.** Nothing has
been *sent* through `createTelegramTransport`, and no message has been routed
since `routeToChatTab` started reading `telegramChatId(NEWY_BOT)`. Both need
`pnpm dev` and a real message.

> **Corrected 2026-08-05: `scripts/` *is* typechecked.** This paragraph used to
> say it was outside `tsconfig`'s `include` and that `check-discovery.ts` carried
> a `formatConverter` error only visible by hand. `tsconfig.json` reads
> `"include": ["src/**/*", "scripts/**/*"]`, and `pnpm typecheck` does compile
> every script — a stray file under `scripts/` fails CI, which is how this was
> noticed. Do not skip `pnpm typecheck` believing a script is unchecked.

**Joob itself is decided and not built — 2026-08-03.** Two ADRs, no code.
[ADR-0023](docs/decisions/0023-a-bot-per-agent-two-tokens-two-chats.md) settles
the surface question ADR-0022 deliberately left open: **a second bot token and a
second chat**, not two agents behind one bot. The deciding detail is that
`setMyName`, `setMyDescription` and `setMyShortDescription` take `language_code`
and nothing else — only `setMyCommands` is scopeable — so one token means one
name for both agents, and the chat title above everything Joob ever sent would
read `Newy 🪶`. Invariants 7 and 9 are restated above.
[ADR-0024](docs/decisions/0024-joob-a-job-pipeline-beside-the-news-one.md) is the
pipeline: its own tables, everything below them shared.

The intended order, each piece landable on its own:

1. ~~**`src/config/bots.ts` and per-bot topics.**~~ Landed — see above.
2. ~~**Joob talking.**~~ Landed, unprovisioned — see below.
3. ~~**`/target`, `/targets` and `/untarget`.**~~ Landed — see below.
4. ~~**The portfolio fetch and `pnpm portfolio:check`.**~~ Landed, unconfigured.
5. ~~**Schema, sources and ingest.**~~ Landed — see below.
6. ~~**Scoring and delivery.**~~ Landed — see below.
7. **A live run against the real bot.** Nothing has been *sent* by either bot
   since the transport refactor.

**The job pipeline runs end to end — verified step by step against a copy,
2026-08-03.** `findJobs` (`src/mastra/workflows/find-jobs.ts`), the scorer and
writer agents, and `job_runs` (`0016`). One real pass over the live boards and the
real CV:

```
fetched 457 → 438 inside the 30d window → 384 stored (dedupe)
240 pending → filter keeps 40 → scorer returns 40 valid, 0 unanswered
fit: 2 at 85+, 2 at 70–84, 6 at 50–69, 19 at 20–49, 11 under 20
threshold 70 → 4 winners → 2 written and delivered → 2 ledger rows
```

The verdicts read as real judgements against the CV, not keyword matching:
*"Small product team, full-stack, AI-driven, matches product engineer role"* at
85, with `domain: pet health, not AI or B2C` as its mismatch; Coinbase scored 65
on `company type: large company, not small human-scale team`.

**The scorer took 467 seconds, and that is accepted.** One call, 135,680
characters ≈ 34k tokens, of which the CV is 20k, on `deepseek-v4-flash` — the
model this file documents as having *a latency range, not a latency*. **Duration
is not the risk**: the run is unattended, nothing waits on it, and a slow
scheduled job is simply a slow scheduled job (decided 2026-08-03). Do not "fix"
this by switching models for speed.

What *is* the risk is that it is **one call whose failure costs the whole
batch**, which is why it retries and why a failure leaves postings unscored
rather than scored at zero.

**The first real run did nothing, and the step-level dry run had not caught it.**
`findJobs` fetched 457, stored 383, then reported `considered 0, scored 0` and
finished in **three seconds** — indistinguishable from a healthy pipeline with
nothing to say. `listUnscored` reads *through* `job_matches`, and the workflow
never linked anything into it: `scoreSearch` carried a comment claiming it did
and no call. The dry-run script had called `linkToSearch` by hand, so every piece
worked and the assembly did not.

`linkPendingToSearch` is the fix, called at the top of `scoreSearch`. Two things
it must keep doing: link at **scoring** time rather than at ingest, so a search
created today starts against everything already stored (the `/addfeed` backfill
argument), and stay idempotent, so running it every cycle is one cheap insert
that mostly does nothing. Verified on a copy: 0 unscored before, 383 linked, 240
after the cap, 0 on a second call.

**The CV prioritises the batch; it must never filter it — added 2026-08-03.**
When 235 postings survive the filter and only 60 can be scored, the 60 used to be
the *newest*. `rankByCvOverlap` orders them by how many of the reader's own
technologies a posting names, taking recency as the tie-break. Measured against
the live table with a real loose target: **mean CV overlap in the scored batch
0.57 → 2.80, and 48 of the 60 slots changed hands.** What recency was spending
them on: `Lead Product Designer (Crypto Exchange)`, `Country Director, India`,
`Business Money Engineering` — all zero overlap.

**Why prioritise rather than filter, and why the targeter still never sees the
CV.** A posting that misses the cap is scored on a later run and costs days; a
posting wrongly *filtered* is gone and the reader never learns it existed. So the
CV is allowed to decide what gets looked at first and never what gets thrown
away. The same asymmetry is why `/target` does not feed the CV to the parser:
those fields are hard filters, and inferring `mustHave: [React]` from a CV would
silently discard a Rust founding-engineer role the reader asked for. The one
place the CV may shape a search is the **advisor**, which suggests a tighter
`/target` line for the reader to paste — inference under their eye rather than
under the filter.

**Known caveat, and the reason to re-measure before trusting the order:**
overlap is a raw count, so an agency listing that names twenty technologies
scores high on it. Lemon.io's *Senior Graphic Designer* ranks sixth. Normalising
by the posting's own tag count would penalise that and has **not** been measured.

**A loose target is reported, not corrected.** `constraintCount` ignores `remote`
(set on nearly every target, and only two of its values reject anything) and
counts the six that actually filter. Under `jobCommands.minConstraints` the
advisor fires — one extra call carrying the CV, only on the rare loose target,
never blocking the save. Measured trigger: the real
`/target founding engineer, worldwide` scored **0**.

**Joob can refine a search, and deliberately cannot create or archive one.**
`list-targets` and `update-target` write `job_searches` only — configuration a
future run reads, which invariant 8 permits. This departs from the beat commands'
"no model call at all" rule on purpose: `/target` already answers with a full
summary, and the natural next sentence is *"actually, Paris only"*. Making the
reader retype the whole search to change one field is what stops them correcting
a bad parse — and a bad `mustHave` is the expensive kind. Two guards keep it
safe: creation and archiving stay with the commands, and every write returns the
whole row so the prompt can echo it in the same turn. Verified: a
locations-only update left `remote` and `mustHave` untouched, an unknown slug was
refused, and an archived search cannot be edited back to life.

**The lesson is about the test, not the bug.** Verifying steps by calling their
functions in the right order proves the functions; it cannot prove the workflow
calls them. Anything only the assembled workflow does — the link, the gate, the
state hand-off — has to be checked against a real run's `job_runs` row.

Three more things were found by running that reading could not have caught:

- **A workflow still cannot be driven from a plain script.** `run.start()` hung
  for the full ten-minute timeout, exactly as the gotcha below says. Worse, the
  script had imported `src/mastra/index.ts`, which constructs both agents' polling
  adapters — so the orphaned process **kept polling both bots** until it was
  killed by PID. Step-level scripts must import the agent module directly
  (`agents/job-scorer.js`), never the Mastra instance.
- **`generate()` throws on a schema mismatch rather than returning a null
  `object`.** The writer's first live response came back truncated mid-string —
  `{"summary":"…This role is fully` — and the `?? fallback` pattern used
  everywhere else in this repo does **not** catch it. It would have taken down the
  whole delivery step and lost every other posting in the batch.
- **Mastra retries requests, not malformed answers.** `modelSettings.maxRetries`
  covers a failed HTTP call and `structuredOutput.errorStrategy: 'fallback'`
  substitutes a value *without asking again* — so neither re-prompts a model that
  returned truncated JSON, which is the one thing worth doing about it, since the
  truncation is stochastic. `withRetry` in `services/structured-output.ts` is the
  explicit loop, shared by both pipelines since the news ranker hit the same
  wall; `jobPipeline.modelAttempts` and `pipeline.modelAttempts` are both 2.
  Proven by capping the writer at 40 output tokens: attempt 1 truncated, attempt 2 truncated, returned null and the
  caller degraded to the scorer's own reason — and at the normal budget it
  succeeded on the first attempt.
- **`.default([])` on a schema field is the wrong answer to a truncated
  response, and was tried first.** It does stop the throw, and that is the
  problem: a reply that lost two thirds of its content silently becomes a valid
  one and nothing reports it. A strict schema is what *tells you* to retry. (It
  also makes zod's input type optional while the output type stays required, and
  `response.object` is typed from the input side, so every caller ends up
  normalizing fields the schema already promised.) Both job schemas are strict.

**`findJobs`'s `stateSchema` gives every field a default, unlike `curateAll`'s.**
That is what makes `initialState` optional on every entry point instead of only
in Studio — the papercut documented against `curateAll` below.

**The cadence is in the data, not the cron.** The schedule fires daily at
`jobPipeline.runHour`; `ingest` compares `job_runs.startedAt` against
`intervalHours` (44) and returns an empty list if it is too soon. `startedAt`
rather than `finishedAt`, because a run that crashed halfway still spent the
cycle's fetches and model calls. `{ force: true }` skips the gate for Studio and
for a reader-triggered run.

**Job ingest ships — measured against the live boards, 2026-08-03.** Four tables
(`0015`): `job_sources`, `jobs`, `job_matches`, `job_deliveries`. Seeded with
Remotive and Arbeitnow (`api`) and two We Work Remotely feeds (`rss`).
`pnpm jobs:check` fetches all four for real and writes nothing.

**Measured, 283 postings fetched → 263 distinct ids → 260 distinct identities.**
The dedupe is doing real work, and the numbers say something the design did not
predict:

- **Every merge was *within* a source, not across them.** Remotive lists one role
  once per region — `Staff Software Engineer, Product` at LawnStarter appeared
  **six times** for Brazil/Uruguay/Mexico — and normalizing a remote posting's
  location to `remote` collapses all six. WWR re-posts the same Coinbase and
  Datadog roles two or three times. Cross-board merging is what the key was
  designed for and is **not yet demonstrated**, because these three boards barely
  overlap: Remotive is remote-global, Arbeitnow is German on-site, WWR is
  remote-tech.
- **260 identities under 263 ids** — three roles span two months, which is the
  month key doing exactly what it is for.
- **`undated` is zero.** All three sources ship a posting date, so the date-less
  hole that `job_deliveries` exists to close **does not occur in the current
  source set**. The ledger is still correct to have — the next source may not
  ship dates, and pruning is what makes the hole — but today it is belt to a
  brace that is already holding. Don't read the merge numbers as proof of it.

**Field coverage:** Remotive dated 100% / located 100% / salary 77%; Arbeitnow
dated 100% / located 95% / **salary 0%**; both described 100%.

**Volume is not signal, and this is the coverage cost ADR-0024 recorded.** Of the
283, Arbeitnow's 175 are German-market and mostly not technical — the first three
are a private-banking adviser and two accountants. Remotive's free endpoint
returns **31 postings in total** (`total-job-count: 31`), of which 10 are
Software Development. WWR is the only one of the three whose whole output is
remote tech. Expect the deterministic filters to discard most of this, and do not
read a quiet week as a broken pipeline without checking `jobs:check` first.

Four things about the adapters that were found by probing, not by reading docs:

- **Remotive's `tags` are unusable as a filter.** One agency's graphic-design
  posting carried 40 tags — `.Net`, `golang`, `php`, `rust`, `unity` — covering
  every stack the agency has ever staffed. Tags are stored and never filtered on;
  `mustHave` reads the title and description instead.
- **Remotive's legal notice asks for attribution, a link back, and at most four
  calls a day.** A two-day cadence with the source label under every posting
  satisfies all three. Worth re-reading before adding a second Remotive endpoint.
- **We Work Remotely puts the company in the *title*** — `Cloudflare: Principal
  Partner Solutions Engineer` — and it appears nowhere else. Splitting on the
  first colon is what recovers it.
- **`<region>` is a custom field and must be declared**, exactly like
  `content:encoded` on the news side. Without it every WWR posting is
  location-less and rss-parser says nothing.

**Sources re-cut and a deterministic tag filter added — measured 2026-08-03.**
Nine sources now: Himalayas, Jobicy, Remote OK and Remotive (`api`), and five We
Work Remotely feeds (`rss`). **Arbeitnow was dropped**, not left for the filters:
175 postings, 62% of all volume, opening with a private-banking adviser and two
accountants, and close to zero relevance. A source whose output is almost
entirely noise still costs a fetch, a parse and a tagging pass every run.

**Measured on live intake: 437 fetched → 377 after dedupe → 49 reach the model
for a senior-frontend search. 87% of the scoring bill removed, with no model
involved in removing it.** Rejections, largest first: 211 never mention the
must-haves, 39 are manager roles, 28 mention a dealbreaker, 28 are not software.

**Cross-board dedupe is now demonstrated**, which it was not on the first cut:
`Product Engineer @ SuperPlane` arrived from both Remote OK and We Work Remotely
and merged into one row. 47 ids were carried by more than one posting, against 11
before.

**Never filter on a source's own tags.** Measured on two boards independently:
Remotive tagged a *graphic design* role `golang`, `php`, `rust`, `unity`; Remote
OK tagged a construction **estimator** `golang`, `infosec`, `dev`, `engineer`,
`technical`. Boards let employers tag freely and agencies tag exhaustively.
`jobs.tags` keeps the source's as an audit trail and nothing reads it;
`jobs.derivedTags` is what the filter uses, produced by `src/services/job-tags.ts`
from a hand-curated vocabulary in `src/config/job-taxonomy.ts`.

**Disciplines and seniority read the title; technologies read the body.** That
split is the accuracy of the whole stage. A backend advert saying "you'll work
alongside our React team" is not a frontend job, and matching disciplines
body-wide tags it as one — turning a filter meant to *save* model calls into one
that spends them on the wrong postings.

Three things about it that are honest limitations rather than bugs:

- **Agency listings defeat body-wide technology matching, and the obvious fix was
  measured and rejected.** Lemon.io's *Senior Graphic Designer* survives a
  `TypeScript or React` filter because the advert body lists every stack the
  agency staffs — 20 `tech:` tags on one design role. It is correctly tagged
  `discipline:design`, and the filter has no discipline rule to reject it with.
  Adding a `disciplines` column to `job_searches` looked like the obvious next
  improvement and **is not worth it**: run against the live 377, that rule drops
  **exactly one posting of the 49** that reach the model, and nothing else.
  `discipline:engineering` is a catch-all matching almost every tech title, so it
  waves nearly everything through, and `mustHave` has already rejected 211
  upstream. A column, a migration, a prompt change and a filter rule to save 2%
  of one prompt. Don't re-propose it without re-measuring.
- **26% of postings come back `flag:untagged`.** They are deliberately *kept* —
  "we could not read this" and "this is not for you" must not be the same answer
  — so they cost model calls unless a must-have rejects them anyway.
- **The filter is a cost control, not a correctness gate.** Every ambiguity
  resolves to keep, because a wrongly rejected posting is invisible and costs the
  reader a job, while a wrongly kept one costs a fraction of a model call and is
  caught by the score.

**What the filter is actually for, since it is easy to mis-read:** scoring is
**one batch call for the whole run**, not one call per posting. So 377 → 49 does
not save 328 calls — it is what makes a single call *possible*. At 377 postings
the prompt would run to roughly 450k characters before the CV is added, and would
not fit. That is also why shaving the last posting off the batch is worthless,
and why the next real saving would have to come from cutting a *source*, not from
refining a rule.

**`0015` was regenerated rather than amended with an ALTER.** It had not been
applied anywhere — the live database is at `0013`, and `0014`/`0015` are both
pending — so its file, its snapshot and its journal entry were removed and one
clean migration generated in their place. That is only safe *because* nothing had
run it; check `__drizzle_migrations` before doing it again.

Verified: `pnpm typecheck` clean, `0015` applied to a populated copy of the live
database with the five existing `telegram_topics` rows intact, 9 sources seeded
and 0 on a second call, an insert deduping to 0 on re-insert, and `derivedTags`
round-tripping through the JSON column.

**The CV fetch ships — guards proven against a local server, 2026-08-03.**
`src/services/portfolio.ts` is one function with every guard in it, and it
throws a `PortfolioError` naming which one rejected the response rather than
returning something partial. Nothing is cached and nothing is distilled; see the
head of `src/config/portfolio.ts` for why both were considered and dropped.

`PORTFOLIO_FEED_URL` and `PORTFOLIO_FEED_TOKEN` are unset, so this is inert.

The guard that matters is **content-type, not body sniffing**. A Vercel
deployment-protection wall answers `200` with `text/html`, which is
indistinguishable from a CV to anything that only checks the status — and it
would be scored as one. All seven paths were exercised against a throwaway HTTP
server: valid markdown, an HTML wall at 200, a 401, a near-empty 200, a body over
`maxChars`, a refused connection, and no URL configured. The bearer header was
confirmed on the wire.

**Over-long is truncated, not refused**, and the result carries a `truncated`
flag. Refusing would mean no jobs at all from a document that is merely long,
which is the worse failure of the two.

**The target commands ship — dry-run against a copy, 2026-08-03.** `/target`
takes free text and puts a model between the reader and the row, the shape
`/follow` uses; `/targets` and `/untarget` are deterministic. All three answer in
Joob's Chat, write `job_searches` and nothing else, and start no run.

`job_searches` (`0014`) splits deliberately: everything above `notes` is a filter
applied in SQL *before* any model sees a posting, because the ranker moves ±10
points on identical input and a threshold cut at that noise level would drop good
jobs at random. `notes` carries everything a filter can't express and reaches the
scoring prompt as prose. `request` keeps what the reader typed verbatim, so a
better parser can re-read it later.

**The echo in the reply is a safety mechanism, not a courtesy.** A model wrote
this configuration and these are hard filters — a wrong `mustHave` throws
postings away before anything reads them and the reader never learns what they
missed. Showing every field means a bad parse is visible, and `saveSearch`
upserts on slug, so saying it again more precisely replaces the row.

Dry-run on `/target senior frontend à Paris ou en remote en Europe, TypeScript et
React, pas de SSII, minimum 75k euros` (4.2s, deepseek): slug
`senior-frontend-paris-europe`, label kept in French, `Paris`/`Europe`, senior,
TypeScript + React, 75000 EUR, and **contract correctly left empty** rather than
guessed at. Every reply rendered as clean blocks with no run-on lines.

**Two over-readings worth re-measuring before trusting the parser**, both
surfaced by the echo doing its job:

- `remote: preferred` for "Paris **or** remote". "Or" is acceptance of both, not
  a preference, so `any` is the better answer — the prompt already says *do not
  read a preference into silence* and it was read anyway. Harmless today, since
  only `required` and `onsite` exclude anything.
- `dealbreakers` gained `consulting`, which the reader did not say — it is an
  expansion of `SSII`, and arguably necessary since that acronym appears in no
  English posting. But dealbreakers are hard filters, and this is the model
  adding a term.

Neither was tuned: one observation is not evidence, and the ±10 discipline in
this file applies to a parsing prompt as much as a ranking one. Re-run the same
request three times before changing that prompt.

**Joob exists and talks, and has no token yet — 2026-08-03.** `agents/joob.ts`,
`joob-channels.ts`, `config/joob-topics.ts`, `services/joob-telegram.ts`, and a
`JOOB_BOT` entry in the registry. Two tabs (`💬 Chat`, `💼 Jobs`), memory tools
only, `AVA_MODEL_ORCHESTRATOR` shared with Newy per ADR-0022.

`routeToChatTab` moved to `src/mastra/chat-surface.ts` and takes a `ChatSurface`
— bot, transport, chat-tab slug — so both agents share one implementation.
**`withQuotedMessage` did not move**: it resolves a swipe into a stored
*article*, which Joob has none of, and the job-shaped version resolves a
different table by a different key. Newy's commands stay in `channels.ts` and
Joob's are in `joob-channels.ts`; a single registrar taking a bot would be one
long conditional on which bot it was handed.

**Joob's prompt says outright that the search is not running**, and so does its
`/start`. A welcome describing the finished product would be the first thing the
reader saw and the first thing to be wrong.

Verified offline, nothing sent: profile within all three caps (7/64, 92/120,
418/512), `/start` renders as **9 distinct blocks** through
`formatConverter.toAst` with no run-on lines, and `pnpm telegram:check` reports
`joob` as *not configured — JOOB_TELEGRAM_BOT_TOKEN is unset, skipped* while
Newy still resolves all three tabs. That block check earned its keep immediately:
it caught a `.toLowerCase()` on the command menu rendering `What I do` as
`what i do`.

**To provision it:** a second @BotFather bot, its own Threaded Mode toggle, and
the three `JOOB_TELEGRAM_*` variables. `JOOB_TELEGRAM_CHAT_ID` takes the **same
value** as Newy's — see the private-chat gotcha above.

**Two corrections landed on the way, both found by questioning the design rather
than by running anything.** Recorded because the wrong versions were written
down first and are the more plausible-looking of the two:

- **`telegram_topics` gained `bot_id` (`0013`).** The key was `(chatId, slug)`,
  which separates two supergroups and separates nothing on a private chat. See
  the gotcha above for the destructive failure that would have followed.
  Generated migration hand-edited: drizzle emitted
  `SELECT "bot_id" … FROM telegram_topics`, selecting the new column from the old
  table. Applied to a populated copy before being trusted — 5 rows in, 5 out, all
  backfilled `newy`, thread ids preserved.
- **Newy's env vars gained the `NEWY_` prefix.** Left bare at first on the
  argument that renaming costs an edit per deployment; there is one deployment
  and `docker-compose.yml` uses `env_file`, so the real cost was two files.

Three things in ADR-0024 are worth knowing before reading its schema, because
each is a place where copying the news pipeline produces a bug rather than a
feature:

- **A job's id carries `YYYY-MM`**, from the posting's own date. That is what
  makes a repost months later a new job instead of a silent collision.
- **`job_deliveries` is permanent and is what actually prevents a re-send.** The
  ingest-window-below-retention rule does *not* hold here: a source shipping no
  posting date makes age fall back to first-seen, so a pruned job re-crawled the
  next day reads as zero days old, takes a fresh month key, and re-delivers. No
  tuning of the two windows prevents it. `redeliveryGuardDays` must exceed
  `retentionDays` — 75 against 60.
- **The schedule is daily and the step gates on elapsed time.** `0 8 */2 * *`
  fires on the 1st, 3rd … 31st and then the 1st, so seven month boundaries a year
  give consecutive runs — and a missed schedule firing on boot already put two
  runs in flight at once here once before.

`pnpm portfolio:check` does not exist yet and should land with step 3: the CV is
fetched from `PORTFOLIO_FEED_URL` per run with no cache and no distillation, so
a wrong endpoint or an empty deploy is the kind of failure that produces baffling
matches rather than an error.

**The container provisions the bot, and `docker compose --build` works for the
first time — 2026-07-30.** Two separate things, found together because verifying
the first meant finally running the second.

`src/config/bot-profile.ts` holds the name and both descriptions;
`publishProfile()` pushes them at boot beside `publishCommands()`, so a fresh
token gets its menu, its name, its profile-page line and its empty-chat blurb
with nobody typing into @BotFather. **Threaded Mode is still manual** and now has
nothing else keeping it company.

The build was broken the whole time and nothing had run it: `pnpm install`
exited 1 on `ERR_PNPM_IGNORED_BUILDS` because `pnpm-workspace.yaml` was never
copied into the install layer. See the three Docker gotchas above — all three
were found in one `docker build`.

Verified by running, against the live bot and a throwaway container:

- All six `getMy*`/`setMy*` methods answer. The read path was checked by
  `pnpm telegram:check` reporting **up to date** against config copied from the
  live values — which is also what proved the concatenated string literals are
  byte-identical, em dashes and curly apostrophes included. The write path was
  checked on `language_code: 'eo'`: each of the three wrote, read back equal,
  cleared, and the default profile was unchanged afterwards.
- The image boots from an **empty volume** into a complete deployment: 13
  migrations applied, `articles_fts` and its shadow tables present, 2 beats and
  16 feeds seeded, and all 6 schedules registered in `mastra_schedules`.

**Not yet seen: a real container against the real token.** The smoke test ran
with no `TELEGRAM_BOT_TOKEN` on purpose — `registerChatCommands` returns early
without one, so nothing polled and nothing was published. Booting the real
compose stack starts a second poller if `pnpm dev` is up (invariant 7) and fires
any missed digest schedule on boot, so it is a deliberate act, not a smoke test.

**`/follow <subject>` ships — verified end to end on the real bot, 2026-07-29.**
Say a subject in any language and a working beat comes back
([ADR-0020](docs/decisions/0020-feed-discovery-from-a-subject.md)). This is
phase 2 of managing beats from Telegram, and the **first workflow a conversation
starts** — which the amended invariant 8 permits, for configuration only.

A real `/follow formule 1` from the phone produced both messages in **Chat**: an
acknowledgement naming the beat and its subtopics, then the report ~seconds
later. The database shows what it should — `formula-1` with `archived_at` null,
four feeds with clean source labels, null thresholds so it follows the defaults,
and zero links because those URLs were new to the system.

Two models, split by job, both registered as ordinary agents: `beat-namer`
(cheap, no search) turns the subject into an English title, emoji, subtopics and
rubric bullets; `beat-scout` (`perplexity/sonar`) proposes sites. **The scout
never supplies a feed URL** — `src/services/feed-discovery.ts` resolves each page
deterministically and `checkFeed()` is the only authority. See the six new
gotchas above; every one of them was found by running, not by reading.

**The rubric is a template with slots**, filled from the namer's bullets and
assembled by `buildRubric()`. A model-authored rubric is a real quality risk that
the ranker's ±10 noise floor would hide.

`pnpm discovery:check "<subject>"` dry-runs the whole thing — names the beat,
searches, resolves and verifies every feed, and renders the Telegram report —
writing nothing and sending nothing. Use it before believing any change here.

**Measured yield, and it depends on the subject.** Formula 1 settles at **6/8**
across three runs with zero spread. EU policy ran **3/8, 4/8, 2/8**, and one run
proposed two law firms and a PR agency. `formula1.com` publishes no feed at all;
Sky Sports serves RSS at numeric ids nothing deterministic will find.

**The weekly feed review ships — guards verified against fixtures, 2026-07-29.**
`review-feeds` is the sixth schedule, **Monday 06:00**, between the memory review
at 05:00 and the 08:00 digest. It restores, prunes, tops up, and reports:

1. **Restore** first, so a feed coming back spends the week collecting a fresh
   sample rather than being judged on the empty one it has. Restoring after
   pruning would let a feed be brought back and archived again in one run.
2. **Prune** feeds that earned nothing, under every guard in
   `src/config/feed-review.ts`.
3. **Top up** beats under the cap, by starting `discoverFeeds` with
   `activate: false` — the same path `/follow` uses, so nothing unverified is
   attached and there is no second copy of that logic to drift.

**No model runs in the decision**; it is arithmetic over rows the ranker already
scored. Only the top-up calls the scout.

`beat_feeds` gained `archivedReason` and `trials` (`0012`). The reason is what
separates "the review archived this" from "the reader typed `/removefeed`" — and
**only the former is ever resurrected**. `trials` is the backoff: past
`maxTrials` a feed stays archived and re-adding it is a deliberate `/addfeed`.

**The guard that matters is `minBeatDelivered`.** If a beat has delivered
nothing, the fault is the beat — a threshold too high, a rubric matching nothing
— and *every* feed on it looks worthless. Without it, one misconfigured beat
silently loses all its sources and the only symptom is quieter digests. Verified:
against the live database today, all three beats are **skipped** for exactly this
reason, because nothing is ranked yet. A review firing right now is a no-op,
which is the correct behaviour and was the thing most at risk of being wrong.

`pnpm review:check` runs 13 fixture cases over `verdictForBeat` — the pure,
exported decision — and prints what a live run would do. Every guard has a case.
Add one when you add a guard.

**Per-source stats are on `/beat <slug>`.** `feedPerformance()` groups
`article_beats` by `articles.feedUrl`: collected, ranked, delivered, mean and
best score. It immediately showed that **arXiv contributes 340 of
computer-science's 390 articles** — 87% of that beat's volume and rank cost from
one feed. Note the attribution caveat in that function: `articles.feedUrl` is the
feed a story was *first seen in*, so a feed whose stories usually arrive via a
faster sibling looks emptier than it is. That is why `minCollected` exists.

**No `/findfeeds` command, deliberately.** The weekly review is what re-runs
discovery, so a manual entry point would be a second way to do the same thing.
Studio drives it by hand: **Workflows → discoverFeeds**, with
`{"slug":"…","subject":"…","activate":false}`.

**Not yet seen on a real fire.** Nothing has been archived or restored for real —
the first review has nothing to do until a beat has delivered something and a
feed has 20 collected and 15 ranked against it. The restore path in particular
cannot do anything for 30 days by construction.

**A tab per beat ships — typechecked, not yet seen against the real bot,
2026-07-29.** Phase 4 ([ADR-0021](docs/decisions/0021-a-tab-per-beat.md)).
`deliverBeat` passes the beat row to `sendArticle`, which resolves that beat's
tab, creating it on the beat's **first delivery** and never at `/follow` — a beat
that never wins an article costs no tab. `/pause` closes the tab, `/resume`
reopens it, and neither creates one.

Three things about it that are easy to get wrong:

- **Beat rows in `telegram_topics` are namespaced `beat:<slug>`.**
  `slugPattern` accepts `news`, so `/follow the news` can produce a beat that
  would otherwise share a primary key with the News tab and inherit its thread
  id. Never write a bare beat slug to that table.
- **News is a fallback now, not a destination.** `sendToTelegram` walks an
  ordered chain — beat tab, News, flat chat — invalidating each row as Telegram
  rejects it. A digest in News means a beat tab could not be made, and that is
  the only signal there is: the transport has no logger.
- **`sendArticle`'s target is required.** It used to default to `'news'`. Don't
  restore the default to "simplify" a call site.

**`closeForumTopic` does not exist for private-chat topics — probed against the
live bot 2026-07-29.** With `has_topics_enabled: true` on a `private` chat, both
`closeForumTopic` and `reopenForumTopic` answer `Bad Request: the chat is not a
supergroup forum`, while `editForumTopic` against the *same chat and the same
bogus id* answers `TOPIC_ID_INVALID`. So renaming reaches private-chat topics and
closing does not, and Bot API 9.3's list of extended methods was accurate by
omission. Consequences worth knowing:

- **`/pause` cannot close a tab on a private chat.** A paused beat's tab stays in
  the strip and merely goes quiet, which is what the reply now says.
  `setBeatTopicOpen` returns `'unsupported'` for it — a *tri-state*, not a
  boolean, because the first version returned `false` for both "no tab exists"
  and "the call failed" and so told the owner of a real tab they had none.
- **The call is kept anyway.** The supergroup-forum route is a real deployment of
  this bot and close/reopen work there.
- **Probe with a bogus `message_thread_id`** rather than a live tab; the error
  text is the answer and nothing can be closed by accident. The script is
  disposable — it reads `.env` and raw-fetches, importing nothing from `src/`,
  because importing anything that builds the adapter with a token present starts
  a second poller (invariant 7).

**Verified end to end against the real bot, 2026-07-30.** Two `curateAll` runs
delivered **13 articles into two tabs that did not exist beforehand** —
`beat:computer-science` (`🧠 Computer Science`, thread 104433) and `beat:design`
(`🎨 Design`, 104436), both rows written the moment their beat's first article
was sent. `sendErrors` was **empty on both runs**, which is the proof nothing
fell back to News: the fallback is the only thing that could have put a digest
there, and it records a failure when it fires. Counters reconcile exactly against
`articles` — scheduled run 6 + 1, manual run 6 + 0, database 12 + 1.

`formula-1` is paused and has **no tab**, which is the create-on-first-delivery
rule doing what it says: it delivered 6 articles back when News was the
destination, and pausing it created nothing.

**Two runs were in flight at once, and that was a mistake.** The missed 08:00
schedule fired on boot at 10:13Z, spent ~6.5 minutes on ingest and ranking, and
began delivering at 10:19:58Z — by which point a manual run started at 10:19:09Z
was already going. Nothing was double-sent, because `markDelivered` marks each
article as it lands and the losing run found it gone, but that is the guard
holding rather than the design working. **Check `workflow run list` for a run
in progress before starting one** (invariant 6).

Still no way to *delete* a tab. `deleteForumTopic` is deliberately not wired —
see the ADR's costs.

**The beat commands ship — verified offline, 2026-07-29.** Seven of them:
`/beats`, `/beat <slug>`, `/pause`, `/resume`, `/addfeed`, `/removefeed`, and
`/why` on a swipe. All answer in **Chat**, each as one message.

**These are the first commands that write**, and the amended invariant 8 is what
permits it — `beats` and `beat_feeds` only, never a score or a `deliveredAt`, and
none of them starts a run. They are deterministic handlers with **no model call
at all**, deliberately: archiving a beat should happen because the reader typed
`/pause design`, not because a model inferred it from a sentence about being
tired of design news.

Two pieces here exist for the discovery workflow as much as for now.
`services/feed-check.ts` fetches and parses a candidate and reports entries,
newest date, whether it carries bodies — `/addfeed` refuses anything that fails,
so a model-proposed URL will never reach the database unchecked. It uses its own
fetch rather than `rss.ts` on purpose: that path writes `feed_state`, and
recording an etag for a URL we might not subscribe to would make the first real
ingest answer 304. **Checking a feed must leave no trace.**

`/why` is the payoff for the join table. The ranker has always written a reason
for everything it scores, and a single score column meant a rejected article's
reason was overwritten by whichever beat looked at it last. Now every verdict
survives: swipe an article, and it names each beat, its score, its reason, and
which one sent it.

`beatCommandReply()` is exported for the reason `renderSummary` and `welcome`
are — it produces the message without sending, which is the only way to check
block structure offline. It is *not* pure, unlike those two: checking `/pause`
really does pause the beat.

Verified against the live database, every command including its failure paths:
unknown slug (lists the real ones), missing argument, a URL that 404s, a string
that isn't a URL, double-pause, double-remove, and `/why` with no swipe. All
eleven menu entries are under Telegram's 256-character cap with lowercase names —
one bad entry rejects the **whole** `setMyCommands` call, not one row. Every
reply parsed to distinct blocks through the real `formatConverter`, with the
rubric fenced rather than escaped (it is prose full of parentheses and dashes,
and escaping those is what made the first translation message unreadable).

**Not yet seen against the real bot.** Every reply above came from
`beatCommandReply` rather than Telegram, so what has never been observed is the
command menu actually appearing, or `/addfeed` typed on a phone.

**Beats are rows now, and a story can sit on several — schema and pipeline
verified by running, 2026-07-29.** This is phase 1 of managing beats from
Telegram ([ADR-0019](docs/decisions/0019-beats-as-reader-owned-data.md)).
`CATEGORIES` is gone; `beats` and `beat_feeds` replace it, `items` is `articles`,
and the per-beat verdict lives in `article_beats`. `curateCategory` became
`curateAll`: `ingest → foreach(rankBeat) → assignBest → foreach(deliverBeat)`,
three schedules instead of six, with an optional `beats` filter so a single beat
can still be run from Studio.

**Nothing conversational has changed yet.** Newy can *read* beats — the tools take
a beat slug and her prompt renders the live list — but there is no `create-beat`,
no discovery workflow, and no per-beat tab. Those are phases 2–4. What phase 1
bought is that none of them now need a restart to take effect.

Verified against the live database by running the functions each step calls
(a workflow still cannot be driven from a script): migrations applied with
`memories`, `telegram_topics` and every `mastra_*` table untouched; `seedBeats()`
wrote 2 beats and 16 feeds from empty and returned 0 on a second call; 16 feeds
fetched, 399 unique articles inserted and 399 links written, with a re-link
returning **0**, which is the idempotence that stops a still-served story being
re-scored; `articles_fts` at 399 against `articles` at 399 with a clean
`integrity-check`; search working through the new index including the
`fine-tune` punctuation case and the beat-scoped `EXISTS` filter; `read-article`
returning a body and its verdicts, and null for an unknown id.

Arbitration was checked with a story deliberately scored 70 on one beat and 90 on
the other: it went to the **90**, the second story went the other way, both
verdicts stayed readable, and after `markDelivered` it was a candidate on **zero**
beats. A feed-pinned subtopic still beats the ranker's guess — an article ranked
`ai-models` came back `frameworks` because GitHub Changelog pins it.

**Schedules reconciled themselves, which was the open question.** `mastra_schedules`
holds exactly 5 rows — `wf_curate-all__digest-0800/1300/1900`, `wf_prune-articles`,
`wf_review-memories`. The six old `curate-category` rows and `wf_prune-items` are
**gone**: Mastra deletes the rows of a workflow that no longer exists, so a renamed
workflow does not leave a schedule firing into nothing. Worth knowing before
renaming another one.

**Not yet seen: a real scheduled fire, or anything in Telegram.** Every number
above comes from calling the steps' functions directly. What has never run is
`curateAll` itself — the `foreach` fan-out, the state carried across it, and
delivery. The `dev` server has booted this code (it is what seeded the beats), so
the next 19:00 fire is the first real test.

**`/summarize [language]` — verified against the live model, and the command path
confirmed on the real bot — 2026-07-29.** A real swipe followed by
`/summarize ru` came back in Russian from the phone. That run predates the prompt
fixes recorded below, so what has been seen end to end is the *path*, not the
current prompt. Swipe an article, send the command, and it comes back as one
message in **Chat**: several paragraphs plus bullets where the article really is
a list of specifics. `/summarize` alone writes English; `/summarize fr`,
`/summarize ru`, `/summarize français` write that language
([ADR-0018](docs/decisions/0018-summarize-command.md)).

**The argument means the opposite of what it means to `/translate`.** There, text
after the command *is the text to translate*; here it is the target language and
the text comes from the swipe. That is why this is its own config
(`src/config/summary.ts`), its own handler, and not a third entry in
`TRANSLATIONS`. Anyone tempted to unify the two argument parsers should read
ADR-0018 first.

Three things are deliberately unlike the translator, all in ADR-0018: **one call
with no chunking** (a summary of part 3 is not a summary), **no
degenerate-result retry** (the translator's exists against a measured 1-in-7
failure; nothing equivalent has been observed here, and inventing one would
double the wait), and **no read of `memories`** (the language is typed, not
remembered — so this command touches only `items`).

Verified against the live database and the live model, eight runs over one real
7998-character article: `/summarize` → English, `ru` → Russian, `fr` → French,
and the deliberately mistyped `protuguese` → **Portuguese**, which the model
corrected rather than falling back on. 296–465 words, 6–8 blocks, **5.4s to
11.8s** — nothing like the translator's 9s–283s, which is why there is no
partial-output machinery here. `items` was 293 before and 293 after, which is the
check that nothing was written. Offline, the language guard was checked against
12 accepted and 8 rejected arguments, and `renderSummary` parsed to
`heading, paragraph, paragraph, list, paragraph, paragraph` through the real
`formatConverter` with the link intact and an asterisk in the title escaped.

Two prompt defects were found by those runs and one is only mostly fixed — see
the two new gotchas above about multilingual rules and backticked proper nouns.

**The unknown-language path has never been observed.** `protuguese` was meant to
trigger the "write in English and report English" fallback and instead got
corrected, so the branch that handles a token naming no language at all is
written and untested. The reader would see a summary footed `English`; nothing
worse can happen, since the argument is shape-checked before it reaches the
model.

**Working and verified:** ingest with conditional GET, global dedupe, clustering,
ranking, per-article summarization, seven registered schedules (2 categories ×
08:00 / 13:00 / 19:00 Europe/Paris, plus a 04:00 prune), and Telegram delivery.
Verified by a real scheduled fire on 2026-07-27: both 19:00 schedules fired, 272
items ingested, 257 with article bodies, 8 articles delivered, no errors.

**Delivery is one message per article, not a grouped digest.** Telegram parses
`rich_message.markdown` server-side into real blocks, so each message is a
heading (the linked title), a lede paragraph, an optional bullet list of
specifics, and an italic `source · subtopic` footer, with the feed image on top
when there is one.

The model returns **structured output only** — `{ lede, points[] }` — and the
layout is templated in `renderMessage()`. A summarizer asked to emit its own
markdown eventually emits a broken link, and the URL is the one part that must
be exactly right. Each article is marked delivered as it lands, so a failure
partway through a batch doesn't re-send what already arrived.

Verified against markdown by sending: `#`/`##` headings, `>` blockquote, `-`
list, `---` divider, fenced code (syntax-highlighted), `![](url)` photo, and
pipe tables all become native blocks. `adapter.formatConverter.toAst(text)`
inspects structure offline, but only a real send shows what *Telegram's* parser
does — the local converter is not authoritative.

**Tabs and the conversational surface — built, not yet verified end to end.**
Three Telegram topics (`src/config/topics.ts`): **Chat**, **News** and
**Translations**. Digests target News, translations target Translations; `Newy`
(`src/mastra/agents/newy.ts`) answers in Chat and owns the only inbound path — a
polling adapter on `channels.adapters`. She has five read-only tools over the
news tables. See [ADR-0009](docs/decisions/0009-telegram-topics-as-tabs.md).

**Provisioning verified 2026-07-28.** Threaded Mode is on for `@ava_404_bot`, and
`resolveTopics()` created both tabs against the live chat — Chat `#103658`, News
`#103659`. Calling it a second time returned the same two ids and created no
duplicates, which is the property `telegram_topics` exists to guarantee
(`createForumTopic` is not idempotent on Telegram's side).

**Two chat types reach tabs, and they use different flags.** A private chat needs
BotFather's Threaded Mode (`getMe.has_topics_enabled`); a supergroup needs Topics
in its own settings (`getChat.is_forum`). `topicRoute()` checks whichever applies
— an earlier version tested only the private flag and would have silently
disabled tabs in a group. `pnpm telegram:check` reports the route and the fix for
whichever chat type it finds.

**Newy answers in Chat — verified end to end 2026-07-28.** Real inbound messages
from the phone were answered in the Chat tab: four updates Telegram had queued
drained on boot and got replies, then live messages after them. The polling
adapter, the tab router and memory-on-one-thread all work against the real bot.

The failure that prompted checking: **she is silent whenever the process isn't
running**, and that looks exactly like a code regression. Telegram queues the
updates (`getWebhookInfo.pending_update_count` counts them) and the adapter
resets the webhook with `dropPendingUpdates: false`, so they are all answered
once it comes back — there is no other symptom. Check that the process is up
before reading any code.

**Still unverified:** that a digest actually lands in the News tab. Needs a real
scheduled fire, which has not happened since the tabs were provisioned.

**Still not wired:** the 👍/👎 loop. The inbound path now exists, so
`recentFeedback()` could finally be fed, but nothing handles a reaction yet and
it still always returns empty. `recordVote(item, vote)` takes the whole item now,
not an id — the caller has it in hand, since a reaction arrives on a message
built from it.

**The ranker reads Newy's notes about the reader — verified offline, 2026-07-28.**
`rank` now renders `memoriesForCuration()` beside the (still empty) vote profile,
so the reader steers their digest by telling Newy what they want
([ADR-0016](docs/decisions/0016-reader-notes-in-the-ranker.md)). This is what the
👍/👎 loop was going to be and isn't yet: a thumb can only teach the ranker about
a pattern it has already sent, a sentence can name a subject it never has.

The ranker's prompt splits the notes in two, and the split is measured rather
than assumed: a note stating what the reader wants is an instruction, applied
hard and only to what it names (**+80.0** on those items, `+5.3` on the rest,
against a 10-point noise floor); passive biography only breaks ties and mostly
moves nothing, which is intended. See the ±10 gotcha above before touching that
prompt — the first measurement of this change was a false positive.

**Not yet seen on a real fire.** Every run above was `agent.generate()` from a
script against a *copy* of the database with seeded notes (live `memories` was 2
rows before and after). What has never been observed is a scheduled run ranking
against notes Newy wrote herself, and the live table has nothing in it yet that
expresses a preference — "Franck has brown eyes" is exactly the background the
ranker is told to ignore. Telling Newy one thing you want more of, in the Chat
tab, is what makes the next 08:00 run the first real test.

**Newy has memory — verified end to end against the live model, 2026-07-28.** A
`memories` table (Drizzle, `0007`), two tiers, one row per fact, and the whole
thing injected into her instructions every turn
([ADR-0014](docs/decisions/0014-two-tier-memory-for-ava.md)). This is the "real
feedback system" the 👍/👎 loop was never going to be: 👍/👎 trains the *ranker's*
taste, this is what Newy knows about the *person*.

Three new tools, and they are the only ones on the conversational surface that
write — see the amended invariant 8. `remember` (one fact, tier chosen at write
time), `recall-memories` (reaches past the prompt caps and hands back the ids the
injected block deliberately omits), `forget-memory`.

`instructions` is now an async function returning two system messages: the static
prompt, then today's date and the notes. `src/mastra/agents/memory.ts` renders
the block; `src/config/memory.ts` holds the window and the caps.

Verified two ways. Against a **copy** of the live database (288 items, untouched
at 288 afterwards): a re-stated fact deduped through normalization rather than
adding a row, a 45-day-old short-term note dropped out of the block while
`recall-memories` still found it, `2025-01-15` and `2026-01-20` survived the
round trip with no day drift, oldest-first ordering held, and `forget-memory`
returned what it deleted. Then against the **live model**, one real turn:
*"Je m'appelle Franck, je vis à Nantes et je suis allergique aux arachides. Ce
midi j'ai mangé un curry"* produced four `remember` calls in that one turn,
tiered correctly (name/city/allergy `long`, curry `short` with today's date),
none of them announced in the reply — and she used the allergy immediately,
unprompted. Asked *"de quelle couleur sont mes cheveux ?"* against two dated,
contradicting notes she answered *"Blonds, depuis janvier 2026. Auparavant, vous
les aviez foncés."*

**Not yet seen against the real bot.** Every turn above went through
`agent.generate()` from a script with `TELEGRAM_BOT_TOKEN` deleted from the
environment first — that is deliberate and worth copying, since importing the
agent with a token present constructs a *second* polling adapter and it would
eat the live bot's updates (invariant 7). What a `remember` card looks like in
Telegram with `toolDisplay: 'cards'` was therefore never observed, and four
memory cards on a first message may well have been too much chatter — moot since
2026-08-03, when `toolDisplay` went to `'hidden'`. The calls still happen and
still write; only the cards are gone.

**The weekly review closes that loop — verified 2026-07-28.** `review-memories`
(`src/mastra/workflows/review-memories.ts`) is the eighth schedule: Monday 05:00,
between the 04:00 prune and the 08:00 digest. It hands every note to a
`memory-reviewer` agent, promotes what has turned out to be biography, and
deletes the expired rest ([ADR-0015](docs/decisions/0015-weekly-memory-review.md)).
That is the third model call on a schedule and the reason invariant 2 is now
worded around *classifier over a fixed row set* rather than a list of two steps.

Verified against a copy of the live database with a seeded fixture set: the new
job and the named sister were promoted, the meals, the film and the flaky test
were deleted, a duplicate of an existing lasting note was dropped, the
still-fresh short note was untouched, promotion kept the original `happenedOn`,
and every promoted note survived the sweep that ran immediately after it.
`listWorkflows()` returns `['curateCategory', 'pruneItems', 'reviewMemories']`
and its schedule reads `{ cron: '0 5 * * 1', timezone: 'Europe/Paris' }`.

**Not yet seen on a real fire.** Nothing in the live database is old enough to
expire — the oldest note dates from today — so the first real run has nothing to
do until late August. Studio (**Workflows → reviewMemories**, input `{}`) is the
way to watch one; it cannot be driven from a script, see the evented-engine
gotcha. What has never been observed is a run over notes Newy wrote *herself*
rather than fixtures written to test her.

**Search rebuilt on FTS5, and the reply streams — 2026-07-28.** Both came out of
one real conversation that went wrong: the reader asked about *"the 500$ rl fine
tune"*, watched an empty chat for ~30 seconds, and got told Newy didn't know which
model they meant — about an article she had delivered to them that morning.

Two independent causes, both since fixed and verified:

- **Search couldn't tokenize.** One `LIKE '%<whole phrase>%'`, so `fine tune`
  missed `fine-tune`. Replaying the turn, all four of the model's searches
  returned nothing. Now `items_fts` with porter stemming and bm25
  ([0011](docs/decisions/0011-fts5-for-article-search.md)) — all four return the
  right article ranked first, and the same question answers correctly in 8.4s.
  288 existing rows were backfilled by the migration's `'rebuild'`; triggers
  verified for insert, text update, non-text update and delete against a copy of
  the live database before it was applied for real.
- **Nothing streamed.** ~25s of silence with a typing indicator that expires
  after 5. `streaming: true` on the adapter entry, plus `toolDisplay: 'cards'`
  kept on deliberately — seeing `searchNews` return `{"articles": []}` in the
  chat is how the search bug was noticed at all. **Turned to `'hidden'`
  2026-08-03**, the tools having settled: it hides the display, not the call, so
  turning it back to `'cards'` for a session is the way to debug a reply that
  looks like it used the wrong tool.

**Verified end to end for search, offline only for streaming.** The FTS5 work was
checked against the live database and through a real agent turn. `streaming:
true` typechecks and the draft path was read in the compiled adapter, but it has
not yet been watched on a phone — that needs a real inbound message.

**Newy is on vous, and the streaming report was a red herring — 2026-07-28.** A
real session came back reading like a chat between mates: `T'as d'autres
questions !`, a reply that was nothing but `✨`, and `Tu veux que je te dise quoi
en plus ?`. The prompt's only tone rules were "skip the flattery" and "short by
default", and short is what the model optimised.

`instructions` now carries a **Tone** block: answer in the reader's language and
use its formal register — `vous` in French, never `tu` — full sentences rather
than telegraphic fragments, at most one emoji and never an emoji alone, and no
throwaway closing question. Verified by replaying the three turns from that
session against the live model: `Avec plaisir. Bon courage pour la suite.`,
`Très bien, bonne soirée.`, and a full paragraph self-description on `vous`. The
first draft of the block still answered `Non c'est bon` with `Pas de souci,
autre chose ?`, which is why the closer rule names the done-signal explicitly.

The truncated first message in the same session looked like the streaming work
regressing. It wasn't — see the `</think>` gotcha above. Streaming itself is
still only verified offline.

**Newy is scoped to the Chat tab — 2026-07-28.** `src/mastra/channels.ts` swaps
the inbound thread for the Chat tab's before the default handler runs, on all
three inbound events, so a message typed in News is *answered in Chat* rather
than in place. One thread id means one conversation memory.

The same file fixes the reason `/start` appeared to do nothing: the adapter
diverts every `/command` away from the message path, and an unregistered command
is dropped silently. A catch-all handler now provisions the tabs and answers in
Chat — a config-built welcome for `/start`, one line for anything else.

Verified offline: the welcome renders as seven blocks through
`formatConverter.toAst()` with no run-on lines; the graph boots with Telegram
unconfigured (no adapter, no polling); and against the live chat the router's
decision table is flat → moved, Chat → in place, News → moved, other chat →
untouched, with the tabs resolving to two distinct `telegram:<chat>:<thread>` ids.
Since verified with real inbound messages too — see *Where work stopped*.

**Tab names carry an emoji, and a rename reconciles — 2026-07-28.** `emoji` is a
separate field from `title` in `src/config/topics.ts` because the two have
different audiences: `topicTabName()` joins them for Telegram, while `title`
alone is what Newy's instructions and the welcome interpolate (`the "💬 Chat" tab`
reads badly in a prompt). `resolveTopics()` now pushes a changed name with
`editForumTopic` and records what it sent in `telegram_topics.name` — there is no
`getForumTopic` to read a name back with, so remembering it is the only way to
know whether config has drifted from the live tab. Verified by renaming both live
tabs in place: same ids, no duplicates, no lost messages.

**Search can reach the article body, and the database now has a ceiling —
2026-07-28.** Two changes, both verified by running.

`read-article` is a fifth tool: full stored text for one item, keyed by the `id`
every list tool now returns. `search-news` still returns excerpts and still
matches on bodies — the split is the point, see the gotcha above. Verified
against the live database: a stored body came back at 7998 chars against a
396-char excerpt, an Android Developers item with no `content` fetched 7999 chars
live, an unknown id returned null, and the `content is not null` count was
unchanged at 273 afterwards, which is the check that nothing was written back.

`prune-items` is a seventh schedule, daily at 04:00, deleting items older than
`pipeline.retentionDays` (30) — and **only** items
([0012](docs/decisions/0012-thirty-day-retention-on-items.md)). Verified against
a *copy* of the live database with 60 rows aged past the cutoff and
`pruneBatchSize` forced to 7 so the loop ran nine times: 288 → 228 items,
`items_fts` 288 → 228 in step, `integrity-check` clean, zero index rows left
pointing at nothing.

**Votes are kept forever, and that is why `feedback` denormalizes.** The first
version of retention swept votes whose article had been pruned, on the reasoning
that they were unreadable anyway. True, and the wrong conclusion: they were
unreadable because `recentFeedback` joined `items` for the title, so a 30-day
retention silently gave the reader's taste a 30-day memory. `feedback` now stores
`title` and `source` on the vote — the whole of what `renderInterestProfile`
emits — nothing joins `items`, and no vote is ever deleted. Keeping the rows
*without* denormalizing would have looked like a fix and changed nothing.

The table can grow without bound and that is fine: it grows only when a human
presses a button (~100 bytes), while items arrive by the hundred daily on their
own. `feedbackWindow` (40) still caps what reaches the prompt.

Verified end to end against a copy: a vote cast under the old schema was
backfilled by the migration, a vote cast through `recordVote` on an article that
was then pruned still appeared in the profile the ranker sees, and `getItem`
returned null for that article at the same moment.

Registration is verified through Mastra itself: `listWorkflows()` returns
`['curateCategory', 'pruneItems']` and `pruneItems.getScheduleConfigs()` returns
`[{ cron: '0 4 * * *', timezone: 'Europe/Paris', inputData: {} }]`.

**Not yet seen in production:** no prune has fired on a real schedule. Nothing in
the live database is old enough to delete yet — the oldest item is from
2026-07-27, so the first real fire has nothing to do until late August. Studio
(**Workflows → pruneItems**, input `{}`) is the way to watch one; it reports
`{ cutoff, items, feedback }` and will legitimately report zeroes for a month. It
cannot be driven from a script — see the evented-engine gotcha above.

**`mastra_*` tables are not covered and must not be.** Mastra owns them
(invariant 4), and they are not spare capacity — they are what Studio and the
runtime read: `mastra_workflow_snapshot` is workflow run history *and* the state
a suspended run resumes from, `mastra_threads` / `mastra_messages` are Newy's
conversation memory. Deleting rows there is not a cleanup, it is deleting the
chat history and breaking resumability. They are small today (22 snapshots, 30
messages) but grow per run and per turn with nothing trimming them, so this will
look tempting later. If storage ever looks wrong after retention ships, measure
with `select name, sum(pgsize)/1024 kb from dbstat group by name order by kb desc`
before assuming the prune job is broken. Mastra ships its own retention
configuration (`reference-storage-retention` in the embedded docs); that is the
lever, not a `delete from mastra_*`. Traces are the exception and already handled
by construction — they live in `traces.db`, which is disposable as a whole file.

**A swiped reply now carries the article — offline only, 2026-07-28.** Replying
to a digest and asking "what is this about?" used to arrive as those five words
and nothing else. `withQuotedMessage` (`src/mastra/channels.ts`) prepends what
the reader pointed at, and when the quoted message carries a link to a stored
item, the note names that item's id so Newy calls `read-article` rather than
searching. **No table was needed and none was added** — the item id is a hash of
the canonical link and the digest carries that link in its heading, so the URL in
the quoted message *is* the primary key
([0013](docs/decisions/0013-swipe-to-reply-as-article-context.md)).

Verified offline against the live database and the real `stringifyMarkdown`: a
synthetic rich-message digest flattened to heading, lede, both points and footer
with the photo block's `file_id` left out, its link hashed to the id of the row
it came from, the note rendered as a blockquote followed by the `read-article`
line, the original message object came out unmutated, and a message that is not
a reply was passed through by identity. The topic-root and `forum_topic_created`
cases both returned undefined.

**Not yet seen against the real bot, and this is the part that matters.** Every
payload above was hand-built. Whether Telegram populates `reply_to_message` at
all for a reply inside a *private-chat* topic is exactly what has never been
observed here — the Bot API documents it, the adapter passes it through, and
neither of those is a run. One swipe on a real digest settles it.

**`/translearn` and `/translate` — verified offline, 2026-07-28.** Swipe an
article, send the command, and it comes back in the reader's own language with
the English original in parentheses: densely for `/translearn` (a study aid),
only on terms worth watching for `/translate`
([ADR-0017](docs/decisions/0017-translation-commands.md)). The two differ *only*
by the `gloss` string in `src/config/translation.ts`; a third density is an
entry there, not a handler.

A **third tab**, `📜 Translations`, is where the output lands — a translated
article is several messages and would bury the conversation in Chat. It is third
in `TOPICS`, which decides creation order and nothing else (see the tab-order
gotcha). **This tab has never been created against the live chat**: nothing here
has run with a token present, so `resolveTopics()` has not yet had a chance to
make it. The first `/start`, digest or command after deploy does that.

Verified against the live database and the live model: a synthetic slash-command
payload carrying a reply to a real digest resolved to the right stored row; the
body came back at 7995 chars via the fetch fallback; `items` was 293 before and
293 after, which is the check that nothing was written; the rendered message
parsed to `heading, paragraph, paragraph, paragraph` through the real
`formatConverter` with the heading only on part 1, the source footer only on the
last, and the `n/N` marker absent when there is one part. Against the live model,
both commands resolved **French** from Newy's own notes with no language
configured anywhere, and separated cleanly on density — **26.1 vs 2.0 glosses
per 100 words** on the same chunk.

**Not yet seen against the real bot, and that is the part that matters.** Every
payload was hand-built. What has never been observed is a real swipe on a real
digest followed by a real command, the tab being created, or what several
minutes of waiting actually feels like on a phone.

**Resolved — the ADR-0002 open question.** `postMessage` does *not* require an
initialized `ChatInstance`. Only the inbound paths (`handleWebhook`,
`startPolling`, and the `process*` handlers) guard on one; `postMessage` builds
its payload and calls the Bot API directly. Verified in the compiled adapter and
by sending. So the documented fallback to a second Telegram library is not
needed and ADR-0002 stands as written — `src/services/telegram.ts` is outbound
only, and the orchestrator will register its own adapter for inbound. Only that
one polls.

Two things learned while wiring it, both by sending rather than reading:

- The adapter has **no HTML parse mode** — only `MarkdownV2` or `plain` — which
  looks like it should break the digest writer's Telegram HTML. It doesn't. The
  format converter parses inline HTML as well as markdown and the adapter sends
  structured rich text via `sendRichMessage`, so `parse_mode` never applies.
  Pass `{ markdown: text }`; a bare string or `{ raw }` sends unformatted.
- The adapter **truncates** at Telegram's 4096-character cap rather than
  splitting, so a long digest loses its tail silently. `splitForTelegram()`
  chunks at `pipeline.telegramMaxMessageChars` before handing anything over.

## Recording decisions

Non-obvious choices go in [`docs/decisions/`](docs/decisions/README.md) as a new
numbered ADR, including the cost — an ADR with no downside listed is marketing.
**Never rewrite an accepted ADR**; supersede it, so the reversal and its reasoning
survive.
