# ADR-0012: Thirty-day retention on items, enforced by a scheduled prune

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Nothing ever deleted a row. Six digest schedules a day ingest every feed, and
`items` keeps everything they find — 288 rows in the first 18 hours of real
operation, 900 KB of a 1.5 MB database.

Almost all of that weight is text nobody reads twice. Measured over those 288
rows on 2026-07-28: `content` plus `excerpt` averaged 1754 bytes against 241 for
every other column combined, so the article bodies are ~88% of a row. They earn
that once, in the compose step, for the handful of items that clear the digest
threshold. 23 of 288 were ever delivered.

Left alone this grows without bound on a `ava-data` volume, or on a Turso plan
that bills by storage. It is also the one table that grows *linearly with time*
rather than with configuration — adding a category adds feeds, but adding days
adds rows forever.

The constraint that shapes the answer: **the id is the dedupe**
([invariant 5](../../AGENTS.md#invariants)). `insertDiscovered` ignores conflicts
on a hash of the canonical link, so deleting a row frees that story to be
ingested again — and a re-ingested row has a null `deliveredAt`, which means it
can be delivered again. Retention that is unaware of ingest re-sends old news.

## Decision

A seventh schedule, `prune-items`, fires daily at 04:00 in `AVA_TIMEZONE` and
deletes every item whose `discoveredAt` is older than `pipeline.retentionDays`
(30). No model is involved, in keeping with
[invariant 2](../../AGENTS.md#invariants).

**`items` is the only table pruned.** The other two candidates are deliberately
excluded, for opposite reasons:

- **`feedback` is kept forever.** A vote is the reader's own judgement, it is the
  only thing that makes a curator theirs rather than generic, and the table grows
  only when a human presses a button — ~100 bytes a press against the hundreds of
  items a day that arrive on their own. Retention exists to bound automatic
  growth; a vote is not automatic growth.

  This is why `feedback` now stores `title` and `source` itself instead of
  joining `items` for them. Those two fields are the entire signal the ranker
  consumes — `renderInterestProfile` emits `- title (source)` — so denormalizing
  them makes a vote self-contained. Without it, "keep the feedback rows" would
  have been an illusion: the rows would survive and every reader of them joins
  through `items`, so the profile would still have emptied out at 30 days, with
  no error and no empty result to make it noticeable.
- **`mastra_*` is not ours to touch** ([invariant 4](../../AGENTS.md#invariants)),
  and it is live state rather than spare capacity: `mastra_workflow_snapshot` is
  what a suspended run resumes from, `mastra_threads` / `mastra_messages` are the
  conversation itself. Trace data, the one genuinely disposable part, is already
  handled by construction — it lives in a separate `traces.db` that can be
  deleted whole.

Three things make the dedupe interaction safe rather than lucky:

- **Retention is 4× the ingest window.** `maxItemAgeDays` is 7, so a story old
  enough to prune is already old enough for ingest to reject on sight. The gap
  is the safety margin, and it is why these two numbers may never be tuned
  independently.
- **The predicate is `discoveredAt`, not `publishedAt`.** It is the non-null
  column, it measures the thing being reclaimed, and since an item cannot be
  published after it was discovered, `discoveredAt < cutoff` implies
  `publishedAt < cutoff` — so the ingest window definitely covers it.
- **Every item is dated.** All 288 rows carried a publication date, across all
  16 feeds. This matters because ingest deliberately *keeps* undated entries
  (`rss.ts`: "they just showed up, so treat them as current") — an undated entry
  that a feed serves forever is the one shape that could survive pruning and come
  back as new.

Deletion is batched at `pruneBatchSize` (500). Each row fires the `items_fts`
delete trigger, so one statement over thousands of rows holds a write lock the
digest schedules share a connection with.

Rejected: **tombstones** — keeping a 32-byte id per deleted story to preserve
dedupe independently of the ingest window. It is the more defensive design and
would cost ~2% of the space. It buys nothing while every feed is dated, and it
reintroduces unbounded growth in a second table to solve the first one.

Rejected: **stripping `content` and keeping the row**. Preserves dedupe for free
and keeps the title searchable forever, but recovers only ~88% of a row's bytes
instead of all of them, and leaves `recent-news` able to list articles it can say
nothing about.

## Consequences

**Good:** the database reaches a steady state instead of growing forever — at the
observed rate, roughly 4–5k items rather than an open-ended count. The FTS index
shrinks with it, since the delete trigger keeps it in step. Nothing that has ever
been *read* is lost: delivery happens within hours of discovery.

**Costs:**

- **History is gone at 30 days, permanently.** "What did you send me in June" has
  no answer in July. `recent-news` and `news-stats` had a 90-day ceiling that was
  already a fiction; both now cap at `retentionDays` and say so in their
  descriptions, and Ava's instructions tell her to distinguish "nothing kept from
  before then" from "never covered". A reader who wants a permanent archive needs
  a second store, not a bigger number here.
- **A vote and its article can now disagree.** `feedback` holds a copy of the
  title and source as they were when the reader judged the item, and nothing
  refreshes it — a corrected headline lives on in the profile in its original
  form. That is the intended reading (it records a judgement, not the article),
  but it does mean the two tables can drift, and `my-feedback` can name an
  article that no longer exists and cannot be linked to.
- **The interest profile is unbounded.** `feedbackWindow` caps what reaches the
  ranker's prompt at 40 votes, so cost is bounded, but the table itself is not.
  That is a deliberate asymmetry — human-rate growth is not the problem retention
  was created to solve.
- **Two numbers are now coupled.** Lowering `retentionDays` toward
  `maxItemAgeDays`, or raising `maxItemAgeDays` toward `retentionDays`, re-sends
  old news. Neither file can be read alone.
- **The file does not shrink.** SQLite reuses freed pages rather than returning
  them to the OS, so the database plateaus instead of dropping. `VACUUM` would
  reclaim it and is deliberately not run: it rewrites the whole database under a
  write lock, and it is not a safe assumption against a remote libSQL endpoint.
- **Deletion is unrecoverable.** There is no soft delete. The volume backup is
  the only undo.

**Migration note:** `0006` was hand-edited away from what drizzle-kit generated.
The generated `ALTER TABLE feedback ADD title text NOT NULL` applies only while
the table is empty — SQLite rejects a `NOT NULL` add with no default the moment
there is one row, and `feedback` is empty today only because the 👍/👎 loop was
never wired. It is replaced by a table recreate that backfills from `items`,
verified against both an empty and a populated copy. A failed migration would
take the whole app down, not just feedback: every repository function awaits
`migrate()`.

**Revisit if:** a feed starts shipping undated entries (the resurrection shape —
check with `select count(*) from items where published_at is null`); or the
reader asks a question about news older than a month more than once; or storage
turns out to be dominated by `mastra_*` tables instead, which this job does not
touch and must not — Mastra owns those
([invariant 4](../../AGENTS.md#invariants)).
