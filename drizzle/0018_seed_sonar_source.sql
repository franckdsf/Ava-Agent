-- Adds the `sonar` job source to a database that already has the others.
--
-- Hand-written, like `0011_reset_feed_state.sql`, because this is a data change
-- and `db:generate` only emits schema diffs — `kind: 'sonar'` has been in the
-- enum since 0015, so there is nothing for drizzle to see here.
--
-- **Why a migration and not the seed.** `seedJobSources()` writes
-- `SEED_JOB_SOURCES` only when the table is *empty*, exactly as `seedBeats()`
-- does: a seed is applied once to an empty table and the table is the authority
-- ever after. Every deployment that has already booted therefore holds the nine
-- boards, and adding a tenth entry to that array reaches none of them. Without
-- this file the source ships, the code runs, and sonar is simply never fetched
-- anywhere it matters — a failure with no error, which is the shape this repo
-- keeps writing down.
--
-- Making the seed upsert instead was the alternative and is worse: it would
-- resurrect any source someone had archived, on every boot, forever.
--
-- `ON CONFLICT DO NOTHING` makes it a no-op on a fresh database, where the seed
-- has already written this row, and safe to re-run. The columns left out are all
-- nullable fetch state — the first run fills them in.
INSERT INTO `job_sources` (`id`, `kind`, `url`, `label`, `adapter`, `added_at`)
VALUES ('sonar', 'sonar', 'openrouter/perplexity/sonar', 'Sonar', NULL, 1785937800000)
ON CONFLICT (`id`) DO NOTHING;
