---
id: 0036
applies_to: ["src/db/job-searches.ts", "src/services/job-filter.ts", "src/mastra/commands/targets.ts"]
status: accepted
supersedes: []
verify: "pnpm jobs:check"
---

# ADR-0036: A source may declare its field, and a search may be re-read

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

[ADR-0030](0030-domains-as-vocabularies-a-search-names-its-field.md) made the
taxonomy generic: every domain declares its own titles, and rejection is a set
intersection against the search's own `domain`. It was the right shape, and on
2026-08-17 a measurement of the live table showed it was doing **nothing at all**.

All three active searches held `domain = NULL`. The column was added by
`ALTER TABLE` after they were created, `filterJob` skips the rule when the search
names no domain, and so the saving the file's own header calls "the single biggest
saving on a general board" had never once fired. Two weeks of runs, 4,685
verdicts, and a generic mechanism sitting switched off behind a data gap.

That is the specific bug. The general one behind it is worse: **a parser that
gains a field cannot reach a row already written.** `/target` upserts on the slug
the *model* produces, so re-running it with new wording may or may not update the
existing row — when the model names the search differently the reader gets a
second row competing for the same postings while the old one keeps running with
the criteria they were trying to change. The only reliable fix was hand-editing
the database, which is how the fix gets skipped the second time.

Separately, the domain field only ever reached the *scoring* stage. A run with
nothing but chemistry searches still fetched five We Work Remotely programming
feeds and a software hiring thread in full, filtered every posting out, and paid
the requests. `filterJob` cannot un-spend an HTTP request.

## Decision

Two changes, one on each side of the gap.

### `job_sources.domain`

A source row may name the one field of work it carries. `activeJobSources()`
drops a row whose domain matches no active search.

**Null is the default and means "everything", not "unknown".** Jobicy and Remotive
publish accountants beside engineers, so they genuinely have no domain and must
keep being fetched whatever the reader wants. A value is a *claim of exclusivity*:
We Work Remotely's category feeds and Hacker News's hiring thread carry software
and nothing else, and will never serve a chemist.

Deliberately **not** set on `sonar` — it has no fixed catalogue, asks about
whatever each active search wants, and is therefore already per-domain; pinning it
to one would be a plain bug. Nor on discovered `ats` rows: an employer's own board
carries every function that employer hires for, which is exactly why
`atsMaxPostingsPerBoard` pulls sales roles off it.

**The skip is computed per run, never stored**, and that asymmetry is load-bearing.
Archived is permanent and is a judgement about the *source*. This is temporary and
is a judgement about the *fit between a source and today's searches* — a
software-only board is skipped while every search is chemistry and returns the
moment a software search does, with no row edited either way. Store it as an
archive instead and a reader who retargets back would need every board
un-archived by hand, and `archivedAt` would stop meaning "this source is bad" —
which is the thing [ADR-0035](0035-a-source-is-judged-on-what-it-yields.md) and
`decayAtsBoards` both rely on it meaning.

This is a *second* stage, not a replacement for `filterJob`. The filter stops a
posting reaching a model; this stops a board being called at all. Neither
substitutes for the other, and being wrong here is the expensive direction: a
wrongly-domained source stops being fetched, raises no error, and its postings
simply never exist. `filterJob` is the safe place to be wrong, because a rejection
there is recorded with a reason.

### `/retarget <slug> [new wording]`

Re-parses one existing search **in place**, keeping its slug, its `createdAt` and
its history.

The slug is taken from the reader and the parse's own slug is discarded — that is
the entire difference from `/target`, and it is what makes "change this search"
incapable of becoming "add another one".

With no new wording it re-runs today's parser over the request already stored.
That is the backfill case, and the reason the argument is optional: a search
written before the parser gained a field acquires that field by being re-read,
without the reader having to re-invent a sentence they already said.

It follows the discipline `retune-beat` established under
[invariant 8](../../AGENTS.md#invariants) — configuration a *future* run reads,
never anything a run produced — and it echoes a before-and-after diff for the
reason `/target` echoes its parse: these are deterministic filters, a model wrote
them, and a wrong `mustHave` throws postings away before anything reads them.
`fitThreshold` is preserved rather than re-read, because a threshold the reader
tuned by hand is not something a re-parse of their *wording* knows about.

## Consequences

Backfilling `domain = 'software'` onto the three live searches was measured before
it was applied: **it keeps all 112 postings that have ever scored ≥60** and
removes 16.3% of every scoring slot ever spent. The vocabulary gaps found in the
same pass — no marketing, no business operations, `help desk` without `helpdesk`
— took untagged postings from 50.7% to 43.4% of the corpus with the same zero
regressions.

`/retarget` restarts every source's yield window, by
[ADR-0035](0035-a-source-is-judged-on-what-it-yields.md)'s reset rule. Stated in
the command's own reply, because a reader who re-reads a search and then watches
a source they expected to be archived survive another fortnight would otherwise
have no way to connect the two.

The two changes are one ADR because neither is sufficient alone. A `domain` column
on sources is worth nothing while the searches that would drive it hold null, and
a command to fix those searches is worth less if the field it fills only reaches
the scoring stage.
