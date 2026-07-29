-- Retires the pre-beats schema: `items` (one story, one category) and the
-- `feedback` shape keyed to it. `0009` creates their replacements —
-- `articles` + `article_beats`, where one story can sit on several beats.
--
-- The four DROPs below are hand-added. drizzle-kit emitted only the two
-- DROP TABLEs, because `items_fts` is a virtual table it cannot express and has
-- never had in its snapshot (see 0005). They must run *first*: dropping `items`
-- while an external-content FTS5 index still points at it leaves `items_fts`
-- orphaned — queryable, permanently stale, and invisible to every later
-- migration. Adding statements drizzle doesn't track is safe here for the same
-- reason it was in 0005: they touch nothing in the snapshot, so `db:generate`
-- stays quiet afterwards. Check that after any hand-edit.
--
-- The triggers are dropped explicitly rather than left to `DROP TABLE items`.
-- SQLite does drop a table's own triggers with it, but these are named objects
-- that would outlive a half-applied migration, and an `items_fts_insert` still
-- present when `articles` arrives is a confusing failure a long way from here.
DROP TRIGGER IF EXISTS `items_fts_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `items_fts_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `items_fts_update`;--> statement-breakpoint
DROP TABLE IF EXISTS `items_fts`;--> statement-breakpoint
DROP TABLE `feedback`;--> statement-breakpoint
DROP TABLE `items`;
