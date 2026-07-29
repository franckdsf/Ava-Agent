# ADR-0019: Beats are reader-owned data, and a story can sit on several

- **Status:** Accepted
- **Date:** 2026-07-29
- **Supersedes:** the storage half of [ADR-0008](0008-categories-as-configuration.md).
  Its *reasoning* stands and is the reason this was cheap — one parameterized
  curator, expertise as data. Only "the data is a git-reviewable array" changes.

## Context

The requirement is to manage beats entirely from Telegram: say "follow Rust" to
Ava, have her find the feeds and set the beat up. Three things in the code made
that impossible, and all three had the same shape — something derived from
`CATEGORIES` **at module load**:

- **Agents.** Two per category, built at import and registered on the Mastra
  instance. `mastra.getAgent('rust-ranker')` throws for a beat created at 3pm.
- **Schedules.** `categories × digestHours`, read off the workflow at boot. A new
  beat had no schedule until a redeploy.
- **Prompts and copy.** Ava's instructions and the `/start` welcome interpolated
  the list into strings fixed at import.

A fourth problem was latent and worse. `items.categorySlug` was a single column
and `items.id` is a hash of the canonical link, so **a story could only ever
belong to one beat** — whichever ingested it first. With two hand-picked beats
that never collided. With eight reader-chosen ones it is routine.

And it hid a real bug: `feed_state` is keyed by URL globally, so a feed two beats
both subscribed to gave the second one a **304 and zero articles**. Invisible
only because no two categories shared a feed.

## Decision

**Beats are rows.** `beats` and `beat_feeds` replace `CATEGORIES`.
`src/config/seed-beats.ts` still holds the two starter beats, but it is a *seed*
applied once to an empty table — editing it does not reach a beat that exists.

**A story is scored per beat and delivered once.** `items` becomes `articles`
(everything else in the codebase already said "article"), and the per-beat
verdict moves to `article_beats`: `score`, `subtopic`, `reason`, `rankedAt`,
`clusterId`. Delivery stays on the article, with a `deliveredBeat` pointer,
because a story goes out exactly once.

**One workflow, one fan-out per stage.** `curateCategory` (one run per beat,
scheduled per beat) becomes `curateAll` with three schedules and an optional
`beats` filter:

```
ingest → foreach(rankBeat) → assignBest → foreach(deliverBeat) → report
```

Ingest sits *above* the fan-out so each distinct URL is fetched once, which fixes
the 304 bug by construction. Arbitration sits *between* ranking and delivery
because no single beat's run can know it lost.

**One ranker and one article writer, with the rubric in the prompt.** ADR-0008
already put the feedback profile in the prompt "so it cannot go stale between
restarts"; a rubric the reader can edit mid-conversation needs the same
treatment. Mastra 1.52 supports `instructions: ({requestContext}) => …` and it is
deliberately *not* used — it buys nothing over the prompt and puts a database
read on a path with no way to report failure.

**`breakingThreshold` is deleted.** Nothing ever read it.

## Invariants this changes

**Invariant 3** — "categories are config, not code" becomes **a beat is a row,
not code**. The spirit is intact: adding a beat still touches no agent or
workflow code.

**Invariant 8** — "the conversational surface is read-only over the pipeline"
cannot survive Ava creating beats. Rather than adding to a list of exceptions,
the boundary is restated:

> Ava may write what the **next** run reads — `memories`, and now `beats` and
> `beat_feeds`. She may never write what a run **produces**: `articles`,
> `article_beats`, `feedback`, scores, `deliveredAt`. She may never touch a run
> in progress.

The `memories` carve-out stops being a special case and becomes an instance of
the rule. This ADR does not itself add any writing tool — phase 1 is the schema
and the pipeline — but it is the decision that makes those tools legal.

## Consequences

**Good**

- A beat can be created at runtime with no redeploy, no new agent, no new
  schedule row to reconcile.
- A story reaching two beats is scored by both and sent once, by the better fit.
- Every beat's `reason` is kept for articles it *didn't* send, so "why didn't you
  send me that?" is answerable. The ranker always wrote those; nothing could read
  them.
- One feed serving several beats costs one HTTP request.
- `articles` is now written once at ingest and once at delivery, which takes the
  per-run score writes off the FTS update trigger.

**Costs**

- **Every query about ranking is now a join.** `listUnranked`,
  `listRankedUndelivered` and the search filter all cross `article_beats`.
- **Arbitration is a global step**, so ranking cannot stream into delivery. A
  slow beat delays every beat's send, where before each ran independently.
- **Narrowing a run changes its result.** Only beats in the run compete, so
  `{ beats: ["design"] }` from Studio lets Design win stories it would lose on a
  full run. Correct for testing, misleading if read as a scheduled run.
- **The seed can drift from the live beats** with nothing reconciling them. That
  is the point, and it means the file is documentation of a starting state rather
  than of the system.
- **Studio shows one ranker**, not one per beat, so runs are told apart by their
  prompt rather than by the agent name.
- **A new beat subscribing to an already-polled feed sees nothing until that feed
  changes**, because `feed_state` answers 304. The fix belongs to beat creation —
  clear `feed_state` for the new subscriptions — and is not written yet.

**Revisit if:** a beat needs a different *pipeline* rather than a different
rubric, or if per-beat digest hours become worth having. The latter is the one
thing the old per-beat schedules could express and this cannot; it would mean
either a schedule per beat via `mastra.schedules` (available since core 1.50) or
an hour column consulted by an hourly run.
