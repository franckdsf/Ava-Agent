---
id: 0043
applies_to: ["src/mastra/tools/**", "src/mastra/commands/**", "src/mastra/agents/newy.ts", "src/mastra/agents/joob.ts", "src/mastra/workflows/discover-feeds.ts", "src/db/schema.ts"]
status: amended
supersedes: []
verify: "pnpm typecheck"
---

# ADR-0043: What a conversation may write is decided by what reads it back

- **Status:** Accepted (amended 2026-10-13)
- **Date:** 2026-08-23
- **Records:** invariant 8, enforced since the first conversational tool shipped and never filed as a
  decision. Like [ADR-0042](0042-a-scheduled-model-call-has-a-shape-not-a-list.md), this is a
  transcription — but unlike it, **the revision history below is the load-bearing part** and must
  survive any future edit of this record.
- **Bears on:** [ADR-0014](0014-two-tier-memory-for-ava.md),
  [ADR-0016](0016-reader-notes-in-the-ranker.md),
  [ADR-0019](0019-beats-as-reader-owned-data.md),
  [ADR-0009](0009-telegram-topics-as-tabs.md) — each of which this rule governs and none of which
  states it.

## Context

An LLM sits on an inbound path. Whatever it is allowed to write, it will eventually write badly:
not through malice, and not often, but at a rate that is not zero over a year of messages. So the
question is not *can it be trusted* but *what is the blast radius*.

**This rule has been restated twice, and each restatement removed a list.** That history is the
reason it is now phrased the way it is, and deleting the history is how the list comes back:

1. **"Read-only over the pipeline"**, with `memories` as its one exception. This could not survive
   the reader creating beats by talking to Newy — a legitimate write that the rule had no room for.
2. **Configuration versus run output**, over an enumeration of three tables. `beat_revisions` broke
   it within a day of it being written, because a superseded rubric is neither configuration nor run
   output. The invariant at the time literally said *"a principle is better than a growing list"* and
   then gave a list.
3. **This one.** The criterion is no longer what a table *is*; it is **what reads the table back**.

## Decision

**Nothing conversational may ever write what a run produced.** What it may write is decided by
asking who reads the table back:

- **Input to a future run** — `memories`, `beats`, `beat_feeds`. One-way and asynchronous: a note, a
  new beat or a retuned rubric changes what the *next* scheduled run does, never the one in flight.
- **Read by no run at all** — `beat_revisions`. Write-only history, kept for a human, never fed back
  into anything. **This category is safe by construction rather than by discipline:** a table no run
  reads cannot reach a run in progress however carelessly it is written, which is a stronger
  guarantee than the first category has.
- **Never: anything a run produced** — `articles`, `article_beats`, `feedback`, any score, any
  `deliveredAt`. Nothing conversational may reach a run in progress, mark anything delivered, or
  write a verdict. *An agent that could re-send a digest would eventually re-send a digest.*

Two rules follow from the same reasoning:

**Both permitted categories are additive. A fact, a beat and a rubric are all superseded rather than
corrected.** `memories` never rewrites a fact ([ADR-0014](0014-two-tier-memory-for-ava.md)) and a
retune never discards the rubric it replaced — because the *change* is the half worth keeping, and
the ranker's ±10-point noise floor means a rubric that quietly made a beat worse is not visibly
worse for days. **A write from a conversation that destroys its own predecessor is the thing to
refuse, whatever table it lands in.**

**Starting a workflow is allowed, and only for the config side.** Finding feeds for a new beat takes
minutes, so it belongs in a background run rather than a turn. That run may write `beats` and
`beat_feeds` and report to Chat; it may not touch the news tables, and **nothing conversational may
start `curateAll`**. A reader-triggered run is governed by ADR-0042's own distinction — a person
typing, not a cron fire nobody watches.

An outbound GET is not a write: `read-article` may fetch a page the feed shipped no body for, and
must not store what it gets back.

## Cost

**The criterion requires knowing every reader of a table, which is not mechanically checkable.**
"What reads this back?" is answered by grep and judgement, and a reader added later silently
reclassifies the table. `beat_revisions` is the sharp case: it is safe *because* nothing reads it,
so the first feature that reads it moves it into category one and weakens the guarantee — with no
error, and no reason for whoever adds the reader to look at this file.

**It is harder to apply than the list it replaced.** A list answers in seconds. This asks a question
that can be got wrong, and the two previous phrasings were each wrong within days of being written.

**It permits more than "read-only" did**, deliberately. Newy can create a beat, retune a rubric and
write a memory — three real write paths into tables a scheduled run consumes. The one-way,
asynchronous boundary is what makes that acceptable, and it is a weaker guarantee than no writes at
all.

## Verify

No mechanical check. The enforcement is the reader-of-the-table question asked at review time, and
`.claude/agents/invariant-reviewer.md` carries it as a criterion. A tool that writes a table should
not merge without an answer to *what reads this back?*

---

## Amendments, 2026-10-13

**"Never `article_beats`" was wrong for one write, and the config side had been making it all
along.** `/addfeed` and the `discover-feeds` run `/follow` starts both call `linkToBeats`, linking
articles already stored from a newly subscribed feed to its beat. The backfill predates this ADR by
a month (2026-07-29) and was never named as an exception; it surfaced when the conversational
imports into `src/db/` were listed for a check.

It is kept, because without it a new subscription gets nothing for days: a feed another beat
already polls answers 304 on the next run, so its stored stories are never linked to the new beat
until the feed changes. And it passes this ADR's own test. An **unscored link** — no score, no
verdict, no `deliveredAt`, ignored when the link exists (`onConflictDoNothing`) — is *input to a
future run*: the ranker scores it like any link ingest writes. So the categories become:

- **Input to a future run** — `memories`, `beats`, `beat_feeds`, **and an unscored link in
  `article_beats`, written only by `linkToBeats`**.
- **Never** — `articles`, `feedback`, any score or verdict, any `deliveredAt`; and any other write to
  `article_beats` (`saveRankings`, `saveClusters`, a delivery claim).

"May not touch the news tables" for the `/follow` run reads the same way: it may link, nothing more.
**One-way, but not always asynchronous:** a link written while `curateAll` is ranking that beat can
be picked up by that run's ranking step — exactly as if ingest had written it, so nothing is scored,
sent or reset that would not have been.

The Verify line above is also overtaken: which `src/db/` functions a conversation may import is now
held by C11 (`pnpm verify:conversation`): each one is listed, every write beside the category above
that allows it, and a new one fails `pnpm verify` until it is added with that answer.
