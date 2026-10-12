# Commands

Every script in `package.json`, the obligation attached to it, and what its output proves. The
short list with purposes is in the [README](../README.md#useful-dev-commands); this file is the reference.

Each entry carries one line of three facts — **does it write · does it call a model · does it need
`.env`** — because those are what decide whether a command is safe to run right now. Where the
prose did not state a fact it was derived from `package.json` (`--env-file` vs
`--env-file-if-exists` vs neither) and from the script itself.

**Exactly one command here is not a dry run: [`pnpm workflow:run`](#pnpm-workflowrun-target).**
Everything else fetches, measures and prints. `workflow:run` spends money and sends to Telegram.

---

## The three that gate everything

### `pnpm verify`

**Required before** claiming any change works, and before every commit — the `pre-commit` and
`pre-merge-commit` hooks run it and refuse the commit if it fails.

**Writes nothing · calls no model · needs no `.env`** — offline and deterministic, unlike every
`*:check` below. Runs `pnpm typecheck`, then `pnpm verify:rules`, then `pnpm test`.

Its parts, each runnable alone:

| Command | Proves | Rule |
| --- | --- | --- |
| `pnpm typecheck` | `tsc --noEmit` over `src/` and `scripts/` | 🔬 |
| `pnpm verify:docs` | every doc link, anchor, backticked path, `pnpm` command and ADR `applies_to` resolves | C1 |
| `pnpm verify:cycles` | no runtime import cycle in `src/` or `scripts/` | C2 |
| `pnpm verify:paths` | no path in `src/` resolved against cwd | C3 |
| `pnpm verify:catch` | no empty catch, no new swallowed promise beyond `scripts/checks/c4-baseline.json` | C4 |
| `pnpm verify:rules` | C1–C4 together | |
| `pnpm test` | every `__tests__/**/*.test.ts` — offline; `pnpm test:watch` to iterate | 🧪 |

What each rule holds, and which rules nothing holds yet: [CONVENTIONS.md](CONVENTIONS.md).

### `pnpm db:generate`

**Required after** editing `src/db/schema.ts`.

**Writes a migration into `drizzle/` · calls no model · needs no `.env`** — `drizzle.config.ts`
falls back to `file:./.data/ava.db`, and `generate` only reads the schema file, so it works without
a live database.

**Required** after editing `src/db/schema.ts`, or the migration silently lags the code.

### `pnpm workflow:run <target>`

**Read `--help` before the first use.** This is the one command here that spends.

**The script speaks HTTP and nothing else — no database, no model, no `.env` of its own. The run it
starts does all three, for real.**

**The only script here that is not a dry run — read `--help` before the first use.** It starts a real scheduled workflow against a running `pnpm dev`: real feeds, real model calls, real Telegram messages, and for `jobs` the scoring call that is this system's single most expensive request. Every target's cost is printed before it fires. Three traps it exists to close, all documented in the [gotchas](GOTCHAS/mastra-workflows.md): the route takes the *registry key* while schedule rows take the workflow id; `initialState` is mandatory for `curateAll` alone; and **a 504 does not stop the run**, which is why the script supplies its own `runId` and polls rather than reading the response — re-firing is how two runs end up delivering at once. Exercise it with `news --beats <a slug that does not exist>`: `activeBeats` returns nothing, `ingest` returns early, and both notice guards are false, so it proves the whole path end to end while fetching nothing and sending nothing.

---

## The dry-run checks

Fifteen scripts, each written to prove one thing. None of them sends a message.

### `pnpm feeds:check`

**Required after** adding or changing a feed.

**Writes nothing · calls no model · needs `.env`**

Run after adding or changing a feed. It reads `beat_feeds`, so it needs `.env` now — it used to need nothing.

### `pnpm discovery:check "<subject>"`

**Required before** believing any change to the namer, the scout, or feed resolution.

**Writes nothing · calls models · needs `.env`**

Dry-runs `/follow` end to end — names the beat, searches, verifies every feed, renders the report — writing and sending nothing. Run before believing any change to the namer, the scout, or feed resolution.

### `pnpm review:check`

**Required after** touching `verdictForBeat` or `src/config/feed-review.ts`.

**Writes nothing · calls no model · needs `.env`** — the script imports no agent and constructs no
`Mastra`.

The guards themselves are cases in `src/mastra/workflows/__tests__/review-feeds.test.ts`, run by `pnpm verify` — a guard with no case there is a guard that silently stops applying, and the failure is a beat quietly losing good sources. This script is the half a test cannot be: the report as the reader sees it, and what a run *today* would archive from the live beats. Read the second list after a guard change — a verdict that moved on beats you know is the change showing up.

### `pnpm jobs:check`

**Required after** touching a job source, an adapter, `job-identity.ts`, `yieldOfSources`,
`minYieldRate` or `minYieldSample`.

**Writes nothing · calls no model · needs `.env`**

Run after touching a job source, an adapter, or `job-identity.ts`. Fetches every seeded board for real, prints per-source field coverage, and runs the identity function over everything so the cross-board dedupe is a measured number rather than an assumption. Writes nothing, calls no model. **Also required after touching `yieldOfSources`, `minYieldRate` or `minYieldSample`** — its YIELD block is the only preview of which sources the next run would archive, and that rule can switch off a *seeded* board the reader chose ([ADR-0035](decisions/0035-a-source-is-judged-on-what-it-yields.md)). Read it before believing a source is healthy: a board answering 200 with nothing relevant is the failure this repo has already shipped twice, and field coverage alone cannot see it.

### `pnpm sonar:check "<slug or free text>"`

**Required after** touching the job scout's prompt, careers-page resolution or `jobScout`.

**Writes nothing · calls a model · needs `.env`** — free text touches no database; a slug-shaped
argument opens one and applies migrations.

Run after touching the job scout's prompt, careers-page resolution or `jobScout`. Dry-runs the `sonar` source end to end — proposes companies, resolves and verifies every careers page, builds the rows ingest would store and runs the real filter over them — writing and sending nothing. **It calls a model, unlike `jobs:check`**, which is why it is a separate command. Read the FILTER block first: a lead survives only if its careers page carries the reader's must-haves in real text, so a low survival rate means the design is failing, not that the week is quiet. Run it **three times** — company sets vary run to run, and the ±10 discipline applies. Free text touches no database; a slug-shaped argument opens one and applies migrations.

### `pnpm leadscout:check "<profile slug or free text>"`

**Required after** touching the lead scout's prompt, `resolveProspect`, or `leadScout`'s bounds.

**Writes nothing · calls models · needs `.env`** — a slug-shaped argument opens the database and
applies migrations; free text is completely inert.

The lead-side twin of `sonar:check`, and it measures what
[ADR-0039](decisions/0039-a-lead-scout-with-its-own-budget.md) measures: **verified companies, not
proposed ones.** Proposed is a number the prompt sets — asking for eight gets eight — so counting
proposals measures nothing. What matters is how many clear the three gates (the site answers with
real text, it names the company, the announcement resolves) and which gate the rest die on, which
is why the drop list prints the reason beside every company. A free-text argument goes through the
**same parser `/client` uses** rather than a hand-built stand-in: the scout's prompt is built from
the parsed fields, so inventing them here would measure a profile the reader never made. Zero
proposals is a model failure or an empty search, not "no leads" — the script exits non-zero on it.

### `pnpm bench <task>`

**Required before** changing `AVA_MODEL_RSS_RANKER`, `AVA_MODEL_RSS_SUMMARIZER`, `AVA_MODEL_JOB_SCORER`, `AVA_MODEL_JOB_WRITER`, `AVA_MODEL_TRANSLATOR` or `AVA_MODEL_SUMMARIZER`.

**Writes fixtures and transcripts to `.data/bench/`, and no database rows (it applies pending migrations, as every read does) · calls models · needs `.env`**

Runs a field of models × reasoning efforts through the real function a workflow calls — the clone keeps the live agent's prompt and provider options and swaps only the model and the effort — against fixtures read once from the database and frozen under `.data/bench/fixtures/` (`--refresh` re-reads them; they carry the reader's notes, which is why they stay under `.data/`). The incumbent is always in the field at the effort production sends. Each entrant's runs are flagged by code, then ranked blind by a judge model per fixture; the table gives ok and clean runs, median latency, the cost OpenRouter reported, reasoning tokens, retries, the judge's rank and the task's own numbers. **A winner is named only when the judge agreed across fixtures** — otherwise the table says the task is inside its noise floor. Read the transcript under `.data/bench/runs/` before changing a knob. `--models a,b` narrows the field by substring, `--runs` and `--fixtures` override [src/config/bench.ts](../src/config/bench.ts). Tasks so far: `ranker`, `article-writer`, `job-scorer`, `job-writer`, `translator`, `summarizer`. **Read the `ok` column before the latency one** — a model that writes good prose in the wrong shape fails every call, and that has happened. For the two calls a reader waits on, `translator` and `summarizer`, a candidate can carry `sorts` so the same model is entered under several routings, and `worst` matters as much as `median`. Every entrant routes cheapest-first with `require_parameters`, as production routes — a model measured on a faster endpoint than it ships on is a latency nobody will see — and a row asked to reason that reports no reasoning tokens is called out under the table.

### `pnpm portfolio:check`

**Required before** believing anything about job scoring, and after any change to the portfolio
endpoint.

**Writes nothing · calls no model · needs `.env`**

Run before believing anything about job scoring, and after any change to the portfolio endpoint. It is the one input to that scoring living outside this repo, and a wrong endpoint **never errors** — a protection wall answers 200 with an HTML login page, an empty deploy answers 200 with nothing. Prints the size, the estimated per-run token cost, the headings and the first lines. Read-only.

### `pnpm catchup:check`

**Required after** touching `decideCatchup`, `src/config/catchup.ts`, `pipeline.digestHours`,
`jobPipeline.intervalHours`, or a pipeline in `src/mastra/pipelines.ts`.

**Writes nothing · calls no model · needs `.env`**

**Required** after touching `decideCatchup`, `src/config/catchup.ts`, `pipeline.digestHours`, `jobPipeline.intervalHours` or a pipeline in `src/mastra/pipelines.ts` — the cadences because the staleness bars are set against them. For a pipeline on the kit, `definePipeline` enforces that relationship at load ([ADR-0044](decisions/0044-a-pipeline-s-cadence-is-one-definition.md)); for news and jobs, nothing does yet. The boot catch-up runs once, unattended, on a path that is invisible when it decides right and expensive when it decides wrong. Every guard has its case in `src/mastra/__tests__/boot-catchup.test.ts`, run by `pnpm verify`; this script prints what a boot *right now* would do to every live pipeline, against the real tables and schedule rows. Read-only; fires nothing.

### `pnpm finder:check "<topic>" [--against <url>…]`

**Required before** adding a source to a beat that is meant to be timely.

**Writes nothing · calls no model · needs no `.env`** — no database either.

**Run before adding a source to a beat that is meant to be timely.** `feeds:check` reports health, and a late blog is perfectly healthy — measured 2026-08-06, all 20 subscribed feeds passed while `ai-model-releases` sat on a weekly newsletter and a feed with no dated entries in 45 days. This races candidates against each other and reports median hours behind the first publisher ([ADR-0031](decisions/0031-a-race-decides-which-sources-are-early.md)). **Always pass `--against` with the beat's existing feeds** — a lag is measured against other sources, not in the abstract, and a thin pool produces "too few" for everything. Read the *stories* line before the table: if the tokens are not recognisable releases, the filters have drifted and the ranking below them is noise that will still look plausible.

### `pnpm rssfinder:check "<subject or domain>"`

**Read the output with `--verify` or not at all.**

**Writes nothing · calls no model · needs no `.env`**

**Read the output with `--verify` or not at all.** It queries a third party's index, which answers with feed URLs directly — the one thing [the gotchas](GOTCHAS/search-and-discovery.md) say never to accept from a search, because a wrong feed URL never errors. Measured 2026-08-06 on `ai images models`: 7 feeds returned, **3 alive** — two 404s, a 403 and a page that isn't a feed. Nothing here writes, calls no model and needs no `.env`; `checkFeed()` remains the sole authority on whether a URL is a feed.

### `pnpm youtube:check [url]`

**Required first** whenever Newy says she cannot read a video, and after any `pnpm update`.

**Writes nothing · calls no model · needs no `.env`**

**Run first whenever Newy says she cannot read a video, and after any `pnpm update`.** It is the early-warning system for a dependency that scrapes another company: the caption route is behind anti-bot measures that move, and when they move the failure is total and silent — she simply starts refusing every video. Prints the parsed id for ten URL shapes (two of which *must* fail) and fetches five real transcripts covering each outcome: a 19-second clip, a 19m talk with manual captions, a 1h56m talk with auto captions, a music video that must come back `no-speech`, and a dead id that must come back `unavailable` rather than `no-captions`. Read-only, needs no `.env`, and **calls no model** — it stops at the transcript. Every video failing at once means the route is blocked, not that the videos changed; `pnpm update youtube-caption-extractor` is the first thing to try.

### `pnpm leads:check`

**Required after** touching identity, the filter, image extraction, or the message template.

**Writes nothing · calls no model · needs no `.env`** — `vitest run lead`: every test file whose
path names a lead, so `pnpm verify` runs the same cases on every commit. The name survives because
[ADR-0038](decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md) cites it as its `verify:`.

The leads pipeline's deterministic half, offline — no network, no model, no database. Every case in it is one [ADR-0038](decisions/0038-leads-a-prospecting-pipeline-in-joobs-chat.md) argues about, so a failure is a regression against a recorded decision rather than against a guess. **The platform-host cases are the ones to care about**: reducing `acme.myshopify.com` to its registrable domain merges every store on that platform into one lead, silently, and it already caught exactly that bug once (`slice(0, -1)` on an exact match returns a truthy `"myshopify.co"`). Run it after touching identity, the filter, image extraction, or the message template.

### `pnpm leads:yield`

**Required before** concluding the leads pipeline is quiet.

**Applies migrations, writes no rows · calls no model · needs `.env`**

How many leads the free source actually yields, against the **live** table — read-only, no model. Answers one question with a number: *is the `jobs` table a real lead source or a theoretical one?* Measured 2026-08-19: 2,229 postings in 21 days produced **39 companies, 37 of them from `sonar`** and two from ATS boards whose careers pages sit on the employer's own domain; every board source produced zero, because a board's posting URL carries the board's host. Run it before concluding the pipeline is quiet — a low number here is a sourcing fact, not a bug.

### `pnpm telegram:check [bot]`

**Required before** debugging a missing tab.

**Writes nothing · calls no model · needs `.env`**

Run before debugging a missing tab. Reports whether BotFather's Threaded Mode is on — the one prerequisite no code can set — plus any profile field the next boot would push. Read-only, safe against a running bot. Covers **every** bot with no argument, because Threaded Mode is per token and a check that silently skipped one would be worse than none; name a bot (`newy`) to narrow it.

---

## Not documented, and why

Five scripts carry no obligation. They are listed so the gap is deliberate rather than an omission.

| Command | What it is |
| --- | --- |
| `pnpm dev` | Mastra Studio. `workflow:run` needs it running; nothing else here does. |
| `pnpm build` | Bundles to `.mastra/output`. The Dockerfile runs it; `verify` is what a change is judged on. |
| `pnpm prepare` | Points git at `.githooks/` and copies `.agents/skills/` into `.claude/skills/`, where Claude Code reads them. pnpm runs it on every install; run it by hand after changing a skill in `.agents/`. |
| `pnpm start` | Runs the built bundle. Deployment only. |
| `pnpm db:studio` | Browses the database. Read what you like — no rule attaches to looking. |
