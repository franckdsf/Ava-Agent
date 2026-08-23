---
applies_to: ["src/db/**", "drizzle/**", "drizzle.config.ts"]
---

# Database and migrations

Gotchas. The routing table is [README.md](README.md).

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
  ([0012](../decisions/0012-thirty-day-retention-on-items.md))

- **A seed does not reach a database that already has rows.** `seedJobSources()`
  (`src/db/jobs.ts`) and `seedBeats()` (`src/db/beats.ts`) both return early when
  their table is non-empty, so adding an entry to a seed array reaches **no
  existing deployment** — the row exists in the code and is never fetched
  anywhere real, with no error. A new source on a live database is a hand-written
  data migration (`drizzle/0018_seed_sonar_source.sql`, the
  `0011_reset_feed_state` pattern: no snapshot, hand-added journal entry)
  inserting `ON CONFLICT DO NOTHING`. **Making the seed upsert is the tempting
  fix and is worse** — it resurrects every archived source on every boot, forever.

- **A timestamp that encodes batch position rather than time is invisible until
  something reads it as time.** `jobs.discoveredAt` was stamped per posting at
  ingest, so a posting's millisecond was its source's position in a fetch batch —
  and `listUnscored`, ordering on it, meant Himalayas (alphabetically first,
  fetched first) never entered a scoring window at all. Two sources had never been
  scored in any run. `listUnscored` now orders on `coalesce(postedAt,
  discoveredAt)` with fetch order kept only as the tiebreak, and ingest stamps one
  `firstSeenAt` per run. **Check what stamps a column before ordering on it.**

- **A migration may be regenerated rather than amended — but only if nothing has
  applied it.** Deleting a migration's file, its snapshot and its journal entry
  and generating one clean replacement is correct when the row is absent from
  `__drizzle_migrations` everywhere it could have run, and is data loss otherwise.
  **Query `__drizzle_migrations` before doing it**; drizzle will not tell you.
