---
audited_at: f6c2b89
---

# 02 — Divergence: what the docs say against what the code does

> Frozen at `f6c2b89`. Every row was checked against the code, not inferred.

**Severity** — 🔴 **Breaking**: following the doc produces wrong code · 🟠 **Misleading**: the doc
describes something that does not exist · 🟡 **Stale**: wrong but harmless.

| # | Divergence | Severity |
| --- | --- | --- |
| D1 | ~160 citations of "invariant N" point at a numbered list AGENTS.md no longer carries | 🟠 |
| D2 | The Never table forbids hand-written SQL that the repo needs and has | 🟠 |
| D3 | AGENTS.md: jobs fire at `jobPipeline.runHour` (08:00) — it is `runHours: [8, 20]` | 🟡 |
| D4 | "Three digests a day" in four places, one of them a model prompt — it is two | 🟡 |
| D5 | "Scoring is one batch call for the whole run" — it is one per search | 🟡 |
| D6 | ADR-0024's frontmatter says `accepted`; the index says amended | 🟡 |
| D0 | 42 dead links, anchors and a lost procedure — **fixed in `f6c2b89`** | — |

---

## 🟠 D1 — The numbered invariants survive only in the code that cites them

AGENTS.md had a `## Invariants` section numbering nine rules. The router rewrite (`2b2813e`) replaced
it with an unnumbered `## Never` table of twenty rows. The citations stayed:

```
grep -rhoE "[Ii]nvariant [0-9]+" src scripts docs/decisions | wc -l    → ~160
```

`invariant 8` alone is cited 38 times, `invariant 2` 36 times — in `src/mastra/channels.ts`,
`commands/*`, `workflows/*`, `agents/joob.ts` and most ADRs. The only numbered copy left is the
summary inside `.claude/agents/invariant-reviewer.md`, which says to read them "under `## Invariants`
(or the `## Never` table)". A reader following `invariant 8` from a comment finds a twenty-row table
with no row 8, and has to guess which row it meant.

**Why it matters:** these are the repo's most important rules, and the pointers to them are the
most-repeated cross-reference in the codebase. **Fix:** number the invariants again in AGENTS.md —
nine, in their original order, each with its Never rows under it — so the citations resolve. Cheaper
and more truthful than rewriting 160 comments, and ADRs are frozen anyway.

## 🟠 D2 — "Never hand-write SQL outside `drizzle/0010_articles_fts.sql`"

Three migrations have no drizzle snapshot, so three are hand-written: `0010_articles_fts.sql`,
`0011_reset_feed_state.sql` (forgets stale etags), `0018_seed_sonar_source.sql` (seeds a row).
`0018`'s own header explains why: `db:generate` emits schema diffs only, so a **data** migration can
only be written by hand. Read literally, the rule forbids the next one — an agent following it either
refuses a correct migration or breaks the rule. **Fix:** the rule is about ownership, not authorship:
*hand-written migrations are for what drizzle cannot express — FTS5 and data changes — and say so in
their first line.* (`tools/news.ts` also issues raw `sql` against `articles_fts` at runtime; FTS5
`MATCH` has no drizzle builder, so that is the same exception, at query time.)

## 🟡 D3 — The jobs schedule

AGENTS.md, Current state: *"fires daily at `jobPipeline.runHour` (08:00)"*. `src/config/jobs.ts`:
`runHours: [8, 20]`, changed by `7762cf4` so a refused fire is not the day's only chance.

## 🟡 D4 — Two digests, described as three

`pipeline.digestHours` is `[10, 20]`. "Three" survives in `README.md:24` ("three times a day"),
`src/mastra/index.ts:126` ("three digests a day against a run every two" — the jobs half is stale
too), `src/config/feed-review.ts:9`, and **`src/mastra/agents/scout.ts:117`, inside the prompt** —
the model is told a feed is "worth polling three times a day". Harmless today; a prompt carrying a
stale fact is the kind of drift no check sees.

## 🟡 D5 — One scoring call per search, not per run

AGENTS.md: *"Scoring is one batch call for the whole run, not one call per posting."* `find-jobs` runs
`.foreach(scoreSearch)`, and each search makes its own call over at most `maxJobsPerScoringRun` (90)
postings — so the cap, despite its name, is per search. The point AGENTS.md makes (batch, not per
posting) holds; the unit is wrong.

## 🟡 D6 — ADR-0024's status

The index: *"Accepted (amended 2026-08-23)"*. The frontmatter: `status: accepted`. The frontmatter
is what the reviewer filters on, so it should read `amended`. Every other ADR agrees with the index.

## D0 — Already fixed

C1's first run, recorded so the audit holds the whole pattern: ~30 ADR links into the renamed
`AGENTS.md#invariants` heading (kept working with an explicit anchor — D1 is the real fix); a gotcha
sending readers to a README procedure the setup wizard deleted (restored into the gotcha); an
AGENTS.md header naming three nested `AGENTS.md` that never existed; `docs/COMMANDS.md` linking to
AGENTS.md sections that no longer exist.

---

## The pattern

Every divergence here is the same event: **the code changed and a sentence about it did not.** Two
rewrites of AGENTS.md and one config change left behind numbers, names and a rule that were true when
written. C1 now catches the pointer kind (D0). What it cannot catch is a sentence stating a number
(D3–D5) — which argues for docs that *point at* config (`jobPipeline.runHours`) rather than restate
its value.
