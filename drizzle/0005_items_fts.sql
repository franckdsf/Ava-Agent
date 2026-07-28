-- Full-text index over items, so search matches terms instead of one substring.
--
-- Hand-written: drizzle-kit cannot express a virtual table, so this migration is
-- the one piece of the app schema that does not come from src/db/schema.ts.
-- See docs/decisions/0011-fts5-for-article-search.md.
--
-- External-content (`content='items'`): the index stores no copy of the text, it
-- points back at items by rowid. That keeps items the single source of truth and
-- costs an extra lookup per hit, which is the right trade for a table this size.
--
-- `content` appears twice on purpose — bare it is the third indexed column,
-- `content=` is the external-content option. FTS5 treats an argument containing
-- `=` as an option and everything else as a column name.
CREATE VIRTUAL TABLE `items_fts` USING fts5(
  `title`,
  `excerpt`,
  `content`,
  content=`items`,
  content_rowid=`rowid`,
  tokenize='porter unicode61'
);
--> statement-breakpoint
-- An ignored conflict in insertDiscovered does not fire this, which is what we
-- want: no row inserted, no index entry.
CREATE TRIGGER `items_fts_insert` AFTER INSERT ON `items` BEGIN
  INSERT INTO `items_fts`(`rowid`, `title`, `excerpt`, `content`)
  VALUES (new.`rowid`, new.`title`, new.`excerpt`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_delete` AFTER DELETE ON `items` BEGIN
  INSERT INTO `items_fts`(`items_fts`, `rowid`, `title`, `excerpt`, `content`)
  VALUES ('delete', old.`rowid`, old.`title`, old.`excerpt`, old.`content`);
END;
--> statement-breakpoint
-- `UPDATE OF` is load-bearing. The pipeline writes score, rankedAt and
-- deliveredAt on every run; without the column list this trigger would reindex
-- every item on every rank and every delivery for text that never changed.
CREATE TRIGGER `items_fts_update` AFTER UPDATE OF `title`, `excerpt`, `content` ON `items` BEGIN
  INSERT INTO `items_fts`(`items_fts`, `rowid`, `title`, `excerpt`, `content`)
  VALUES ('delete', old.`rowid`, old.`title`, old.`excerpt`, old.`content`);
  INSERT INTO `items_fts`(`rowid`, `title`, `excerpt`, `content`)
  VALUES (new.`rowid`, new.`title`, new.`excerpt`, new.`content`);
END;
--> statement-breakpoint
-- Backfill. Every item already stored predates the index, and unlike ingest
-- there is no conditional-GET path that will bring them back — a 304 skips
-- re-ingest entirely, so nothing else would ever index them.
INSERT INTO `items_fts`(`items_fts`) VALUES ('rebuild');
