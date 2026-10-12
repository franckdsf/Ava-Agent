---
id: 0024
applies_to: ["src/mastra/workflows/find-jobs.ts", "src/mastra/agents/joob.ts", "src/bots/joob.ts", "src/config/jobs.ts"]
status: amended
supersedes: []
verify: "pnpm jobs:check"
---

# ADR-0024: Joob — a job pipeline beside the news one, sharing everything but the tables

- **Status:** Accepted
- **Date:** 2026-08-03
- **Depends on:** [ADR-0023](0023-a-bot-per-agent-two-tokens-two-chats.md) for the
  surface — Joob's own token, chat and tabs.

## Context

Joob finds job postings that would suit the reader and delivers them every two
days. Structurally it is the news pipeline with three organs replaced, and the
resemblance is close enough to be dangerous: the temptation is to make a job a
row in `articles` and a search a row in `beats`, which works right up until each
of the three differences bites.

**A job is not deduped by its link.** Invariant 5's whole mechanism is
`id = hash(canonical link)`, and the same posting appears on five boards under
five URLs. Link hashing does not merge them; it multiplies them.

**A job's freshness is not an article's.** A three-week-old listing is still worth
applying to — hiring takes time — while a three-week-old news story is dead. The
7-day ingest window that protects the news pipeline would throw away most of what
Joob should send.

**The rubric is the reader's CV, and it lives somewhere else.** A beat's rubric
is a stored string built by the namer. Joob's is a document the reader maintains
on their own portfolio, at `PORTFOLIO_FEED_URL`, behind a bearer token.

Everything *else* is genuinely shared and reusing it is the reason Joob is in this
repo at all: one database, one migration set, one container, one Mastra instance,
`memories` ([ADR-0022](0022-ava-is-the-system-agents-have-names.md)),
`AVA_MODEL_ORCHESTRATOR`, the chunker, `escapeMarkdown`, the lexical clusterer,
the conditional-GET discipline, and the whole scheduled-classifier shape that
[invariant 2](../../AGENTS.md#invariants) demands.

## Decision

**Jobs get their own tables and their own workflow. Everything below the tables
is shared.**

### Identity, and the month in the key

`jobs.id = hash(normalizedCompany + normalizedTitle + normalizedLocation + YYYY-MM)`.

The month is what makes a repost three months later a *new* job rather than a
silent collision — which is the behaviour the reader asked for, since a
re-advertised role usually means the first hire fell through. The month comes
from the **posting's own date**, falling back to first-seen only when a source
ships none; using `now()` would make one listing crawled either side of midnight
on the 31st into two jobs.

The lexical clusterer ([ADR-0007](0007-lexical-clustering-instead-of-embeddings.md))
runs as a second pass over the batch, for title variance the normalizer misses —
`Senior SWE` against `Sr. Software Engineer`.

### `job_deliveries` is permanent, and it is what actually prevents a re-send

One row per posting **actually delivered**: month-less identity, company, title,
URL, date, search. Never pruned. Same denormalization argument `feedback` makes
([schema.ts:246-260](../../src/db/schema.ts)) and affordable for the same reason —
it grows only when something reached the reader.

It exists because the ingest-window-below-retention rule *does not hold here*.
A source that ships no posting date makes age fall back to first-seen, so a job
pruned at 60 days and re-crawled the next day reads as zero days old, passes the
window, takes a fresh `YYYY-MM` in its key, and lands with a null `deliveredAt`.
No tuning of the two numbers prevents that. The ledger does, by construction.

`redeliveryGuardDays` **must exceed `retentionDays`**, or the hole reopens: 75
against 60.

### Windows

**30-day ingest window, 60-day retention.** The window is wide because listings
stay open; retention is double it so the classic trap
([ADR-0012](0012-thirty-day-retention-on-items.md)) cannot fire. They still may
not be tuned independently, and the ledger above is the belt to that braces.

A 30-day window means the **first run pulls a month of every source at once**, and
several boards serve their whole history. `maxJobsPerScoringRun` exists from day
one for that, mirroring `maxItemsPerRankingRun`.

### The CV is fetched per run, cached nowhere, distilled never

`PORTFOLIO_FEED_URL` returns `text/markdown` behind `PORTFOLIO_FEED_TOKEN` as a
bearer. It is read at the start of each run and put in the scoring prompt.

Both obvious elaborations were considered and dropped:

- **No stored copy.** A stale CV costs nothing — the next run is two days away —
  and a failed fetch costs nothing either, because unscored postings stay pending
  and the next run picks them all up, exactly as `listUnranked` already behaves.
  A cache would be a second source of truth for a document the reader edits
  elsewhere.
- **No distilled profile.** Its purpose would have been a cheap stable prompt,
  but the CV enters the batch prompt **once for the whole batch**, every two days.
  The deterministic filters read `job_searches` rows, not the CV, so nothing needs
  it structured.

Fetch guards, because a wrong endpoint never errors — the same failure class as a
wrong feed URL. Non-200, a content type that is not `text/markdown` or
`text/plain`, or a body under a floor length are each a **loud failure**: a short
message in Joob's Chat tab. Silence is indistinguishable from "no jobs matched",
and the reader would sit through a fortnight of it. The fetch carries an
`AbortSignal.timeout`; without one a hung request stalls the step indefinitely.

### The CV orders and advises; it never rejects

The CV has three jobs, and the line between them is the point.

1. **The scoring rubric** — the whole document, once per batch, as above.
2. **Ordering the batch.** The filter routinely keeps more postings than
   `maxJobsPerScoringRun`; something has to decide which ones the model actually
   sees. Recency alone filled that batch with whatever the boards published on
   Tuesday. `rankByCvOverlap` sorts by the Jaccard overlap between the CV's
   `tech:` tags and the posting's — shared over union, not a raw count of shared
   tags. A count rewards volume: an agency advert naming twenty technologies
   beats a focused one naming nine whatever the role is, which measured put
   Lemon.io's *Senior Graphic Designer* seventh. A plain proportion overcorrects,
   scoring an advert that names one known technology a perfect 1.0. Putting the
   CV in the denominator fixes both ends with no tuned constant. Recency still
   breaks ties, so a batch with no overlap behaves exactly as before.
3. **Advising on a loose target.** `constraintCount` counts the six fields that
   actually reject — `mustHave`, `dealbreakers`, `seniority`, `locations`,
   `contractTypes`, `minCompensation` — and deliberately ignores `remote`, which
   is set on nearly every target and only rejects on two of its four values.
   Below `minConstraints`, `/target` makes a second call that reads the CV and
   answers with a diagnosis plus a ready-to-paste `/target` line. It runs after
   the row is saved, so a portfolio that will not fetch costs the advice and
   never the search.

The proposal is **stored on the search row** rather than only sent. A slash
command answers through the transport and never enters the agent's memory, so
Joob could not see what `/target` had just proposed: asked to "apply your
example", it had no example and invented a generic one — which is the failure
mode every other rule here exists to prevent. The row is the one place both
halves read. Stored with it are the criteria the suggested line parses to,
produced by running it through **the same `parseTarget` the reader would hit by
pasting it**, so applying it conversationally and pasting it cannot diverge. Any
write to the search clears the suggestion, because advice about the previous
criteria is wrong about the new ones.

**And nothing else.** The CV may decide what is read first and may suggest a
better target; it may never decide what is thrown away. The asymmetry is the
argument: a posting that survives the filter but not the batch cap is scored on a
later run and costs days, while a posting wrongly *filtered* is gone and the
reader never learns it existed. This is also why the CV is kept out of the
targeter itself — there it would turn things the reader never said into hard
filters, and a founding-engineer role at a Rust shop would vanish because the CV
says React.

### Searches are rows, and they all share one tab

`job_searches` holds the deterministic criteria — location, seniority band,
contract type, comp floor, must-have and dealbreaker terms — written by `/target`
from a sentence and listed by `/targets`. Nothing is seeded from the CV, for the
reason above; a target contains only what the reader asked for.

**Deliberately not a tab per search**, which is where this stops mirroring
[ADR-0021](0021-a-tab-per-beat.md). Beats are different subjects; searches are
slices of one field, and a strip of eleven near-identical tabs is worse than one
good one. Every match lands in **💼 Jobs** with the search named in the footer,
the slot a beat's subtopic occupies today. Arbitration survives the change: a
posting matching two searches is scored on both and delivered once by the better
fit, with the loser's verdict kept so `/why` can answer.

### Filter, then score the batch, then write the winners

```
fetch CV → ingest → hard filters → score batch → assign → write + deliver
```

- **Hard filters are code, not a model.** Location, contract type, seniority
  keywords and dealbreakers are `job_searches` columns applied in SQL. The ranker
  is measured at **±10 points on identical input**; at ~40 postings a cycle a
  threshold cut at that noise level drops good jobs at random. Filtering first
  also keeps the model bill proportional to what survives.
- **One scoring call for the whole batch** — N postings in, N verdicts out, the
  shape `rankBeat` already uses. This is what puts the CV in the prompt once
  rather than forty times, and it is what keeps the step a classifier over a fixed
  row set, which is what [invariant 2](../../AGENTS.md#invariants) requires of
  anything on a schedule. Verdicts are validated against the ids sent, as the
  ranker already does.
- **One writing call per winner**, like the article writer. The message is a
  linked title, a fit summary, the mismatches as bullets, and a footer of
  company · location · search. `renderMessage`'s heading form
  (`## emoji [Title](link)`) makes the posting tappable for free.

A verdict is richer than an article's: overall fit, plus **named** mismatches —
seniority, location, stack, comp — so `/why` can answer with something better than
a number.

**`AVA_MODEL_JOB_SCORER`, `AVA_MODEL_JOB_WRITER` and `AVA_MODEL_JOB_TARGETER`,
defaulting to the same model ids as the RSS pair.** Not shared variables:
[env.ts:65-78](../../src/config/env.ts)
already settled that two callers with different cost profiles want to move
independently, and these differ by two orders of magnitude in volume and by fifty
times in prompt size. Sharing a default gives the sharing; sharing a variable
gives a surprise bill.

### Cadence: fire daily, gate on elapsed time

`0 8 */2 * *` is not "every two days" — it fires on the 1st, 3rd … 31st and then
the 1st, so seven month boundaries a year produce consecutive runs. The schedule
is **daily**, and the first step returns early unless `intervalHours` have
elapsed since the last completed run.

This also survives the thing that already bit this repo once: a missed schedule
fires on boot, and two runs were in flight at once
([AGENTS.md](../../AGENTS.md#where-work-stopped)). A stored `lastRunAt` makes the
cadence a property of the data rather than of process uptime. Run input carries a
`force` flag so Studio and a reader-triggered run are not blocked by the gate.

### Sources

`job_sources` mirrors `beat_feeds` with a `kind` discriminator:

- **`rss`** — WeWorkRemotely and friends, straight through `fetchFeeds`.
- **`api`** — Remotive, Arbeitnow, Himalayas. One normalizer each into the common
  posting shape.
- **`sonar`** — `perplexity/sonar` proposes **companies hiring**, and code resolves
  the careers page. Same discipline as the beat scout
  ([ADR-0020](0020-feed-discovery-from-a-subject.md)): never take a URL from the
  model, because a wrong one never errors.
- **`apify`** — the discriminator exists; no actor is wired. Metered and async
  (start a run, poll a dataset), so it needs a per-run cap in config before it is
  turned on. A scheduled job that spends money on a cadence nobody watches is the
  failure shape invariant 2 guards against, with a different bill.

LinkedIn and Indeed are **out of scope, deliberately.** Both killed their feeds
and block scrapers; a direct integration would be broken within weeks and its
failure would be silent.

### Memory, and the one thing kept out of it

Joob reads and writes `memories` with the same tools Newy has. It is the same
reader, and the shared table is the assumption ADR-0022 exists to protect.

**Search criteria stay out of `memories` and live in `job_searches`.** Not a
scoping exception — criteria are operands for a SQL filter, and a filter cannot
read *"he would rather not commute"*. It is the same split that already keeps
`beats` out of `memories`.

One consequence worth stating because it is invisible: notes reach the **news**
ranker ([ADR-0016](0016-reader-notes-in-the-ranker.md)), so a note Joob writes
about wanting Rust roles will nudge Newy's digests toward Rust. That is intended.

**Invariant 8 holds unchanged.** Joob may write `job_searches` and `memories` —
configuration, read by a *future* run. It may never write a fit score, a
`deliveredAt`, or a `job_deliveries` row, and nothing conversational may start the
job run.

## Consequences

**Good**

- The reader edits their CV on their own portfolio and the next run uses it. No
  command, no upload, no redeploy, no second copy to drift.
- One posting on five boards is one message; a genuine repost months later is a
  new one.
- Re-delivery is prevented by a permanent ledger rather than by a ratio between
  two tunables, so the windows can be retuned later without re-deriving the
  safety argument.
- Deterministic filters do the cheap work, so the model sees only plausible jobs
  and the ±10 noise floor cannot silently drop a good one below a threshold.
- Everything expensive is shared: one database, one container, one migration set,
  one memory, one orchestrator knob.

**Costs**

- **The dedupe key merges genuinely distinct roles.** Two different openings with
  the same title at the same company in the same city in the same month are one
  row, and the second is never seen. Real for large employers, and the price of
  merging across five boards.
- **`redeliveryGuardDays` bounds how soon a real repost can reach the reader** —
  75 days, and it has to exceed retention or the pruning hole reopens, so it
  cannot be tuned down without also tuning retention. Listed for completeness
  rather than as a real cost: a role re-advertised inside two months is one the
  reader saw and passed on, and surfacing it again is noise. The repost worth
  having is the long-gap one, which clears the guard comfortably.
- **Fit scoring inherits the ±10 noise floor**, and a fit judgement is worth more
  than a headline judgement. Any claim about a scoring-prompt change needs the
  same three-run discipline AGENTS.md already demands of the ranker.
- **The pipeline depends on an external host at runtime.** The portfolio being
  down skips a cycle. Chosen over a cache deliberately, but it is a dependency the
  news pipeline does not have.
- **The CV is in the batch prompt every run**, so the scoring call is large and
  grows with the document. `maxJobsPerScoringRun` bounds the postings, not the CV.
- **`sonar` can invent a company**, and unlike a bad feed URL — which resolves to
  nothing and is caught by `checkFeed()` — a careers page that 404s is only
  visible in a counter nobody reads.
- **Coverage is what the free boards carry.** Without LinkedIn and Indeed, whole
  segments of the market are invisible, and the reader cannot tell a quiet week
  from a blind spot.
- **A first run scores a month of history**, and the deliverable from it is a
  large, atypical batch that should not be read as a normal cycle.

**Revisit if:** the free boards prove too thin and `apify` has to be turned on —
that makes a scheduled run a metered one and deserves its own decision about
caps. Also revisit if searches ever want genuinely different *pipelines* rather
than different filters, which is when one tab stops being enough and
ADR-0021's per-beat tab becomes the right model after all.

---

## Amendments, 2026-08-23

Two things settled after this ADR was accepted, recorded here rather than in a new record because
both are this decision's own subject. **Nothing above is rewritten** — these are additions.

### The scorer is one slow call, and slowness is not the defect

Scoring is a single batch call for the whole run — the largest prompt in this repo, most of it the
reader's CV. It is slow, and **duration is not the risk**: the run is unattended, nothing waits on
it, and a slow scheduled job is simply a slow scheduled job. **Do not "fix" it by switching models
for speed.**

What *is* the risk is that it is **one call whose failure costs the whole batch** — which is why it
retries (`jobPipeline.modelAttempts`) and why a failure leaves postings **unscored** rather than
scored at zero.

*No latency figure is recorded here on purpose.* The measurement that produced this decision was
taken at `maxJobsPerScoringRun: 60` and `intervalHours: 44`; both have since changed (90 and 20).
A number that outlives its configuration is worse than no number, and the decision does not depend
on one — take a fresh reading off `job_runs` if you need it.

**Cost:** the run's most expensive request has no timeout budget anyone is defending, so a provider
degradation shows up as a run that never finishes rather than as an error, and the reader's only
symptom is a quiet day. It also locks the scorer out of any future latency-sensitive caller.

### The CV prioritises the scoring batch and may never filter it

When more postings survive the filter than can be scored, the batch used to be the *newest*.
`rankByCvOverlap` (`src/mastra/workflows/find-jobs.ts`) orders by how many of the reader's own
technologies a posting names, with recency as the tie-break — applied **before** the slice, never as
a rejection. Measured against the live table on a loose target: mean CV overlap in the scored batch
**0.57 → 2.80**, with 48 of 60 slots changing hands.

**The rule is the asymmetry:** a deprioritised posting costs days, a filtered one is invisible
forever. The same reasoning is why `/target` never feeds the CV to the parser.

**Cost:** the pipeline still pays for model calls on postings the CV plainly does not match, and the
ordering is a raw overlap count — so an agency advert naming twenty technologies outranks a real
match (Lemon.io's *Senior Graphic Designer* ranked sixth). Normalising by the posting's own tag
count would fix that and is unmeasured.
